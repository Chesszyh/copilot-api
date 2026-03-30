import { getObservabilityConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"

import type { ObservabilityEnvelope } from "./types"

import { getObservabilityQueue } from "./queue"
import { redactText } from "./redact"
import { createObservabilityStorage } from "./storage"

const logger = createHandlerLogger("observability-worker")

let timer: ReturnType<typeof setInterval> | null = null
let storage: ReturnType<typeof createObservabilityStorage> | null = null

const ensureStorage = () => {
  storage ??= createObservabilityStorage()
  return storage
}

const deriveSessionStatus = (
  statusCode: number | null | undefined,
  errorType: string | null | undefined,
): "completed" | "failed" => {
  if (errorType || (statusCode ?? 200) >= 400) return "failed"
  return "completed"
}

const persistEnvelope = (item: ObservabilityEnvelope): void => {
  const config = getObservabilityConfig()
  const payload = item.payload
  const sessionId = payload.sessionId ?? payload.requestId
  const currentStorage = ensureStorage()

  currentStorage.upsertSession({
    sessionId,
    rootTraceId: payload.traceId,
    startedAt: payload.requestStartedAt,
    endedAt: payload.requestFinishedAt ?? null,
    status: deriveSessionStatus(payload.statusCode, payload.errorType),
  })

  const requestBody = payload.sanitizedPayload ?? null
  const responseBody = payload.sanitizedResponse ?? null
  let rawReference = payload.rawReference ?? null

  if (requestBody) {
    rawReference = {
      ...rawReference,
      ...currentStorage.writeRawBody({
        requestId: payload.requestId,
        sessionId,
        kind: "request",
        body: requestBody,
        createdAt: payload.requestStartedAt,
      }),
    }
  }

  if (responseBody) {
    rawReference = {
      ...rawReference,
      ...currentStorage.writeRawBody({
        requestId: payload.requestId,
        sessionId,
        kind: "response",
        body: responseBody,
        createdAt: payload.requestFinishedAt ?? payload.requestStartedAt,
      }),
    }
  }

  currentStorage.saveRequestEvent({
    ...payload,
    sessionId,
    sanitizedPayload: requestBody ? redactText(requestBody) : null,
    sanitizedResponse: responseBody ? redactText(responseBody) : null,
    rawReference,
  })

  currentStorage.purgeExpired({
    ttlMs: config.rawRetentionDays * 24 * 60 * 60 * 1000,
  })
}

export const startObservabilityWorker = (
  consumeBatch: (size: number) => Promise<void> | void,
  batchSize: number,
  flushIntervalMs: number,
): void => {
  stopObservabilityWorker()
  timer = setInterval(async () => {
    const queue = getObservabilityQueue()
    if (!queue || queue.size === 0) return

    try {
      await consumeBatch(batchSize)
    } catch (error) {
      logger.warn("Failed to consume observability batch:", error)
    }
  }, flushIntervalMs)
}

export const stopObservabilityWorker = (): void => {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export const drainObservabilityQueueToStorage = (batchSize: number): void => {
  const queue = getObservabilityQueue()
  if (!queue) return

  const items = queue.drain(batchSize)
  for (const item of items) {
    persistEnvelope(item)
  }
}

export const getObservabilityStorage = () => ensureStorage()

export const resetObservabilityStorage = (): void => {
  storage?.close()
  storage = null
}
