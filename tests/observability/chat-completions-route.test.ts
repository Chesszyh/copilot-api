import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { getConfig } from "~/lib/config"
import {
  getObservabilityQueue,
  initObservabilityQueue,
} from "~/lib/observability/queue"
import { state } from "~/lib/state"
import { completionRoutes } from "~/routes/chat-completions/route"

const originalFetch = globalThis.fetch

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

const createRequestBody = (stream: boolean) => ({
  model: "gpt-test",
  messages: [{ role: "user", content: "hello" }],
  stream,
})

describe("chat completions observability coverage", () => {
  beforeEach(() => {
    initObservabilityQueue(16)

    const config = getConfig()
    config.observability = {
      enabled: true,
      queueCapacity: 16,
      batchSize: 10,
      flushIntervalMs: 50,
      rawRetentionDays: 3,
      maxBodyBytes: 4096,
    }

    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.0.0"
    state.accountType = "individual"
    state.rateLimitSeconds = undefined
    state.lastRequestTimestamp = undefined
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("captures non-streaming request event", async () => {
    const fetchMock = mock(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequestBody(false)),
    })

    expect(response.status).toBe(200)

    const event = getObservabilityQueue()?.drain(1)[0]
    expect(event).toBeDefined()
    expect(event?.payload.routeType).toBe("chat_completions")
    expect(event?.payload.stream).toBe(false)
    expect(event?.payload.statusCode).toBe(200)
  })

  test("keeps main flow when debug mock switch is enabled", async () => {
    const config = getConfig()
    config.observability = {
      ...config.observability,
      enabled: true,
      debugMockEnabled: true,
    }

    const fetchMock = mock(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-debug",
            object: "chat.completion",
            created: 1,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequestBody(false)),
    })

    expect(response.status).toBe(200)

    const event = getObservabilityQueue()?.drain(1)[0]
    expect(event).toBeDefined()
    expect(event?.payload.routeType).toBe("chat_completions")
    expect(event?.payload.statusCode).toBe(200)
  })

  test("captures streaming request timing", async () => {
    const streamBody = [
      `data: ${JSON.stringify({
        id: "chatcmpl-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")

    const fetchMock = mock(
      () =>
        new Response(streamBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequestBody(true)),
    })

    expect(response.status).toBe(200)
    await response.text()

    const event = getObservabilityQueue()?.drain(1)[0]
    expect(event).toBeDefined()
    expect(event?.payload.routeType).toBe("chat_completions")
    expect(event?.payload.stream).toBe(true)
    expect(event?.payload.firstTokenAt).toBeNumber()
    expect(event?.payload.statusCode).toBe(200)
  })

  test("captures error events on upstream failure", async () => {
    const fetchMock = mock(
      () =>
        new Response(JSON.stringify({ message: "upstream failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequestBody(false)),
    })

    expect(response.status).toBe(500)

    const event = getObservabilityQueue()?.drain(1)[0]
    expect(event).toBeDefined()
    expect(event?.mode).toBe("minimal")
    expect(event?.payload.routeType).toBe("chat_completions")
    expect(event?.payload.errorType).toBe("Error")
  })
})
