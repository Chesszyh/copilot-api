import { Hono } from "hono"

import { getObservabilityStorage } from "~/lib/observability/worker"

export interface ObservabilityAnalysisStore {
  getAnalysisOverview(): unknown
}

export const createObservabilityAnalysisRoute = (
  storage: ObservabilityAnalysisStore = getObservabilityStorage(),
) => {
  const route = new Hono()

  route.get("/", (c) => {
    return c.json(storage.getAnalysisOverview())
  })

  return route
}
