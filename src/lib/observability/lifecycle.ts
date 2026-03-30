import { getObservabilityConfig } from "~/lib/config"

import { initObservabilityQueue, getObservabilityQueue } from "./queue"
import { startObservabilityWorker, stopObservabilityWorker } from "./worker"

let started = false

export const startObservabilityLifecycle = (
  consumeBatch: (size: number) => Promise<void> | void = (size) => {
    const queue = getObservabilityQueue()
    queue?.drain(size)
  },
): void => {
  const config = getObservabilityConfig()
  if (!config.enabled || started) return

  initObservabilityQueue(config.queueCapacity)
  startObservabilityWorker(
    consumeBatch,
    config.batchSize,
    config.flushIntervalMs,
  )
  started = true
}

export const stopObservabilityLifecycle = (): void => {
  if (!started) return
  stopObservabilityWorker()
  started = false
}
