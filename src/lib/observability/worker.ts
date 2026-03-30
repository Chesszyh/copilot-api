import { createHandlerLogger } from "~/lib/logger"

import { getObservabilityQueue } from "./queue"

const logger = createHandlerLogger("observability-worker")

let timer: ReturnType<typeof setInterval> | null = null

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
