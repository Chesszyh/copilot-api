import { Hono } from "hono"

import type {
  GenerateObservabilityMockOptions,
  GenerateObservabilityMockResult,
} from "~/lib/observability/mock"
import type { PurgeResult } from "~/lib/observability/storage"

import { generateObservabilityMockData } from "~/lib/observability/mock"
import { getObservabilityStorage } from "~/lib/observability/worker"

export interface ObservabilityMockRouteStore {
  generateMockData(
    options: GenerateObservabilityMockOptions,
  ): GenerateObservabilityMockResult
  resetMockData(): PurgeResult
}

export interface ObservabilityMockRouteConfig {
  debugMockEnabled: boolean
}

const createDefaultStore = (): ObservabilityMockRouteStore => ({
  generateMockData: (options) =>
    generateObservabilityMockData(getObservabilityStorage(), options),
  resetMockData: () => getObservabilityStorage().resetMockData(),
})

export const createObservabilityMockRoute = (
  storage: ObservabilityMockRouteStore = createDefaultStore(),
  config: ObservabilityMockRouteConfig = { debugMockEnabled: false },
) => {
  const route = new Hono()

  route.use("*", async (c, next) => {
    if (!config.debugMockEnabled) {
      return c.notFound()
    }
    await next()
  })

  route.post("/generate", async (c) => {
    let body: Record<string, unknown> = {}
    if (c.req.header("content-type")?.includes("application/json")) {
      const parsed: unknown = await c.req.json().catch(() => null)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    }

    const result = storage.generateMockData({
      preset:
        body.preset === "coverage" || body.preset === "realistic" ?
          body.preset
        : undefined,
      count: typeof body.count === "number" ? body.count : undefined,
      seed: typeof body.seed === "number" ? body.seed : undefined,
      resetBeforeGenerate:
        typeof body.resetBeforeGenerate === "boolean" ?
          body.resetBeforeGenerate
        : undefined,
    })

    return c.json(result)
  })

  route.post("/reset", (c) => c.json(storage.resetMockData()))

  return route
}
