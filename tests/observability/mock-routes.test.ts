import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type {
  GenerateObservabilityMockOptions,
  GenerateObservabilityMockResult,
} from "~/lib/observability/mock"

import { createObservabilityMockRoute } from "~/routes/observability/mock-route"

describe("observability mock routes", () => {
  test("rejects generate and reset when debug mock is disabled", async () => {
    const app = new Hono()
    app.route(
      "/observability/mock",
      createObservabilityMockRoute(
        {
          generateMockData: () => ({
            generatedSessions: 0,
            generatedRequests: 0,
            preset: "coverage" as const,
          }),
          resetMockData: () => ({
            deletedSessions: 0,
            deletedRequestEvents: 0,
            deletedArtifacts: 0,
          }),
        },
        { debugMockEnabled: false },
      ),
    )

    const generateResponse = await app.request("/observability/mock/generate", {
      method: "POST",
    })
    const resetResponse = await app.request("/observability/mock/reset", {
      method: "POST",
    })

    expect(generateResponse.status).toBe(404)
    expect(resetResponse.status).toBe(404)
  })

  test("generate route forwards preset arguments and returns generated counts", async () => {
    const app = new Hono()
    let receivedBody: GenerateObservabilityMockOptions | null = null

    app.route(
      "/observability/mock",
      createObservabilityMockRoute(
        {
          generateMockData: (
            options: GenerateObservabilityMockOptions,
          ): GenerateObservabilityMockResult => {
            receivedBody = options
            return {
              generatedSessions: 6,
              generatedRequests: 11,
              preset: options.preset ?? "coverage",
            }
          },
          resetMockData: () => ({
            deletedSessions: 0,
            deletedRequestEvents: 0,
            deletedArtifacts: 0,
          }),
        },
        { debugMockEnabled: true },
      ),
    )

    const response = await app.request("/observability/mock/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preset: "realistic",
        count: 8,
        seed: 42,
        resetBeforeGenerate: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(receivedBody).not.toBeNull()
    const body = receivedBody as unknown as GenerateObservabilityMockOptions
    expect(body).toMatchObject({
      preset: "realistic",
      count: 8,
      seed: 42,
      resetBeforeGenerate: true,
    })
    const parsed = (await response.json()) as GenerateObservabilityMockResult
    expect(parsed).toEqual({
      generatedSessions: 6,
      generatedRequests: 11,
      preset: "realistic",
    })
  })

  test("reset route only returns mock cleanup result", async () => {
    const app = new Hono()

    app.route(
      "/observability/mock",
      createObservabilityMockRoute(
        {
          generateMockData: () => ({
            generatedSessions: 0,
            generatedRequests: 0,
            preset: "coverage" as const,
          }),
          resetMockData: () => ({
            deletedSessions: 4,
            deletedRequestEvents: 9,
            deletedArtifacts: 2,
          }),
        },
        { debugMockEnabled: true },
      ),
    )

    const response = await app.request("/observability/mock/reset", {
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deletedSessions: 4,
      deletedRequestEvents: 9,
      deletedArtifacts: 2,
    })
  })
})
