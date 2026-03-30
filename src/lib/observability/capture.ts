import type { Context } from "hono"

import { getObservabilityConfig } from "~/lib/config"
import { requestContext } from "~/lib/request-context"

import { getObservabilityQueue } from "./queue"
import type {
  ObservabilityEnqueueMode,
  ObservabilityRouteType,
  RequestCaptureState,
  RequestEventRecord,
} from "./types"

const serializeWithLimit = (
  value: unknown,
  maxBytes: number,
): string | null => {
  if (value === undefined) return null

  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text.length <= maxBytes) return text
  return `${text.slice(0, maxBytes)}...[truncated]`
}

const resolveMode = (
  hasBodies: boolean,
  hasError: boolean,
): ObservabilityEnqueueMode => {
  if (hasError) return "minimal"
  return hasBodies ? "full" : "sampled"
}

export const observeRequestStart = (
  c: Context,
  options: {
    requestId: string
    sessionId?: string | null
    routeType: ObservabilityRouteType
    model?: string | null
    stream: boolean
    requestBody?: unknown
  },
): RequestCaptureState => {
  const config = getObservabilityConfig()

  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    traceId:
      requestContext.getStore()?.traceId
      ?? c.req.header("x-trace-id")
      ?? "unknown",
    routeType: options.routeType,
    method: c.req.method,
    path: c.req.path,
    model: options.model,
    stream: options.stream,
    requestStartedAt: Date.now(),
    requestBody: serializeWithLimit(options.requestBody, config.maxBodyBytes),
  }
}

export const observeStreamFirstChunk = (state: RequestCaptureState): void => {
  state.firstTokenAt ??= Date.now()
}

const enqueueRecord = (
  record: RequestEventRecord,
  hasBodies: boolean,
): void => {
  const queue = getObservabilityQueue()
  if (!queue) return

  queue.enqueue({
    kind: "request_event",
    mode: resolveMode(hasBodies, Boolean(record.errorType)),
    createdAt: Date.now(),
    payload: record,
  })
}

export const observeRequestComplete = (
  state: RequestCaptureState,
  options: {
    statusCode: number
    responseBody?: unknown
    usage?: {
      inputTokens?: number | null
      outputTokens?: number | null
      cachedTokens?: number | null
      reasoningTokens?: number | null
    }
  },
): void => {
  const config = getObservabilityConfig()
  const responseBody = serializeWithLimit(options.responseBody, config.maxBodyBytes)
  enqueueRecord(
    {
      requestId: state.requestId,
      sessionId: state.sessionId,
      traceId: state.traceId,
      routeType: state.routeType,
      method: state.method,
      path: state.path,
      model: state.model,
      stream: state.stream,
      requestStartedAt: state.requestStartedAt,
      firstTokenAt: state.firstTokenAt,
      requestFinishedAt: Date.now(),
      statusCode: options.statusCode,
      inputTokens: options.usage?.inputTokens ?? null,
      outputTokens: options.usage?.outputTokens ?? null,
      cachedTokens: options.usage?.cachedTokens ?? null,
      reasoningTokens: options.usage?.reasoningTokens ?? null,
      requestBodySize: state.requestBody?.length ?? null,
      responseBodySize: responseBody?.length ?? null,
      sanitizedPayload: state.requestBody,
      sanitizedResponse: responseBody,
    },
    Boolean(state.requestBody || responseBody),
  )
}

export const observeRequestError = (
  state: RequestCaptureState,
  error: unknown,
  statusCode: number = 500,
): void => {
  enqueueRecord(
    {
      requestId: state.requestId,
      sessionId: state.sessionId,
      traceId: state.traceId,
      routeType: state.routeType,
      method: state.method,
      path: state.path,
      model: state.model,
      stream: state.stream,
      requestStartedAt: state.requestStartedAt,
      firstTokenAt: state.firstTokenAt,
      requestFinishedAt: Date.now(),
      statusCode,
      errorType: error instanceof Error ? error.name : typeof error,
      requestBodySize: state.requestBody?.length ?? null,
      sanitizedPayload: state.requestBody,
    },
    Boolean(state.requestBody),
  )
}
