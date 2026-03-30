import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  getReasoningEffortForModel,
  isMessagesApiEnabled,
} from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import {
  observeRequestComplete,
  observeRequestError,
  observeRequestStart,
  observeStreamFirstChunk,
} from "~/lib/observability/capture"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { SubagentMarker } from "./subagent-marker"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  let captureState = observeRequestStart(c, {
    requestId: "pending",
    routeType: "messages",
    model: anthropicPayload.model,
    stream: Boolean(anthropicPayload.stream),
    requestBody: anthropicPayload,
  })
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    logger.debug("Detected Subagent marker:", JSON.stringify(subagentMarker))
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)
  captureState = {
    ...captureState,
    requestId,
    sessionId,
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  try {
    if (shouldUseMessagesApi(selectedModel)) {
      return await handleWithMessagesApi(c, anthropicPayload, {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        isCompact,
        captureState,
      })
    }

    if (shouldUseResponsesApi(selectedModel)) {
      return await handleWithResponsesApi(c, anthropicPayload, {
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        isCompact,
        captureState,
      })
    }

    return await handleWithChatCompletions(c, anthropicPayload, {
      subagentMarker,
      requestId,
      sessionId,
      isCompact,
      captureState,
    })
  } catch (error) {
    observeRequestError(captureState, error)
    throw error
  }
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const completeCapture = (
  captureState: ReturnType<typeof observeRequestStart>,
  responseBody?: unknown,
) => {
  observeRequestComplete(captureState, {
    statusCode: 200,
    responseBody,
  })
}

const streamResponsesAsAnthropic = (
  c: Context,
  response: AsyncIterable<{ event?: string; data?: string }>,
  captureState: ReturnType<typeof observeRequestStart>,
) =>
  streamSSE(c, async (stream) => {
    const streamState = createResponsesStreamState()

    for await (const chunk of response) {
      observeStreamFirstChunk(captureState)
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      const data = chunk.data
      if (!data) {
        continue
      }

      logger.debug("Responses raw stream event:", data)

      const events = translateResponsesStreamEvent(
        JSON.parse(data) as ResponseStreamEvent,
        streamState,
      )
      for (const event of events) {
        const eventData = JSON.stringify(event)
        logger.debug("Translated Anthropic event:", eventData)
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        break
      }
    }

    if (!streamState.messageCompleted) {
      logger.warn(
        "Responses stream ended without completion; sending error event",
      )
      const errorEvent = buildErrorEvent(
        "Responses stream ended without completion",
      )
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }

    completeCapture(captureState)
  })

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    subagentMarker?: SubagentMarker | null
    requestId: string
    sessionId?: string
    isCompact?: boolean
    captureState: ReturnType<typeof observeRequestStart>
  },
) => {
  const { subagentMarker, requestId, sessionId, isCompact, captureState } =
    options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (isNonStreaming(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )
    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    completeCapture(captureState, anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    for await (const rawEvent of response) {
      observeStreamFirstChunk(captureState)
      logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        logger.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    completeCapture(captureState)
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    subagentMarker?: SubagentMarker | null
    selectedModel?: Model
    requestId: string
    sessionId?: string
    isCompact?: boolean
    captureState: ReturnType<typeof observeRequestStart>
  },
) => {
  const {
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    isCompact,
    captureState,
  } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  compactInputByLatestCompaction(responsesPayload)

  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiator,
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamResponsesAsAnthropic(c, response, captureState)
  }

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  completeCapture(captureState, anthropicResponse)
  return c.json(anthropicResponse)
}

const prepareMessagesPayload = (
  anthropicPayload: AnthropicMessagesPayload,
  selectedModel: Model | undefined,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }

  const toolChoice = anthropicPayload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    anthropicPayload.thinking = {
      type: "adaptive",
    }
    anthropicPayload.output_config = {
      effort: getAnthropicEffortForModel(anthropicPayload.model),
    }
  }
}

const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    anthropicBetaHeader?: string
    subagentMarker?: SubagentMarker | null
    selectedModel?: Model
    requestId: string
    sessionId?: string
    isCompact?: boolean
    captureState: ReturnType<typeof observeRequestStart>
  },
) => {
  const {
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    isCompact,
    captureState,
  } = options
  prepareMessagesPayload(anthropicPayload, selectedModel)

  logger.debug("Translated Messages payload:", JSON.stringify(anthropicPayload))

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      for await (const event of response) {
        observeStreamFirstChunk(captureState)
        const eventName = event.event
        const data = event.data ?? ""
        logger.debug("Messages raw stream event:", data)
        await stream.writeSSE({
          event: eventName,
          data,
        })
      }

      completeCapture(captureState)
    })
  }

  logger.debug(
    "Non-streaming Messages result:",
    JSON.stringify(response).slice(-400),
  )
  completeCapture(captureState, response)
  return c.json(response)
}

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  // equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // lengths differ -> append all textBlocks to the last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}
