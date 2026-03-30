import { getObservabilityConfig } from "~/lib/config"

import { initObservabilityQueue, getObservabilityQueue } from "./queue"
import {
  drainObservabilityQueueToStorage,
  startObservabilityWorker,
  stopObservabilityWorker,
} from "./worker"

let started = false

export const startObservabilityLifecycle = (
  consumeBatch: (
    size: number,
  ) => Promise<void> | void = drainObservabilityQueueToStorage,
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
  const queue = getObservabilityQueue()
  if (queue && queue.size > 0) {
    drainObservabilityQueueToStorage(queue.size)
  }
  stopObservabilityWorker()
  started = false
}
