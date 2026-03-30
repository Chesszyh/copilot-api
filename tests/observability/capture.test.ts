import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { getConfig } from "~/lib/config"
import {
  observeRequestComplete,
  observeRequestError,
  observeRequestStart,
  observeStreamFirstChunk,
} from "~/lib/observability/capture"
import {
  getObservabilityQueue,
  initObservabilityQueue,
} from "~/lib/observability/queue"
import { traceIdMiddleware } from "~/lib/trace"

describe("observability capture", () => {
  beforeEach(() => {
    initObservabilityQueue(10)

    const config = getConfig()
    config.observability = {
      enabled: true,
      queueCapacity: 10,
      batchSize: 10,
      flushIntervalMs: 50,
      rawRetentionDays: 3,
      maxBodyBytes: 128,
    }
  })

  test("captures a completed request event", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)

    app.post("/test", async (c) => {
      const payload = await c.req.json<{ prompt: string }>()
      const capture = observeRequestStart(c, {
        requestId: "req-1",
        sessionId: "session-1",
        routeType: "messages",
        model: "gpt-5.4",
        stream: false,
        requestBody: payload,
      })
      observeRequestComplete(capture, {
        statusCode: 200,
        responseBody: { ok: true },
        usage: { inputTokens: 12, outputTokens: 4 },
      })
      return c.json({ ok: true })
    })

    const response = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })

    expect(response.status).toBe(200)
    const queue = getObservabilityQueue()
    const item = queue?.drain(1)[0]
    expect(item?.payload.requestId).toBe("req-1")
    expect(item?.payload.sessionId).toBe("session-1")
    expect(item?.payload.traceId).toBeTruthy()
    expect(item?.payload.inputTokens).toBe(12)
    expect(item?.payload.outputTokens).toBe(4)
  })

  test("captures first stream chunk timing", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)

    app.get("/stream", (c) => {
      const capture = observeRequestStart(c, {
        requestId: "req-2",
        routeType: "responses",
        stream: true,
      })
      observeStreamFirstChunk(capture)
      observeRequestComplete(capture, {
        statusCode: 200,
        responseBody: "ok",
      })
      return c.text("ok")
    })

    await app.request("/stream")

    const item = getObservabilityQueue()?.drain(1)[0]
    expect(item?.payload.firstTokenAt).toBeNumber()
    expect(item?.payload.requestFinishedAt).toBeNumber()
  })

  test("captures errors as minimal events", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)

    app.get("/boom", (c) => {
      const capture = observeRequestStart(c, {
        requestId: "req-3",
        routeType: "chat_completions",
        stream: false,
      })
      observeRequestError(capture, new TypeError("bad"))
      return c.text("fail", 500)
    })

    await app.request("/boom")

    const item = getObservabilityQueue()?.drain(1)[0]
    expect(item?.mode).toBe("minimal")
    expect(item?.payload.errorType).toBe("TypeError")
  })
})
