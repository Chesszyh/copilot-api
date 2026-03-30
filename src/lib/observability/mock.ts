import type { PurgeResult } from "./storage"
import type { SessionRecord } from "./types"

export type ObservabilityMockPreset = "coverage" | "realistic"

export interface GenerateObservabilityMockOptions {
  preset?: ObservabilityMockPreset
  count?: number
  seed?: number
  resetBeforeGenerate?: boolean
}

export interface GenerateObservabilityMockResult {
  generatedSessions: number
  generatedRequests: number
  preset: ObservabilityMockPreset
}

export interface ObservabilityMockStorage {
  upsertSession(input: SessionRecord & { updatedAt?: number }): unknown
  saveRequestEvent(input: {
    requestId: string
    sessionId?: string | null
    traceId: string
    routeType: "messages" | "responses" | "chat_completions"
    method: string
    path: string
    model?: string | null
    source?: "live" | "mock"
    stream: boolean
    requestStartedAt: number
    firstTokenAt?: number | null
    requestFinishedAt?: number | null
    statusCode?: number | null
    errorType?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    cachedTokens?: number | null
    reasoningTokens?: number | null
    requestBodySize?: number | null
    responseBodySize?: number | null
    sanitizedPayload?: string | null
    sanitizedResponse?: string | null
  }): unknown
  resetMockData(): PurgeResult
}

interface MockScenarioTemplate {
  scenario: string
  status: SessionRecord["status"]
  routeType: "messages" | "responses" | "chat_completions"
  requestCount: number
  stream: boolean
  model: string
  errorEvery?: number
  reasoningBias?: number
  pinned?: boolean
}

const routePathMap = {
  chat_completions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
} as const

const coverageTemplates: Array<MockScenarioTemplate> = [
  {
    scenario: "normal_success",
    status: "completed",
    routeType: "messages",
    requestCount: 1,
    stream: true,
    model: "claude-3.7-sonnet",
  },
  {
    scenario: "error_case",
    status: "failed",
    routeType: "responses",
    requestCount: 1,
    stream: false,
    model: "gpt-5",
    errorEvery: 1,
  },
  {
    scenario: "retry_after_correction",
    status: "completed",
    routeType: "chat_completions",
    requestCount: 2,
    stream: true,
    model: "claude-3.7-sonnet",
  },
  {
    scenario: "pinned_case",
    status: "completed",
    routeType: "messages",
    requestCount: 2,
    stream: true,
    model: "claude-3.7-sonnet",
    pinned: true,
  },
  {
    scenario: "streaming_long_run",
    status: "completed",
    routeType: "responses",
    requestCount: 3,
    stream: true,
    model: "gpt-5",
    reasoningBias: 180,
  },
  {
    scenario: "high_reasoning_low_outcome",
    status: "abandoned",
    routeType: "responses",
    requestCount: 2,
    stream: true,
    model: "o3-mini",
    reasoningBias: 320,
  },
]

const realisticTemplates: Array<MockScenarioTemplate> = [
  {
    scenario: "code_edit_short",
    status: "completed",
    routeType: "messages",
    requestCount: 1,
    stream: true,
    model: "claude-3.7-sonnet",
  },
  {
    scenario: "debug_loop",
    status: "completed",
    routeType: "responses",
    requestCount: 2,
    stream: true,
    model: "gpt-5",
    reasoningBias: 120,
  },
  {
    scenario: "search_then_fix",
    status: "completed",
    routeType: "chat_completions",
    requestCount: 2,
    stream: false,
    model: "claude-3.7-sonnet",
  },
]

const clampCount = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(24, Math.trunc(value ?? fallback)))
}

const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const pickTemplates = (
  preset: ObservabilityMockPreset,
): Array<MockScenarioTemplate> =>
  preset === "realistic" ? realisticTemplates : coverageTemplates

export const generateObservabilityMockData = (
  storage: ObservabilityMockStorage,
  options: GenerateObservabilityMockOptions = {},
): GenerateObservabilityMockResult => {
  const preset = options.preset ?? "coverage"
  const count = clampCount(options.count, preset === "coverage" ? 6 : 8)
  const random = createSeededRandom(options.seed ?? 20260330)
  const templates = pickTemplates(preset)

  if (options.resetBeforeGenerate) {
    storage.resetMockData()
  }

  let generatedRequests = 0
  const baseStartedAt = Date.now() - count * 60_000

  for (let sessionIndex = 0; sessionIndex < count; sessionIndex += 1) {
    const template = templates[sessionIndex % templates.length]
    const sessionId = `mock-${preset}-session-${sessionIndex + 1}`
    const rootTraceId = `mock-trace-${preset}-${sessionIndex + 1}`
    const startedAt = baseStartedAt + sessionIndex * 45_000
    const requestCount = Math.max(
      1,
      template.requestCount + Math.floor(random() * 2),
    )
    const endedAt = startedAt + requestCount * 6_500

    storage.upsertSession({
      sessionId,
      rootTraceId,
      clientType: "observability-viewer",
      source: "mock",
      scenario: template.scenario,
      startedAt,
      endedAt,
      status: template.status,
      pinned: Boolean(template.pinned),
      updatedAt: endedAt,
    })

    for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
      const requestId = `${sessionId}-request-${requestIndex + 1}`
      const requestStartedAt = startedAt + requestIndex * 2_000
      const requestFinishedAt = requestStartedAt + 1_300 + requestIndex * 250
      const inputTokens = 500 + Math.floor(random() * 1_500)
      const outputTokens = 220 + Math.floor(random() * 1_200)
      const reasoningTokens =
        (template.reasoningBias ?? 40) + Math.floor(random() * 120)
      const failed =
        template.errorEvery !== undefined
        && (requestIndex + 1) % template.errorEvery === 0
        && requestIndex === requestCount - 1

      storage.saveRequestEvent({
        requestId,
        sessionId,
        traceId: `${rootTraceId}-${requestIndex + 1}`,
        routeType: template.routeType,
        method: "POST",
        path: routePathMap[template.routeType],
        model: template.model,
        source: "mock",
        stream: template.stream,
        requestStartedAt,
        firstTokenAt: template.stream ? requestStartedAt + 180 : null,
        requestFinishedAt,
        statusCode: failed ? 500 : 200,
        errorType: failed ? "mock_upstream_error" : null,
        inputTokens,
        outputTokens: failed ? Math.floor(outputTokens * 0.2) : outputTokens,
        cachedTokens: Math.floor(inputTokens * (0.1 + random() * 0.25)),
        reasoningTokens,
        requestBodySize: inputTokens * 3,
        responseBodySize: outputTokens * 4,
        sanitizedPayload: JSON.stringify({
          role: "user",
          summary: `${template.scenario} prompt ${requestIndex + 1}`,
        }),
        sanitizedResponse: JSON.stringify({
          role: "assistant",
          summary:
            failed ?
              "mock failure payload"
            : `${template.scenario} response ${requestIndex + 1}`,
        }),
      })
      generatedRequests += 1
    }
  }

  return {
    generatedSessions: count,
    generatedRequests,
    preset,
  }
}
