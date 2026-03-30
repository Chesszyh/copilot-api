import { Hono } from "hono"
import { readFileSync } from "node:fs"

export interface ObservabilityViewerRouteConfig {
  debugMockEnabled: boolean
}

const defaultConfig: ObservabilityViewerRouteConfig = {
  debugMockEnabled: false,
}

const getViewerTemplate = (): string => {
  const viewerFileUrl = new URL(
    "../../../pages/observability-viewer.html",
    import.meta.url,
  )
  return readFileSync(viewerFileUrl, "utf8")
}

export const buildObservabilityViewerHtml = (
  config: ObservabilityViewerRouteConfig = defaultConfig,
): string => {
  const template = getViewerTemplate()
  return template.replace(
    "__OBSERVABILITY_VIEWER_CONFIG__",
    JSON.stringify(config),
  )
}

export const createObservabilityViewerRoute = (
  config: ObservabilityViewerRouteConfig = defaultConfig,
) => {
  const route = new Hono()

  route.get("/", (c) => {
    c.header("Cache-Control", "no-store")
    return c.html(buildObservabilityViewerHtml(config))
  })

  return route
}
