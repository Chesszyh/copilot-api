import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createObservabilityStorage } from "../../src/lib/observability/storage"

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observability-"))
  return dir
}

test("stores sessions, request events, and raw bodies", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  try {
    const session = storage.upsertSession({
      sessionId: "session-1",
      rootTraceId: "trace-1",
      userId: "user-1",
      clientType: "vscode",
      startedAt: 1000,
      status: "unknown",
    })

    expect(session.sessionId).toBe("session-1")
    expect(session.pinned).toBe(false)

    const rawReference = storage.writeRawBody({
      requestId: "request-1",
      sessionId: "session-1",
      kind: "request",
      body: "hello world",
      createdAt: 1100,
    })

    const event = storage.saveRequestEvent({
      requestId: "request-1",
      sessionId: "session-1",
      traceId: "trace-1",
      routeType: "messages",
      method: "POST",
      path: "/v1/messages",
      model: "claude-3-5-sonnet",
      stream: true,
      requestStartedAt: 1100,
      statusCode: 200,
      requestBodySize: 11,
      sanitizedPayload: '{"ok":true}',
      rawReference,
    })

    expect(event.requestId).toBe("request-1")
    expect(event.rawReference).toEqual(rawReference)
    expect(storage.readRawBody(rawReference)).toBe("hello world")

    expect(storage.getSession("session-1")).toMatchObject({
      sessionId: "session-1",
      clientType: "vscode",
      rootTraceId: "trace-1",
      pinned: false,
    })

    expect(storage.getRequestEvent("request-1")).toMatchObject({
      requestId: "request-1",
      sessionId: "session-1",
      routeType: "messages",
      rawReference,
    })
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})

test("pinning promotes raw bodies and protects them from ttl purge", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  try {
    storage.upsertSession({
      sessionId: "session-pin",
      startedAt: 1000,
      status: "unknown",
    })

    const rawReference = storage.writeRawBody({
      requestId: "request-pin",
      sessionId: "session-pin",
      kind: "response",
      body: "keep me",
      createdAt: 1200,
    })

    expect(storage.pinSession("session-pin")).toBe(true)

    const pinnedSession = storage.getSession("session-pin")
    expect(pinnedSession).toMatchObject({
      sessionId: "session-pin",
      pinned: true,
    })

    const pinnedBody = storage.getRawArtifact("request-pin", "response")
    expect(pinnedBody).not.toBeNull()
    expect(pinnedBody?.pinned).toBe(true)
    expect(storage.readRawBody(rawReference)).toBe("keep me")

    const purgeResult = storage.purgeExpired({
      ttlMs: 1,
      now: 10_000,
    })

    expect(purgeResult.deletedSessions).toBe(0)
    expect(purgeResult.deletedArtifacts).toBe(0)
    expect(storage.getSession("session-pin")).not.toBeNull()
    expect(storage.readRawBody(rawReference)).toBe("keep me")
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})

test("stores source and scenario, and resetMockData only removes mock records", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  try {
    storage.upsertSession({
      sessionId: "live-session",
      startedAt: 1000,
      status: "completed",
      source: "live",
    })
    storage.upsertSession({
      sessionId: "mock-session",
      startedAt: 2000,
      status: "failed",
      source: "mock",
      scenario: "error_case",
    })

    storage.saveRequestEvent({
      requestId: "live-request",
      sessionId: "live-session",
      traceId: "trace-live",
      routeType: "messages",
      method: "POST",
      path: "/v1/messages",
      stream: false,
      requestStartedAt: 1010,
      statusCode: 200,
      source: "live",
    })
    storage.saveRequestEvent({
      requestId: "mock-request",
      sessionId: "mock-session",
      traceId: "trace-mock",
      routeType: "responses",
      method: "POST",
      path: "/v1/responses",
      stream: true,
      requestStartedAt: 2010,
      statusCode: 500,
      errorType: "upstream_error",
      source: "mock",
    })

    expect(storage.getSession("mock-session")).toMatchObject({
      sessionId: "mock-session",
      source: "mock",
      scenario: "error_case",
    })
    expect(storage.getRequestEvent("mock-request")).toMatchObject({
      requestId: "mock-request",
      source: "mock",
    })

    const resetResult = storage.resetMockData()
    expect(resetResult).toEqual({
      deletedSessions: 1,
      deletedRequestEvents: 1,
      deletedArtifacts: 0,
    })

    expect(storage.getSession("mock-session")).toBeNull()
    expect(storage.getRequestEvent("mock-request")).toBeNull()
    expect(storage.getSession("live-session")).not.toBeNull()
    expect(storage.getRequestEvent("live-request")).not.toBeNull()
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})

test("stores analysis facts and returns them in session detail", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  try {
    storage.upsertSession({
      sessionId: "session-facts",
      startedAt: 1000,
      status: "completed",
    })

    storage.saveRequestEvent({
      requestId: "request-facts-1",
      sessionId: "session-facts",
      traceId: "trace-facts-1",
      routeType: "messages",
      method: "POST",
      path: "/v1/messages",
      stream: false,
      requestStartedAt: 1010,
      requestFinishedAt: 1020,
      statusCode: 200,
    })

    storage.saveAnalysisFacts([
      {
        sessionId: "session-facts",
        requestId: "request-facts-1",
        factType: "retry_after_answer",
        factValue: {
          nextRequestId: "request-facts-2",
          gapMs: 2200,
        },
        factScore: 0.7,
        source: "live",
        createdAt: 1030,
      },
      {
        sessionId: "session-facts",
        requestId: null,
        factType: "user_correction_signal",
        factValue: {
          matchedPhrase: "try again",
        },
        factScore: 0.9,
        source: "live",
        createdAt: 1040,
      },
    ])

    const detail = storage.getSessionDetail("session-facts")
    expect(detail).not.toBeNull()
    expect(detail?.analysisFacts).toEqual([
      {
        sessionId: "session-facts",
        requestId: "request-facts-1",
        factType: "retry_after_answer",
        factValue: {
          nextRequestId: "request-facts-2",
          gapMs: 2200,
        },
        factScore: 0.7,
        source: "live",
        createdAt: 1030,
      },
      {
        sessionId: "session-facts",
        requestId: null,
        factType: "user_correction_signal",
        factValue: {
          matchedPhrase: "try again",
        },
        factScore: 0.9,
        source: "live",
        createdAt: 1040,
      },
    ])
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})
