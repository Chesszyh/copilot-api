import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/request-auth"

describe("request auth middleware", () => {
  test("supports wildcard unauthenticated path prefixes", async () => {
    const app = new Hono()

    app.use(
      "*",
      createAuthMiddleware({
        allowUnauthenticatedPaths: ["/observability/sessions/*"],
        getApiKeys: () => ["secret"],
      }),
    )

    app.get("/observability/sessions/:sessionId", (c) =>
      c.json({ sessionId: c.req.param("sessionId") }),
    )

    const response = await app.request("/observability/sessions/session-1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: "session-1" })
  })
})
