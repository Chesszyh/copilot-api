import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getConfig, isResponsesApiWebSearchEnabled } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import {
  observeRequestComplete,
  observeRequestError,
  observeRequestStart,
  observeStreamFirstChunk,
} from "~/lib/observability/capture"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

const completeResponsesCapture = (
  captureState: ReturnType<typeof observeRequestStart>,
  responseBody?: unknown,
  usage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    cachedTokens?: number | null
    reasoningTokens?: number | null
  },
) => {
  observeRequestComplete(captureState, {
    statusCode: 200,
    responseBody,
    usage,
  })
}

const prepareResponsesPayload = (payload: ResponsesPayload) => {
  useFunctionApplyPatch(payload)

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  return { selectedModel, supportsResponses }
}

const streamNativeResponses = (
  c: Context,
  response: AsyncIterable<object>,
  captureState: ReturnType<typeof observeRequestStart>,
) =>
  streamSSE(c, async (stream) => {
    const idTracker = createStreamIdTracker()
    let sawChunk = false

    for await (const chunk of response) {
      if (!sawChunk) {
        observeStreamFirstChunk(captureState)
        sawChunk = true
      }
      logger.debug("Responses stream chunk:", JSON.stringify(chunk))

      const processedData = fixStreamIds(
        (chunk as { data?: string }).data ?? "",
        (chunk as { event?: string }).event,
        idTracker,
      )

      await stream.writeSSE({
        id: (chunk as { id?: string }).id,
        event: (chunk as { event?: string }).event,
        data: processedData,
      })
    }

    completeResponsesCapture(captureState)
  })

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  let captureState = observeRequestStart(c, {
    requestId: "pending",
    routeType: "responses",
    model: payload.model,
    stream: Boolean(payload.stream),
    requestBody: payload,
  })
  logger.debug("Responses request payload:", JSON.stringify(payload))

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  captureState = {
    ...captureState,
    requestId,
    sessionId,
  }

  const { selectedModel, supportsResponses } = prepareResponsesPayload(payload)

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  logger.debug("Translated Responses payload:", JSON.stringify(payload))

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    const response = await createResponses(payload, {
      vision,
      initiator,
      requestId,
      sessionId: sessionId,
    })

    if (isStreamingRequested(payload) && isAsyncIterable(response)) {
      logger.debug("Forwarding native Responses stream")
      return streamNativeResponses(c, response, captureState)
    }

    logger.debug(
      "Forwarding native Responses result:",
      JSON.stringify(response).slice(-400),
    )
    const result = response as ResponsesResult
    completeResponsesCapture(captureState, result, {
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      cachedTokens: result.usage?.input_tokens_details?.cached_tokens,
      reasoningTokens: result.usage?.output_tokens_details?.reasoning_tokens,
    })
    return c.json(result)
  } catch (error) {
    observeRequestError(captureState, error)
    throw error
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}
