import { describe, expect, test } from "bun:test"

import type { ObservabilityEnvelope } from "~/lib/observability/types"

import { ObservabilityQueue } from "~/lib/observability/queue"

const event = (
  id: string,
  mode: ObservabilityEnvelope["mode"],
): ObservabilityEnvelope => ({
  kind: "request_event",
  mode,
  createdAt: Date.now(),
  payload: {
    requestId: id,
    traceId: id,
    routeType: "messages",
    method: "POST",
    path: "/v1/messages",
    stream: false,
    requestStartedAt: Date.now(),
  },
})

describe("ObservabilityQueue", () => {
  test("enqueues and drains in order", () => {
    const queue = new ObservabilityQueue(2)

    expect(queue.enqueue(event("a", "full"))).toBe(true)
    expect(queue.enqueue(event("b", "sampled"))).toBe(true)

    const drained = queue.drain(2)
    expect(drained.map((item) => item.payload.requestId)).toEqual(["a", "b"])
    expect(queue.getStats().dequeued).toBe(2)
  })

  test("drops minimal events when queue is full", () => {
    const queue = new ObservabilityQueue(1)

    expect(queue.enqueue(event("a", "full"))).toBe(true)
    expect(queue.enqueue(event("b", "minimal"))).toBe(false)
    expect(queue.size).toBe(1)
    expect(queue.getStats().droppedMinimal).toBe(1)
  })

  test("replaces a fuller event with a lower priority one when needed", () => {
    const queue = new ObservabilityQueue(1)

    expect(queue.enqueue(event("a", "full"))).toBe(true)
    expect(queue.enqueue(event("b", "sampled"))).toBe(true)

    const drained = queue.drain(1)
    expect(drained[0]?.payload.requestId).toBe("b")
    expect(queue.getStats().droppedDetailed).toBe(1)
  })
})
