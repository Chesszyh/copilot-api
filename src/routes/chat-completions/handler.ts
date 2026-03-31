import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { createHandlerLogger } from "~/lib/logger"
import {
  observeRequestComplete,
  observeRequestError,
  observeRequestStart,
  observeStreamFirstChunk,
} from "~/lib/observability/capture"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  let captureState = observeRequestStart(c, {
    requestId: "pending",
    routeType: "chat_completions",
    model: payload.model,
    stream: Boolean(payload.stream),
    requestBody: payload,
  })
  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      logger.info("Current token count:", tokenCount)
    } else {
      logger.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  captureState = {
    ...captureState,
    requestId,
    sessionId,
  }

  try {
    const response = await createChatCompletions(payload, {
      requestId,
      sessionId,
    })

    if (isNonStreaming(response)) {
      logger.debug("Non-streaming response:", JSON.stringify(response))
      observeRequestComplete(captureState, {
        statusCode: 200,
        responseBody: response,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        },
      })
      return c.json(response)
    }

    logger.debug("Streaming response")
    return streamSSE(c, async (stream) => {
      let sawChunk = false
      for await (const chunk of response) {
        if (!sawChunk) {
          observeStreamFirstChunk(captureState)
          sawChunk = true
        }
        logger.debug("Streaming chunk:", JSON.stringify(chunk))
        await stream.writeSSE(chunk as SSEMessage)
      }

      observeRequestComplete(captureState, {
        statusCode: 200,
      })
    })
  } catch (error) {
    observeRequestError(captureState, error)
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
