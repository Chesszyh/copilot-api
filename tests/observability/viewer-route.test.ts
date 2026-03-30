import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createObservabilityViewerRoute } from "~/routes/observability/viewer-route"

describe("observability viewer route", () => {
  test("serves the viewer html with injected debug config", async () => {
    const app = new Hono()

    app.route(
      "/observability-viewer",
      createObservabilityViewerRoute({ debugMockEnabled: true }),
    )

    const response = await app.request("/observability-viewer")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")

    const html = await response.text()
    expect(html).toContain("<title>Observability Viewer</title>")
    expect(html).toContain("window.__OBSERVABILITY_VIEWER_CONFIG__")
    expect(html).toContain('"debugMockEnabled":true')
    expect(html).toContain("/observability/summary")
    expect(html).toContain("/observability/sessions")
    expect(html).toContain("/observability/pin")
  })

  test("redirects the trailing slash path to the canonical path", async () => {
    const app = new Hono()
    app.get("/observability-viewer/", (c) =>
      c.redirect("/observability-viewer", 301),
    )

    const response = await app.request("/observability-viewer/")
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("/observability-viewer")
  })
})
