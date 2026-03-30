import { Hono } from "hono"

import { getObservabilityStorage } from "~/lib/observability/worker"

export interface ObservabilityPinStore {
  setSessionPinned(sessionId: string, pinned: boolean): boolean
}

export const createObservabilityPinRoute = (
  storage: ObservabilityPinStore = getObservabilityStorage(),
) => {
  const route = new Hono()

  route.post("/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    if (!storage.setSessionPinned(sessionId, true)) {
      return c.json({ error: "Session not found" }, 404)
    }
    return c.json({ sessionId, pinned: true })
  })

  route.delete("/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    if (!storage.setSessionPinned(sessionId, false)) {
      return c.json({ error: "Session not found" }, 404)
    }
    return c.json({ sessionId, pinned: false })
  })

  return route
}
