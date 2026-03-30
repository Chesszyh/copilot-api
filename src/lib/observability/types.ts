export type ObservabilityRouteType =
  | "messages"
  | "responses"
  | "chat_completions"

export interface ObservabilityRawReference {
  bodyPath?: string
  responsePath?: string
  pinned?: boolean
}

export interface SessionRecord {
  sessionId: string
  rootTraceId?: string | null
  userId?: string | null
  clientType?: string | null
  startedAt: number
  endedAt?: number | null
  status?: "completed" | "abandoned" | "failed" | "interrupted" | "unknown"
  pinned?: boolean
}

export interface RequestEventRecord {
  requestId: string
  sessionId?: string | null
  traceId: string
  routeType: ObservabilityRouteType
  method: string
  path: string
  model?: string | null
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
  rawReference?: ObservabilityRawReference | null
}

export interface ToolEventRecord {
  toolEventId: string
  sessionId?: string | null
  requestId: string
  toolName: string
  toolType?: string | null
  argumentsSummary?: string | null
  startedAt: number
  finishedAt?: number | null
  success?: boolean | null
  retryOf?: string | null
  outputSummary?: string | null
  isRedundantCall?: boolean
  isRecoveryCall?: boolean
}

export interface AnalysisFactRecord {
  sessionId: string
  wastedTokenRatio?: number | null
  detourRatio?: number | null
  firstUsefulOutputMs?: number | null
  retryAfterAnswerRate?: number | null
  userCorrectionRate?: number | null
  redundantToolCallRate?: number | null
  highReasoningLowOutcomeRate?: number | null
}

export type ObservabilityEnqueueMode = "full" | "sampled" | "minimal"

export interface QueueStats {
  droppedDetailed: number
  droppedMinimal: number
  enqueued: number
  dequeued: number
}

export interface RequestCaptureState {
  requestId: string
  sessionId?: string | null
  traceId: string
  routeType: ObservabilityRouteType
  method: string
  path: string
  model?: string | null
  stream: boolean
  requestStartedAt: number
  firstTokenAt?: number | null
  requestBody?: string | null
}

export interface ObservabilityEnvelope {
  kind: "request_event"
  mode: ObservabilityEnqueueMode
  createdAt: number
  payload: RequestEventRecord
}
