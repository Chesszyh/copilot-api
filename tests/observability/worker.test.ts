import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  ObservabilityEnvelope,
  RequestEventRecord,
  SessionRecord,
} from "~/lib/observability/types"

import { createObservabilityStorage } from "~/lib/observability/storage"
import {
  deriveAnalysisFactsForSession,
  persistObservabilityEnvelope,
} from "~/lib/observability/worker"

const createTempDir = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), "observability-worker-"))

const session: SessionRecord = {
  sessionId: "session-1",
  startedAt: 1000,
  endedAt: 6000,
  status: "abandoned",
  source: "live",
}

const request = (
  overrides: Partial<RequestEventRecord>
    & Pick<RequestEventRecord, "requestId">,
): RequestEventRecord => ({
  sessionId: "session-1",
  traceId: `trace-${overrides.requestId}`,
  routeType: "responses",
  method: "POST",
  path: "/v1/responses",
  model: "gpt-5.4",
  source: "live",
  stream: true,
  requestStartedAt: 1000,
  requestFinishedAt: 1800,
  statusCode: 200,
  inputTokens: 100,
  outputTokens: 80,
  cachedTokens: 0,
  reasoningTokens: 40,
  sanitizedPayload: null,
  sanitizedResponse: null,
  ...overrides,
})

test("deriveAnalysisFactsForSession returns rule-based quality signals", () => {
  const facts = deriveAnalysisFactsForSession(session, [
    request({
      requestId: "req-1",
      requestStartedAt: 1000,
      requestFinishedAt: 1600,
      outputTokens: 120,
      reasoningTokens: 20,
      sanitizedResponse: JSON.stringify({
        summary: "Initial answer",
      }),
    }),
    request({
      requestId: "req-2",
      requestStartedAt: 3200,
      requestFinishedAt: 3900,
      sanitizedPayload: JSON.stringify({
        type: "user_followup",
        message: "This is wrong, try again with the actual fix.",
      }),
    }),
    request({
      requestId: "req-3",
      requestStartedAt: 4500,
      requestFinishedAt: 5000,
      sanitizedPayload: JSON.stringify({
        type: "tool_result",
        tool: "search_code",
        content: "same repeated tool output",
      }),
    }),
    request({
      requestId: "req-4",
      requestStartedAt: 5300,
      requestFinishedAt: 5900,
      sanitizedPayload: JSON.stringify({
        type: "tool_result",
        tool: "search_code",
        content: "same repeated tool output",
      }),
    }),
    request({
      requestId: "req-5",
      requestStartedAt: 6100,
      requestFinishedAt: 7200,
      reasoningTokens: 320,
      outputTokens: 60,
      sanitizedResponse: JSON.stringify({
        summary: "Long reasoning, weak outcome",
      }),
    }),
  ])

  expect(facts).toEqual([
    {
      sessionId: "session-1",
      requestId: "req-1",
      factType: "retry_after_answer",
      factValue: {
        nextRequestId: "req-2",
        gapMs: 1600,
      },
      factScore: 0.6,
      source: "live",
      createdAt: 3200,
    },
    {
      sessionId: "session-1",
      requestId: "req-2",
      factType: "user_correction_signal",
      factValue: {
        previousRequestId: "req-1",
        matchedPhrase: "wrong",
      },
      factScore: 0.9,
      source: "live",
      createdAt: 3200,
    },
    {
      sessionId: "session-1",
      requestId: "req-4",
      factType: "redundant_tool_signal",
      factValue: {
        previousRequestId: "req-3",
        fingerprint:
          '{"content":"same repeated tool output","tool":"search_code","type":"tool_result"}',
      },
      factScore: 0.75,
      source: "live",
      createdAt: 5300,
    },
    {
      sessionId: "session-1",
      requestId: "req-5",
      factType: "high_reasoning_low_outcome_signal",
      factValue: {
        reasoningTokens: 320,
        outputTokens: 60,
        sessionStatus: "abandoned",
      },
      factScore: 0.95,
      source: "live",
      createdAt: 6100,
    },
  ])
})

test("persistObservabilityEnvelope recalculates and stores analysis facts", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  const firstEnvelope: ObservabilityEnvelope = {
    kind: "request_event",
    mode: "full",
    createdAt: 1000,
    payload: request({
      requestId: "req-1",
      requestStartedAt: 1000,
      requestFinishedAt: 1600,
      sanitizedResponse: JSON.stringify({ summary: "Initial answer" }),
    }),
  }

  const secondEnvelope: ObservabilityEnvelope = {
    kind: "request_event",
    mode: "full",
    createdAt: 2000,
    payload: request({
      requestId: "req-2",
      requestStartedAt: 3200,
      requestFinishedAt: 3900,
      sanitizedPayload: JSON.stringify({
        type: "user_followup",
        message: "This is wrong, try again with the actual fix.",
      }),
    }),
  }

  try {
    persistObservabilityEnvelope(firstEnvelope, storage, {
      rawRetentionDays: 3,
    })
    persistObservabilityEnvelope(secondEnvelope, storage, {
      rawRetentionDays: 3,
    })

    const detail = storage.getSessionDetail("session-1")
    expect(detail?.analysisFacts).toEqual([
      {
        sessionId: "session-1",
        requestId: "req-1",
        factType: "retry_after_answer",
        factValue: {
          nextRequestId: "req-2",
          gapMs: 1600,
        },
        factScore: 0.6,
        source: "live",
        createdAt: 3200,
      },
      {
        sessionId: "session-1",
        requestId: "req-2",
        factType: "user_correction_signal",
        factValue: {
          previousRequestId: "req-1",
          matchedPhrase: "wrong",
        },
        factScore: 0.9,
        source: "live",
        createdAt: 3200,
      },
    ])
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})
