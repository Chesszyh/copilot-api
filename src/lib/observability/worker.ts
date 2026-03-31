import { getObservabilityConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"

import type {
  AnalysisFactRecord,
  RequestEventRecord,
  SessionRecord,
  ObservabilityEnvelope,
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
    currentStorage.replaceSessionAnalysisFacts(
      sessionId,
      deriveAnalysisFactsForSession(
        sessionDetail.session,
        sessionDetail.requests,
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
