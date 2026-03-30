import { Hono } from "hono"

import { getObservabilityStorage } from "~/lib/observability/worker"

export interface ObservabilitySessionsStore {
  getSessionDetail(sessionId: string): object | null
  listSessions(options?: { limit?: number; offset?: number }): Array<object>
}

export const createObservabilitySessionsRoute = (
  storage: ObservabilitySessionsStore = getObservabilityStorage(),
) => {
  const route = new Hono()

  route.get("/", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10)
    const offset = Number.parseInt(c.req.query("offset") ?? "0", 10)
    return c.json(storage.listSessions({ limit, offset }))
  })

  route.get("/:sessionId", (c) => {
    const session = storage.getSessionDetail(c.req.param("sessionId"))
    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }
    return c.json(session)
  })

  return route
}
