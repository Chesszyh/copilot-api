import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createObservabilityAnalysisRoute } from "~/routes/observability/analysis-route"
import { createObservabilityPinRoute } from "~/routes/observability/pin-route"
import { createObservabilitySessionsRoute } from "~/routes/observability/sessions-route"
import { createObservabilitySummaryRoute } from "~/routes/observability/summary-route"

describe("observability routes", () => {
  test("summary route returns storage summary", async () => {
    const app = new Hono()
    app.route(
      "/observability/summary",
      createObservabilitySummaryRoute({
        getSummary: () => ({ sessionCount: 1, requestCount: 2 }),
      }),
    )

    const response = await app.request("/observability/summary")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessionCount: 1,
      requestCount: 2,
    })
  })

  test("analysis route returns aggregated analysis summary", async () => {
    const app = new Hono()
    app.route(
      "/observability/analysis",
      createObservabilityAnalysisRoute({
        getAnalysisOverview: () => ({
          totalFacts: 3,
          sessionsWithFacts: 2,
          factsByType: [
            { factType: "retry_after_answer", count: 2, avgScore: 0.7 },
          ],
        }),
      }),
    )

    const response = await app.request("/observability/analysis")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      totalFacts: 3,
      sessionsWithFacts: 2,
      factsByType: [
        { factType: "retry_after_answer", count: 2, avgScore: 0.7 },
      ],
    })
  })

  test("sessions route returns list and detail", async () => {
    const app = new Hono()
    app.route(
      "/observability/sessions",
      createObservabilitySessionsRoute({
        listSessions: () => [{ sessionId: "s1", requestCount: 1 }],
        getSessionDetail: (sessionId) => {
          return sessionId === "s1" ?
              { session: { sessionId: "s1" }, requests: [] }
            : null
        },
      }),
    )

    const listResponse = await app.request("/observability/sessions")
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toEqual([
      { sessionId: "s1", requestCount: 1 },
    ])

    const detailResponse = await app.request("/observability/sessions/s1")
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toEqual({
      session: { sessionId: "s1" },
      requests: [],
    })

    const missingResponse = await app.request("/observability/sessions/missing")
    expect(missingResponse.status).toBe(404)
  })

  test("pin route toggles session pin state", async () => {
    const app = new Hono()
    const calls: Array<{ sessionId: string; pinned: boolean }> = []

    app.route(
      "/observability/pin",
      createObservabilityPinRoute({
        setSessionPinned: (sessionId, pinned) => {
          calls.push({ sessionId, pinned })
          return sessionId === "s1"
        },
      }),
    )

    const pinResponse = await app.request("/observability/pin/s1", {
      method: "POST",
    })
    expect(pinResponse.status).toBe(200)
    expect(await pinResponse.json()).toEqual({ sessionId: "s1", pinned: true })

    const unpinResponse = await app.request("/observability/pin/s1", {
      method: "DELETE",
    })
    expect(unpinResponse.status).toBe(200)
    expect(await unpinResponse.json()).toEqual({
      sessionId: "s1",
      pinned: false,
    })

    const missingResponse = await app.request("/observability/pin/missing", {
      method: "POST",
    })
    expect(missingResponse.status).toBe(404)
    expect(calls).toEqual([
      { sessionId: "s1", pinned: true },
      { sessionId: "s1", pinned: false },
      { sessionId: "missing", pinned: true },
    ])
  })
})
