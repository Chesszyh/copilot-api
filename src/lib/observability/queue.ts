import type {
  ObservabilityEnqueueMode,
  ObservabilityEnvelope,
  QueueStats,
} from "./types"

const modePriority: Record<ObservabilityEnqueueMode, number> = {
  full: 2,
  sampled: 1,
  minimal: 0,
}

export class ObservabilityQueue {
  #capacity: number
  #items: Array<ObservabilityEnvelope> = []
  #stats: QueueStats = {
    droppedDetailed: 0,
    droppedMinimal: 0,
    enqueued: 0,
    dequeued: 0,
  }

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity)
  }

  get size(): number {
    return this.#items.length
  }

  get capacity(): number {
    return this.#capacity
  }

  getStats(): QueueStats {
    return { ...this.#stats }
  }

  enqueue(item: ObservabilityEnvelope): boolean {
    if (this.#items.length < this.#capacity) {
      this.#items.push(item)
      this.#stats.enqueued++
      return true
    }

    if (item.mode === "minimal") {
      this.#stats.droppedMinimal++
      return false
    }

    const index = this.#items.findIndex(
      (candidate) => modePriority[candidate.mode] > modePriority[item.mode],
    )

    if (index === -1) {
      this.#stats.droppedDetailed++
      return false
    }

    this.#items.splice(index, 1)
    this.#stats.droppedDetailed++
    this.#items.push(item)
    this.#stats.enqueued++
    return true
  }

  drain(maxItems: number): Array<ObservabilityEnvelope> {
    const take = Math.max(0, maxItems)
    const drained = this.#items.splice(0, take)
    this.#stats.dequeued += drained.length
    return drained
  }
}

let queue: ObservabilityQueue | null = null

export const initObservabilityQueue = (capacity: number): ObservabilityQueue => {
  queue = new ObservabilityQueue(capacity)
  return queue
}

export const getObservabilityQueue = (): ObservabilityQueue | null => queue
