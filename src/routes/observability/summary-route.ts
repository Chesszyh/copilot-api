import { Hono } from "hono"

import { getObservabilityStorage } from "~/lib/observability/worker"

export interface ObservabilitySummaryStore {
  getSummary(): unknown
}

export const createObservabilitySummaryRoute = (
  storage: ObservabilitySummaryStore = getObservabilityStorage(),
) => {
  const route = new Hono()

  route.get("/", (c) => {
    return c.json(storage.getSummary())
  })

  return route
}
