import { Hono } from "hono"

import {
  backfillObservabilityAnalysis,
  getObservabilityStorage,
} from "~/lib/observability/worker"

export interface ObservabilityAnalysisStore {
  getAnalysisOverview(): unknown
  backfillAnalysis(options?: { batchSize?: number }): unknown
}

export const createObservabilityAnalysisRoute = (
  storage: ObservabilityAnalysisStore = {
    getAnalysisOverview: () => getObservabilityStorage().getAnalysisOverview(),
    backfillAnalysis: (options) =>
      backfillObservabilityAnalysis(getObservabilityStorage(), options),
  },
) => {
  const route = new Hono()

  route.get("/", (c) => {
    return c.json(storage.getAnalysisOverview())
  })

  route.post("/backfill", async (c) => {
    let body: Record<string, unknown> = {}
    if (c.req.header("content-type")?.includes("application/json")) {
      const parsed: unknown = await c.req.json().catch(() => null)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    }

    const batchSize =
      typeof body.batchSize === "number" && Number.isFinite(body.batchSize) ?
        body.batchSize
      : undefined

    return c.json(
      storage.backfillAnalysis({
        batchSize,
      }),
    )
  })

  return route
}
