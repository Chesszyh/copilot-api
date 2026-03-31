import { getObservabilityConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"

import type {
  AnalysisFactRecord,
  SessionRecord,
  ObservabilityEnvelope,
  RequestEventRecord,
  ToolEventRecord,
} from "./types"

import { getObservabilityQueue } from "./queue"
import { redactText } from "./redact"
import { createObservabilityStorage } from "./storage"

const logger = createHandlerLogger("observability-worker")

let timer: ReturnType<typeof setInterval> | null = null
let storage: ReturnType<typeof createObservabilityStorage> | null = null

const ensureStorage = () => {
  storage ??= createObservabilityStorage()
  return storage
}

const deriveSessionStatus = (
  statusCode: number | null | undefined,
  errorType: string | null | undefined,
): "completed" | "failed" => {
  if (errorType || (statusCode ?? 200) >= 400) return "failed"
  return "completed"
}

const correctionPhrases = [
  "wrong",
  "try again",
  "not what",
  "instead",
  "rework",
  "redo",
  "重试",
  "不对",
  "不是这个意思",
  "改一下",
] as const

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
    )
  }

  return value
}

const lowerText = (value: string | null | undefined): string =>
  (value ?? "").toLowerCase()

const findCorrectionPhrase = (
  value: string | null | undefined,
): string | null => {
  const text = lowerText(value)
  if (!text) return null

  return (
    correctionPhrases.find((phrase) => text.includes(phrase.toLowerCase()))
    ?? null
  )
}

const normalizeFingerprint = (
  value: string | null | undefined,
): string | null => {
  if (!value) return null

  try {
    return JSON.stringify(sortJsonValue(JSON.parse(value)))
  } catch {
    return value.replaceAll(/\s+/g, " ").trim()
  }
}

const TOOL_TEXT_LIMIT = 800

const summarizeToolField = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null
  }

  const text =
    typeof value === "string" ? value : JSON.stringify(sortJsonValue(value))
  if (!text) {
    return null
  }

  if (text.length <= TOOL_TEXT_LIMIT) {
    return text
  }

  return `${text.slice(0, TOOL_TEXT_LIMIT)}...[truncated]`
}

const parseJsonSafely = (value: string | null | undefined): unknown => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const collectNestedToolNodes = (
  value: unknown,
): Array<Record<string, unknown>> => {
  const result: Array<Record<string, unknown>> = []
  const visited = new Set<unknown>()

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return
    }
    if (visited.has(node)) {
      return
    }
    visited.add(node)

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
      }
      return
    }

    const record = node as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : ""
    if (
      type === "tool_use"
      || type === "tool_result"
      || Array.isArray(record.tool_calls)
      || (record.function_call && typeof record.function_call === "object")
    ) {
      result.push(record)
    }

    for (const nested of Object.values(record)) {
      visit(nested)
    }
  }

  visit(value)
  return result
}

const buildBaseToolEvent = (
  request: RequestEventRecord,
  session: SessionRecord,
): Omit<ToolEventRecord, "toolEventId" | "toolName"> => ({
  sessionId: request.sessionId ?? null,
  requestId: request.requestId,
  startedAt: request.requestStartedAt,
  finishedAt: request.requestFinishedAt ?? request.requestStartedAt,
  source: session.source ?? "live",
})

interface ToolEventContext {
  request: RequestEventRecord
  session: SessionRecord
  nodeIndex: number
}

const extractAnthropicToolUseEvent = (
  context: ToolEventContext,
  node: Record<string, unknown>,
): ToolEventRecord | null => {
  if (node.type !== "tool_use" || typeof node.name !== "string") {
    return null
  }

  const { request, session, nodeIndex } = context
  const toolCallId =
    typeof node.id === "string" ? node.id : `tool-use-${nodeIndex}`
  return {
    ...buildBaseToolEvent(request, session),
    toolEventId: `${request.requestId}:use:${toolCallId}`,
    requestId: request.requestId,
    toolName: node.name,
    toolType: "tool_use",
    argumentsSummary: summarizeToolField(node.input ?? node.arguments),
    success: null,
  }
}

const extractAnthropicToolResultEvent = (
  context: ToolEventContext,
  node: Record<string, unknown>,
): ToolEventRecord | null => {
  if (node.type !== "tool_result") {
    return null
  }

  const { request, session, nodeIndex } = context
  const toolCallId =
    typeof node.tool_use_id === "string" ?
      node.tool_use_id
    : `tool-result-${nodeIndex}`
  return {
    ...buildBaseToolEvent(request, session),
    toolEventId: `${request.requestId}:result:${toolCallId}`,
    requestId: request.requestId,
    toolName: "tool_result",
    toolType: "tool_result",
    outputSummary: summarizeToolField(node.content ?? node.output),
    success: true,
  }
}

// eslint-disable-next-line complexity
const extractToolCallEvents = (
  context: ToolEventContext,
  node: Record<string, unknown>,
): Array<ToolEventRecord> => {
  const { request, session, nodeIndex } = context
  const events: Array<ToolEventRecord> = []

  const toolUseEvent = extractAnthropicToolUseEvent(context, node)
  if (toolUseEvent) {
    events.push(toolUseEvent)
  }

  const toolResultEvent = extractAnthropicToolResultEvent(context, node)
  if (toolResultEvent) {
    events.push(toolResultEvent)
  }

  if (Array.isArray(node.tool_calls)) {
    for (const [index, call] of node.tool_calls.entries()) {
      if (!call || typeof call !== "object") {
        continue
      }
      const callObj = call as Record<string, unknown>
      const functionObj =
        callObj.function && typeof callObj.function === "object" ?
          (callObj.function as Record<string, unknown>)
        : {}
      const functionName =
        typeof functionObj.name === "string" ? functionObj.name : null
      const directName = typeof callObj.name === "string" ? callObj.name : null
      const toolName = functionName ?? directName
      if (!toolName) {
        continue
      }
      const callId =
        typeof callObj.id === "string" ?
          callObj.id
        : `tool-call-${nodeIndex}-${index}`
      events.push({
        ...buildBaseToolEvent(request, session),
        toolEventId: `${request.requestId}:call:${callId}`,
        requestId: request.requestId,
        toolName,
        toolType: typeof callObj.type === "string" ? callObj.type : "tool_call",
        argumentsSummary: summarizeToolField(
          functionObj.arguments ?? callObj.arguments,
        ),
        success: null,
      })
    }
  }

  if (node.function_call && typeof node.function_call === "object") {
    const functionCall = node.function_call as Record<string, unknown>
    const toolName =
      typeof functionCall.name === "string" ? functionCall.name : null
    if (toolName) {
      events.push({
        ...buildBaseToolEvent(request, session),
        toolEventId: `${request.requestId}:fn:${nodeIndex}:${toolName}`,
        requestId: request.requestId,
        toolName,
        toolType: "function_call",
        argumentsSummary: summarizeToolField(functionCall.arguments),
        success: null,
      })
    }
  }

  return events
}

const applyToolFlags = (
  events: Array<ToolEventRecord>,
  facts: Array<AnalysisFactRecord>,
): Array<ToolEventRecord> => {
  const redundantRequestIds = new Set(
    facts
      .filter((fact) => fact.factType === "redundant_tool_signal")
      .map((fact) => fact.requestId)
      .filter((value): value is string => value !== null),
  )

  const recoveryRequestIds = new Set(
    facts
      .filter((fact) => fact.factType === "retry_after_answer")
      .map((fact) => {
        const value = fact.factValue as Record<string, unknown> | null
        return typeof value?.nextRequestId === "string" ?
            value.nextRequestId
          : null
      })
      .filter((value): value is string => value !== null),
  )

  return events.map((event) => ({
    ...event,
    isRedundantCall: redundantRequestIds.has(event.requestId),
    isRecoveryCall: recoveryRequestIds.has(event.requestId),
  }))
}

export const deriveToolEventsForSession = (
  session: SessionRecord,
  requests: Array<RequestEventRecord>,
): Array<ToolEventRecord> => {
  const parsedEvents: Array<ToolEventRecord> = []
  const dedupe = new Set<string>()

  for (const request of requests) {
    const payloadJson = parseJsonSafely(request.sanitizedPayload)
    const responseJson = parseJsonSafely(request.sanitizedResponse)
    const nodes = [
      ...collectNestedToolNodes(payloadJson),
      ...collectNestedToolNodes(responseJson),
    ]

    for (const [nodeIndex, node] of nodes.entries()) {
      const events = extractToolCallEvents(
        { request, session, nodeIndex },
        node,
      )
      for (const event of events) {
        const key = [
          event.requestId,
          event.toolName,
          event.toolType ?? "",
          event.argumentsSummary ?? "",
          event.outputSummary ?? "",
        ].join("|")
        if (dedupe.has(key)) {
          continue
        }
        dedupe.add(key)
        parsedEvents.push(event)
      }
    }
  }

  return parsedEvents
}

const isToolLikePayload = (value: string | null | undefined): boolean => {
  const text = lowerText(value)
  return /tool[_ ]?(?:use|result|calls?)|function_call/.test(text)
}

const isSuccessfulRequest = (request: RequestEventRecord): boolean =>
  !request.errorType && (request.statusCode ?? 200) < 400

const buildRetryAfterAnswerFact = (
  session: SessionRecord,
  previous: RequestEventRecord,
  current: RequestEventRecord,
): AnalysisFactRecord | null => {
  const matchedPhrase = findCorrectionPhrase(current.sanitizedPayload)
  if (!matchedPhrase || !isSuccessfulRequest(previous)) {
    return null
  }

  const previousEndedAt =
    previous.requestFinishedAt ?? previous.requestStartedAt
  const gapMs = Math.max(0, current.requestStartedAt - previousEndedAt)
  if (gapMs > 5 * 60 * 1000) {
    return null
  }

  return {
    sessionId: session.sessionId,
    requestId: previous.requestId,
    factType: "retry_after_answer",
    factValue: {
      nextRequestId: current.requestId,
      gapMs,
    },
    factScore: 0.6,
    source: session.source ?? "live",
    createdAt: current.requestStartedAt,
  }
}

const buildUserCorrectionFact = (
  session: SessionRecord,
  previous: RequestEventRecord,
  current: RequestEventRecord,
): AnalysisFactRecord | null => {
  const matchedPhrase = findCorrectionPhrase(current.sanitizedPayload)
  if (!matchedPhrase) {
    return null
  }

  return {
    sessionId: session.sessionId,
    requestId: current.requestId,
    factType: "user_correction_signal",
    factValue: {
      previousRequestId: previous.requestId,
      matchedPhrase,
    },
    factScore: 0.9,
    source: session.source ?? "live",
    createdAt: current.requestStartedAt,
  }
}

const buildRedundantToolFact = (
  session: SessionRecord,
  previous: RequestEventRecord,
  current: RequestEventRecord,
): AnalysisFactRecord | null => {
  const previousFingerprint = normalizeFingerprint(previous.sanitizedPayload)
  const currentFingerprint = normalizeFingerprint(current.sanitizedPayload)

  if (
    !previousFingerprint
    || !currentFingerprint
    || previousFingerprint !== currentFingerprint
    || !isToolLikePayload(current.sanitizedPayload)
    || !isToolLikePayload(previous.sanitizedPayload)
  ) {
    return null
  }

  return {
    sessionId: session.sessionId,
    requestId: current.requestId,
    factType: "redundant_tool_signal",
    factValue: {
      previousRequestId: previous.requestId,
      fingerprint: currentFingerprint,
    },
    factScore: 0.75,
    source: session.source ?? "live",
    createdAt: current.requestStartedAt,
  }
}

const buildHighReasoningFact = (
  session: SessionRecord,
  current: RequestEventRecord,
): AnalysisFactRecord | null => {
  const reasoningTokens = current.reasoningTokens ?? 0
  const outputTokens = current.outputTokens ?? 0
  const poorOutcome =
    Boolean(current.errorType)
    || (current.statusCode ?? 200) >= 400
    || session.status === "abandoned"
    || session.status === "failed"
    || outputTokens <= reasoningTokens / 2

  if (reasoningTokens < 200 || !poorOutcome) {
    return null
  }

  return {
    sessionId: session.sessionId,
    requestId: current.requestId,
    factType: "high_reasoning_low_outcome_signal",
    factValue: {
      reasoningTokens,
      outputTokens,
      sessionStatus: session.status ?? "unknown",
    },
    factScore: 0.95,
    source: session.source ?? "live",
    createdAt: current.requestStartedAt,
  }
}

export const deriveAnalysisFactsForSession = (
  session: SessionRecord,
  requests: Array<RequestEventRecord>,
): Array<AnalysisFactRecord> => {
  const facts: Array<AnalysisFactRecord> = []
  const sorted = [...requests].sort(
    (a, b) => a.requestStartedAt - b.requestStartedAt,
  )

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]
    const previous = index > 0 ? sorted[index - 1] : null

    if (previous) {
      const retryFact = buildRetryAfterAnswerFact(session, previous, current)
      if (retryFact) facts.push(retryFact)

      const correctionFact = buildUserCorrectionFact(session, previous, current)
      if (correctionFact) facts.push(correctionFact)

      const redundantToolFact = buildRedundantToolFact(
        session,
        previous,
        current,
      )
      if (redundantToolFact) facts.push(redundantToolFact)
    }

    const highReasoningFact = buildHighReasoningFact(session, current)
    if (highReasoningFact) facts.push(highReasoningFact)
  }

  return facts
}

export const persistObservabilityEnvelope = (
  item: ObservabilityEnvelope,
  targetStorage: ReturnType<
    typeof createObservabilityStorage
  > = ensureStorage(),
  options: {
    rawRetentionDays: number
  } = {
    rawRetentionDays: getObservabilityConfig().rawRetentionDays,
  },
): void => {
  const payload = item.payload
  const sessionId = payload.sessionId ?? payload.requestId
  const currentStorage = targetStorage

  currentStorage.upsertSession({
    sessionId,
    rootTraceId: payload.traceId,
    source: payload.source ?? "live",
    startedAt: payload.requestStartedAt,
    endedAt: payload.requestFinishedAt ?? null,
    status: deriveSessionStatus(payload.statusCode, payload.errorType),
  })

  const requestBody = payload.sanitizedPayload ?? null
  const responseBody = payload.sanitizedResponse ?? null
  let rawReference = payload.rawReference ?? null

  if (requestBody) {
    rawReference = {
      ...rawReference,
      ...currentStorage.writeRawBody({
        requestId: payload.requestId,
        sessionId,
        kind: "request",
        body: requestBody,
        createdAt: payload.requestStartedAt,
      }),
    }
  }

  if (responseBody) {
    rawReference = {
      ...rawReference,
      ...currentStorage.writeRawBody({
        requestId: payload.requestId,
        sessionId,
        kind: "response",
        body: responseBody,
        createdAt: payload.requestFinishedAt ?? payload.requestStartedAt,
      }),
    }
  }

  currentStorage.saveRequestEvent({
    ...payload,
    sessionId,
    sanitizedPayload: requestBody ? redactText(requestBody) : null,
    sanitizedResponse: responseBody ? redactText(responseBody) : null,
    rawReference,
  })

  const sessionDetail = currentStorage.getSessionDetail(sessionId)
  if (sessionDetail) {
    const derivedFacts = deriveAnalysisFactsForSession(
      sessionDetail.session,
      sessionDetail.requests,
    )
    currentStorage.replaceSessionAnalysisFacts(sessionId, derivedFacts)
    currentStorage.replaceSessionToolEvents(
      sessionId,
      applyToolFlags(
        deriveToolEventsForSession(
          sessionDetail.session,
          sessionDetail.requests,
        ),
        derivedFacts,
      ),
    )
  }

  currentStorage.purgeExpired({
    ttlMs: options.rawRetentionDays * 24 * 60 * 60 * 1000,
  })
}

export const startObservabilityWorker = (
  consumeBatch: (size: number) => Promise<void> | void,
  batchSize: number,
  flushIntervalMs: number,
): void => {
  stopObservabilityWorker()
  timer = setInterval(async () => {
    const queue = getObservabilityQueue()
    if (!queue || queue.size === 0) return

    try {
      await consumeBatch(batchSize)
    } catch (error) {
      logger.warn("Failed to consume observability batch:", error)
    }
  }, flushIntervalMs)
}

export const stopObservabilityWorker = (): void => {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export const drainObservabilityQueueToStorage = (batchSize: number): void => {
  const queue = getObservabilityQueue()
  if (!queue) return

  const items = queue.drain(batchSize)
  for (const item of items) {
    persistObservabilityEnvelope(item)
  }
}

export const getObservabilityStorage = () => ensureStorage()

export const resetObservabilityStorage = (): void => {
  storage?.close()
  storage = null
}
