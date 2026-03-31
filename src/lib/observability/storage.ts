/* eslint-disable max-lines, max-lines-per-function, complexity, @typescript-eslint/no-deprecated */
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

import type {
  AnalysisFactRecord,
  AnalysisFactValue,
  ObservabilityRawReference,
  RequestEventRecord,
} from "./types"

import {
  buildArtifactPaths,
  normalizeSessionUpsert,
  sessionIsPinned,
  type SessionUpsertInput,
  type StoredSessionRecord,
} from "./session"

export interface ObservabilityStorageOptions {
  baseDir?: string
  dbPath?: string
  rawDir?: string
  pinnedDir?: string
}

export interface RawBodyInput {
  requestId: string
  sessionId: string
  kind: "request" | "response"
  body: string | Uint8Array
  createdAt?: number
}

export interface StoredRequestEvent extends RequestEventRecord {
  rawReference: ObservabilityRawReference | null
  createdAt: number
  updatedAt: number
}

export interface RawArtifactRecord {
  requestId: string
  sessionId: string
  kind: "request" | "response"
  sourcePath: string
  pinnedPath: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface PurgeResult {
  deletedSessions: number
  deletedRequestEvents: number
  deletedArtifacts: number
}

export interface ObservabilitySummary {
  sessionCount: number
  requestCount: number
  pinnedSessionCount: number
  failedRequestCount: number
}

export interface SessionListItem extends StoredSessionRecord {
  requestCount: number
}

export interface SessionDetail {
  session: StoredSessionRecord
  requests: Array<StoredRequestEvent>
  analysisFacts: Array<AnalysisFactRecord>
}

interface ResolvedStoragePaths {
  dbPath: string
  rawDir: string
  pinnedDir: string
}

const DEFAULT_TIME = () => Date.now()

const resolvePaths = (
  options: ObservabilityStorageOptions,
): ResolvedStoragePaths => {
  if (options.baseDir) {
    const observabilityDir = path.join(options.baseDir, "observability")
    return {
      dbPath: options.dbPath ?? path.join(observabilityDir, "events.db"),
      rawDir: options.rawDir ?? path.join(observabilityDir, "raw"),
      pinnedDir: options.pinnedDir ?? path.join(observabilityDir, "pinned"),
    }
  }

  return {
    dbPath: options.dbPath ?? PATHS.OBSERVABILITY_DB_PATH,
    rawDir: options.rawDir ?? PATHS.OBSERVABILITY_RAW_DIR,
    pinnedDir: options.pinnedDir ?? PATHS.OBSERVABILITY_PINNED_DIR,
  }
}

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true })
}

const fromJson = (value: string | null | undefined): unknown => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const toBoolean = (value: unknown): boolean => value === 1 || value === true

const serializeRawReference = (
  reference: ObservabilityRawReference | null,
): string | null => {
  if (!reference) {
    return null
  }

  return JSON.stringify(reference)
}

const deserializeRawReference = (
  value: string | null | undefined,
): ObservabilityRawReference | null =>
  fromJson(value) as ObservabilityRawReference | null

const serializeFactValue = (
  value: AnalysisFactValue | undefined,
): string | null => {
  if (value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

const deserializeFactValue = (
  value: string | null | undefined,
): AnalysisFactValue => fromJson(value) as AnalysisFactValue

const readRawReferencePath = (
  reference: ObservabilityRawReference,
): string | null => {
  if (reference.bodyPath) {
    return reference.bodyPath
  }

  if (reference.responsePath) {
    return reference.responsePath
  }

  return null
}

const writeBodyFile = (filePath: string, body: string | Uint8Array): void => {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, body)
}

const copyBodyFile = (sourcePath: string, destinationPath: string): void => {
  ensureDir(path.dirname(destinationPath))
  fs.copyFileSync(sourcePath, destinationPath)
}

export function createObservabilityStorage(
  options: ObservabilityStorageOptions = {},
) {
  const paths = resolvePaths(options)
  ensureDir(path.dirname(paths.dbPath))
  ensureDir(paths.rawDir)
  ensureDir(paths.pinnedDir)

  const db = new Database(paths.dbPath)
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      root_trace_id TEXT,
      user_id TEXT,
      client_type TEXT,
      source TEXT NOT NULL DEFAULT 'live',
      scenario TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'unknown',
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_events (
      request_id TEXT PRIMARY KEY,
      session_id TEXT,
      trace_id TEXT NOT NULL,
      route_type TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      source TEXT NOT NULL DEFAULT 'live',
      stream INTEGER NOT NULL,
      request_started_at INTEGER NOT NULL,
      first_token_at INTEGER,
      request_finished_at INTEGER,
      status_code INTEGER,
      error_type TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      reasoning_tokens INTEGER,
      request_body_size INTEGER,
      response_body_size INTEGER,
      sanitized_payload TEXT,
      sanitized_response TEXT,
      raw_reference_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS raw_artifacts (
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('request', 'response')),
      source_path TEXT NOT NULL,
      pinned_path TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, kind),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analysis_facts (
      session_id TEXT NOT NULL,
      request_id TEXT,
      fact_type TEXT NOT NULL,
      fact_value_json TEXT,
      fact_score REAL,
      source TEXT NOT NULL DEFAULT 'live',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, request_id, fact_type),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(request_id) REFERENCES request_events(request_id) ON DELETE CASCADE
    );
  `)

  const ensureColumn = (
    tableName: "sessions" | "request_events",
    columnName: string,
    columnDefinition: string,
  ): void => {
    const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string
    }>
    if (columns.some((column) => column.name === columnName)) return
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`)
  }

  ensureColumn("sessions", "source", "source TEXT NOT NULL DEFAULT 'live'")
  ensureColumn("sessions", "scenario", "scenario TEXT")
  ensureColumn(
    "request_events",
    "source",
    "source TEXT NOT NULL DEFAULT 'live'",
  )

  const insertOrUpdateSession = db.prepare(`
    INSERT INTO sessions (
      session_id,
      root_trace_id,
      user_id,
      client_type,
      source,
      scenario,
      started_at,
      ended_at,
      status,
      pinned,
      pinned_at,
      updated_at
    ) VALUES (
      $sessionId,
      $rootTraceId,
      $userId,
      $clientType,
      $source,
      $scenario,
      $startedAt,
      $endedAt,
      $status,
      $pinned,
      $pinnedAt,
      $updatedAt
    )
    ON CONFLICT(session_id) DO UPDATE SET
      root_trace_id = excluded.root_trace_id,
      user_id = excluded.user_id,
      client_type = excluded.client_type,
      source = excluded.source,
      scenario = excluded.scenario,
      started_at = excluded.started_at,
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      status = excluded.status,
      pinned = MAX(sessions.pinned, excluded.pinned),
      pinned_at = COALESCE(sessions.pinned_at, excluded.pinned_at),
      updated_at = excluded.updated_at
  `)

  const upsertRequestEvent = db.prepare(`
    INSERT INTO request_events (
      request_id,
      session_id,
      trace_id,
      route_type,
      method,
      path,
      model,
      source,
      stream,
      request_started_at,
      first_token_at,
      request_finished_at,
      status_code,
      error_type,
      input_tokens,
      output_tokens,
      cached_tokens,
      reasoning_tokens,
      request_body_size,
      response_body_size,
      sanitized_payload,
      sanitized_response,
      raw_reference_json,
      created_at,
      updated_at
    ) VALUES (
      $requestId,
      $sessionId,
      $traceId,
      $routeType,
      $method,
      $path,
      $model,
      $source,
      $stream,
      $requestStartedAt,
      $firstTokenAt,
      $requestFinishedAt,
      $statusCode,
      $errorType,
      $inputTokens,
      $outputTokens,
      $cachedTokens,
      $reasoningTokens,
      $requestBodySize,
      $responseBodySize,
      $sanitizedPayload,
      $sanitizedResponse,
      $rawReferenceJson,
      $createdAt,
      $updatedAt
    )
    ON CONFLICT(request_id) DO UPDATE SET
      session_id = excluded.session_id,
      trace_id = excluded.trace_id,
      route_type = excluded.route_type,
      method = excluded.method,
      path = excluded.path,
      model = excluded.model,
      source = excluded.source,
      stream = excluded.stream,
      request_started_at = excluded.request_started_at,
      first_token_at = excluded.first_token_at,
      request_finished_at = excluded.request_finished_at,
      status_code = excluded.status_code,
      error_type = excluded.error_type,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cached_tokens = excluded.cached_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      request_body_size = excluded.request_body_size,
      response_body_size = excluded.response_body_size,
      sanitized_payload = excluded.sanitized_payload,
      sanitized_response = excluded.sanitized_response,
      raw_reference_json = excluded.raw_reference_json,
      updated_at = excluded.updated_at
  `)

  const upsertRawArtifact = db.prepare(`
    INSERT INTO raw_artifacts (
      request_id,
      session_id,
      kind,
      source_path,
      pinned_path,
      pinned,
      created_at,
      updated_at
    ) VALUES (
      $requestId,
      $sessionId,
      $kind,
      $sourcePath,
      $pinnedPath,
      $pinned,
      $createdAt,
      $updatedAt
    )
    ON CONFLICT(request_id, kind) DO UPDATE SET
      session_id = excluded.session_id,
      source_path = excluded.source_path,
      pinned_path = excluded.pinned_path,
      pinned = excluded.pinned,
      updated_at = excluded.updated_at
  `)

  const getSessionStatement = db.prepare(`
    SELECT
      session_id AS sessionId,
      root_trace_id AS rootTraceId,
      user_id AS userId,
      client_type AS clientType,
      source,
      scenario,
      started_at AS startedAt,
      ended_at AS endedAt,
      status,
      pinned,
      pinned_at AS pinnedAt,
      updated_at AS updatedAt
    FROM sessions
    WHERE session_id = $sessionId
  `)

  const getRequestEventStatement = db.prepare(`
    SELECT
      request_id AS requestId,
      session_id AS sessionId,
      trace_id AS traceId,
      route_type AS routeType,
      method,
      path,
      model,
      source,
      stream,
      request_started_at AS requestStartedAt,
      first_token_at AS firstTokenAt,
      request_finished_at AS requestFinishedAt,
      status_code AS statusCode,
      error_type AS errorType,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cached_tokens AS cachedTokens,
      reasoning_tokens AS reasoningTokens,
      request_body_size AS requestBodySize,
      response_body_size AS responseBodySize,
      sanitized_payload AS sanitizedPayload,
      sanitized_response AS sanitizedResponse,
      raw_reference_json AS rawReferenceJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM request_events
    WHERE request_id = $requestId
  `)

  const getRawArtifactStatement = db.prepare(`
    SELECT
      request_id AS requestId,
      session_id AS sessionId,
      kind,
      source_path AS sourcePath,
      pinned_path AS pinnedPath,
      pinned,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM raw_artifacts
    WHERE request_id = $requestId AND kind = $kind
  `)

  const listSessionArtifactsStatement = db.prepare(`
    SELECT
      request_id AS requestId,
      session_id AS sessionId,
      kind,
      source_path AS sourcePath,
      pinned_path AS pinnedPath,
      pinned,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM raw_artifacts
    WHERE session_id = $sessionId
    ORDER BY created_at ASC
  `)

  const getExpiredSessionsStatement = db.prepare(`
    SELECT
      session_id AS sessionId,
      pinned,
      pinned_at AS pinnedAt,
      updated_at AS updatedAt
    FROM sessions
    WHERE updated_at < $cutoff
  `)

  const getExpiredEventsStatement = db.prepare(`
    SELECT request_id AS requestId, session_id AS sessionId
    FROM request_events
    WHERE updated_at < $cutoff
  `)

  const getExpiredArtifactsStatement = db.prepare(`
    SELECT
      request_id AS requestId,
      session_id AS sessionId,
      kind,
      source_path AS sourcePath,
      pinned_path AS pinnedPath,
      pinned,
      updated_at AS updatedAt
    FROM raw_artifacts
    WHERE updated_at < $cutoff
  `)

  const deleteSessionStatement = db.prepare(`
    DELETE FROM sessions WHERE session_id = $sessionId
  `)

  const deleteRequestEventStatement = db.prepare(`
    DELETE FROM request_events WHERE request_id = $requestId
  `)

  const deleteRawArtifactStatement = db.prepare(`
    DELETE FROM raw_artifacts WHERE request_id = $requestId AND kind = $kind
  `)

  const getMockSessionIdsStatement = db.prepare(`
    SELECT session_id AS sessionId
    FROM sessions
    WHERE source = 'mock'
  `)

  const getMockRequestIdsStatement = db.prepare(`
    SELECT request_id AS requestId, session_id AS sessionId
    FROM request_events
    WHERE source = 'mock'
  `)

  const setSessionPinnedStatement = db.prepare(`
    UPDATE sessions
    SET pinned = 1,
        pinned_at = $pinnedAt,
        updated_at = $updatedAt
    WHERE session_id = $sessionId
  `)

  const setArtifactPinnedStatement = db.prepare(`
    UPDATE raw_artifacts
    SET pinned = 1,
        pinned_path = $pinnedPath,
        updated_at = $updatedAt
    WHERE request_id = $requestId AND kind = $kind
  `)

  const clearSessionPinnedStatement = db.prepare(`
    UPDATE sessions
    SET pinned = 0,
        pinned_at = NULL,
        updated_at = $updatedAt
    WHERE session_id = $sessionId
  `)

  const clearArtifactPinnedStatement = db.prepare(`
    UPDATE raw_artifacts
    SET pinned = 0,
        updated_at = $updatedAt
    WHERE request_id = $requestId AND kind = $kind
  `)

  const listSessionsStatement = db.prepare(`
    SELECT
      s.session_id AS sessionId,
      s.root_trace_id AS rootTraceId,
      s.user_id AS userId,
      s.client_type AS clientType,
      s.source,
      s.scenario,
      s.started_at AS startedAt,
      s.ended_at AS endedAt,
      s.status,
      s.pinned,
      s.pinned_at AS pinnedAt,
      s.updated_at AS updatedAt,
      COUNT(r.request_id) AS requestCount
    FROM sessions s
    LEFT JOIN request_events r ON r.session_id = s.session_id
    GROUP BY s.session_id
    ORDER BY s.updated_at DESC
    LIMIT $limit OFFSET $offset
  `)

  const listRequestsBySessionStatement = db.prepare(`
    SELECT
      request_id AS requestId,
      session_id AS sessionId,
      trace_id AS traceId,
      route_type AS routeType,
      method,
      path,
      model,
      source,
      stream,
      request_started_at AS requestStartedAt,
      first_token_at AS firstTokenAt,
      request_finished_at AS requestFinishedAt,
      status_code AS statusCode,
      error_type AS errorType,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cached_tokens AS cachedTokens,
      reasoning_tokens AS reasoningTokens,
      request_body_size AS requestBodySize,
      response_body_size AS responseBodySize,
      sanitized_payload AS sanitizedPayload,
      sanitized_response AS sanitizedResponse,
      raw_reference_json AS rawReferenceJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM request_events
    WHERE session_id = $sessionId
    ORDER BY request_started_at ASC
  `)

  const insertOrReplaceAnalysisFact = db.prepare(`
    INSERT OR REPLACE INTO analysis_facts (
      session_id,
      request_id,
      fact_type,
      fact_value_json,
      fact_score,
      source,
      created_at
    ) VALUES (
      $sessionId,
      $requestId,
      $factType,
      $factValueJson,
      $factScore,
      $source,
      $createdAt
    )
  `)

  const listAnalysisFactsBySessionStatement = db.prepare(`
    SELECT
      session_id AS sessionId,
      request_id AS requestId,
      fact_type AS factType,
      fact_value_json AS factValueJson,
      fact_score AS factScore,
      source,
      created_at AS createdAt
    FROM analysis_facts
    WHERE session_id = $sessionId
    ORDER BY created_at ASC, fact_type ASC
  `)

  const deleteAnalysisFactsBySessionStatement = db.prepare(`
    DELETE FROM analysis_facts
    WHERE session_id = $sessionId
  `)

  const summaryStatement = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) AS sessionCount,
      (SELECT COUNT(*) FROM request_events) AS requestCount,
      (SELECT COUNT(*) FROM sessions WHERE pinned = 1) AS pinnedSessionCount,
      (SELECT COUNT(*) FROM request_events WHERE error_type IS NOT NULL OR status_code >= 400) AS failedRequestCount
  `)

  const storage = {
    upsertSession(input: SessionUpsertInput): StoredSessionRecord {
      const now = input.updatedAt ?? DEFAULT_TIME()
      const session = normalizeSessionUpsert(input, now)

      insertOrUpdateSession.run({
        $sessionId: session.sessionId,
        $rootTraceId: session.rootTraceId,
        $userId: session.userId,
        $clientType: session.clientType,
        $source: session.source ?? "live",
        $scenario: session.scenario ?? null,
        $startedAt: session.startedAt,
        $endedAt: session.endedAt,
        $status: session.status,
        $pinned: session.pinned ? 1 : 0,
        $pinnedAt: session.pinnedAt,
        $updatedAt: session.updatedAt,
      } as never)

      return session
    },

    getSession(sessionId: string): StoredSessionRecord | null {
      const row = getSessionStatement.get({ $sessionId: sessionId }) as
        | StoredSessionRecord
        | undefined

      if (!row) {
        return null
      }

      return {
        ...row,
        pinned: toBoolean(row.pinned),
        pinnedAt: row.pinnedAt ?? null,
      }
    },

    saveRequestEvent(
      input: RequestEventRecord,
      options: { createdAt?: number; updatedAt?: number } = {},
    ): StoredRequestEvent {
      const createdAt = options.createdAt ?? DEFAULT_TIME()
      const updatedAt = options.updatedAt ?? createdAt
      const event: StoredRequestEvent = {
        ...input,
        source: input.source ?? "live",
        rawReference: input.rawReference ?? null,
        createdAt,
        updatedAt,
      }

      upsertRequestEvent.run({
        $requestId: event.requestId,
        $sessionId: event.sessionId ?? null,
        $traceId: event.traceId,
        $routeType: event.routeType,
        $method: event.method,
        $path: event.path,
        $model: event.model ?? null,
        $source: event.source ?? "live",
        $stream: event.stream ? 1 : 0,
        $requestStartedAt: event.requestStartedAt,
        $firstTokenAt: event.firstTokenAt ?? null,
        $requestFinishedAt: event.requestFinishedAt ?? null,
        $statusCode: event.statusCode ?? null,
        $errorType: event.errorType ?? null,
        $inputTokens: event.inputTokens ?? null,
        $outputTokens: event.outputTokens ?? null,
        $cachedTokens: event.cachedTokens ?? null,
        $reasoningTokens: event.reasoningTokens ?? null,
        $requestBodySize: event.requestBodySize ?? null,
        $responseBodySize: event.responseBodySize ?? null,
        $sanitizedPayload: event.sanitizedPayload ?? null,
        $sanitizedResponse: event.sanitizedResponse ?? null,
        $rawReferenceJson: serializeRawReference(event.rawReference),
        $createdAt: event.createdAt,
        $updatedAt: event.updatedAt,
      } as never)

      return event
    },

    saveAnalysisFacts(
      facts: Array<AnalysisFactRecord>,
    ): Array<AnalysisFactRecord> {
      for (const fact of facts) {
        insertOrReplaceAnalysisFact.run({
          $sessionId: fact.sessionId,
          $requestId: fact.requestId ?? null,
          $factType: fact.factType,
          $factValueJson: serializeFactValue(fact.factValue),
          $factScore: fact.factScore ?? null,
          $source: fact.source ?? "live",
          $createdAt: fact.createdAt,
        } as never)
      }

      return facts.map((fact) => ({
        ...fact,
        requestId: fact.requestId ?? null,
        source: fact.source ?? "live",
      }))
    },

    replaceSessionAnalysisFacts(
      sessionId: string,
      facts: Array<AnalysisFactRecord>,
    ): Array<AnalysisFactRecord> {
      deleteAnalysisFactsBySessionStatement.run({
        $sessionId: sessionId,
      } as never)
      return storage.saveAnalysisFacts(facts)
    },

    listAnalysisFactsBySession(sessionId: string): Array<AnalysisFactRecord> {
      const rows = listAnalysisFactsBySessionStatement.all({
        $sessionId: sessionId,
      }) as Array<
        Omit<AnalysisFactRecord, "factValue"> & {
          factValueJson: string | null
        }
      >

      return rows.map((row) => ({
        sessionId: row.sessionId,
        requestId: row.requestId ?? null,
        factType: row.factType,
        factScore: row.factScore ?? null,
        source: row.source ?? "live",
        createdAt: row.createdAt,
        factValue: deserializeFactValue(row.factValueJson),
      }))
    },

    getRequestEvent(requestId: string): StoredRequestEvent | null {
      const row = getRequestEventStatement.get({ $requestId: requestId }) as
        | (Omit<StoredRequestEvent, "rawReference"> & {
            rawReferenceJson: string | null
          })
        | undefined

      if (!row) {
        return null
      }

      return {
        ...row,
        stream: toBoolean(row.stream),
        rawReference: deserializeRawReference(row.rawReferenceJson),
      }
    },

    writeRawBody(input: RawBodyInput): ObservabilityRawReference {
      const session = storage.getSession(input.sessionId)
      const sessionPinned = session ? sessionIsPinned(session) : false
      const { sourcePath, pinnedPath } = buildArtifactPaths({
        rawDir: paths.rawDir,
        pinnedDir: paths.pinnedDir,
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: input.kind,
      })
      const targetPath = sessionPinned ? pinnedPath : sourcePath

      writeBodyFile(targetPath, input.body)

      const reference: ObservabilityRawReference =
        input.kind === "request" ?
          { bodyPath: targetPath, pinned: sessionPinned }
        : { responsePath: targetPath, pinned: sessionPinned }

      upsertRawArtifact.run({
        $requestId: input.requestId,
        $sessionId: input.sessionId,
        $kind: input.kind,
        $sourcePath: targetPath,
        $pinnedPath: sessionPinned ? targetPath : null,
        $pinned: sessionPinned ? 1 : 0,
        $createdAt: input.createdAt ?? DEFAULT_TIME(),
        $updatedAt: input.createdAt ?? DEFAULT_TIME(),
      } as never)

      return reference
    },

    readRawBody(reference: ObservabilityRawReference | null): string | null {
      if (!reference) {
        return null
      }

      const filePath = readRawReferencePath(reference)
      if (!filePath) {
        return null
      }

      if (!fs.existsSync(filePath)) {
        return null
      }

      return fs.readFileSync(filePath, "utf8")
    },

    getRawArtifact(
      requestId: string,
      kind: "request" | "response",
    ): RawArtifactRecord | null {
      const row = getRawArtifactStatement.get({
        $requestId: requestId,
        $kind: kind,
      }) as RawArtifactRecord | undefined

      if (!row) {
        return null
      }

      return {
        ...row,
        pinned: toBoolean(row.pinned),
      }
    },

    pinSession(sessionId: string, pinnedAt: number = DEFAULT_TIME()): boolean {
      const session = storage.getSession(sessionId)
      if (!session) {
        return false
      }

      setSessionPinnedStatement.run({
        $sessionId: sessionId,
        $pinnedAt: pinnedAt,
        $updatedAt: pinnedAt,
      } as never)

      const artifacts = listSessionArtifactsStatement.all({
        $sessionId: sessionId,
      }) as Array<RawArtifactRecord>

      for (const artifact of artifacts) {
        if (artifact.pinned) {
          continue
        }

        if (!fs.existsSync(artifact.sourcePath)) {
          continue
        }

        const { pinnedPath } = buildArtifactPaths({
          rawDir: paths.rawDir,
          pinnedDir: paths.pinnedDir,
          sessionId: sessionId,
          requestId: artifact.requestId,
          kind: artifact.kind,
        })
        copyBodyFile(artifact.sourcePath, pinnedPath)
        setArtifactPinnedStatement.run({
          $requestId: artifact.requestId,
          $kind: artifact.kind,
          $pinnedPath: pinnedPath,
          $updatedAt: pinnedAt,
        } as never)
      }

      return true
    },

    unpinSession(
      sessionId: string,
      updatedAt: number = DEFAULT_TIME(),
    ): boolean {
      const session = storage.getSession(sessionId)
      if (!session) {
        return false
      }

      clearSessionPinnedStatement.run({
        $sessionId: sessionId,
        $updatedAt: updatedAt,
      } as never)

      const artifacts = listSessionArtifactsStatement.all({
        $sessionId: sessionId,
      }) as Array<RawArtifactRecord>
      for (const artifact of artifacts) {
        clearArtifactPinnedStatement.run({
          $requestId: artifact.requestId,
          $kind: artifact.kind,
          $updatedAt: updatedAt,
        } as never)
      }

      return true
    },

    resetMockData(): PurgeResult {
      const result: PurgeResult = {
        deletedSessions: 0,
        deletedRequestEvents: 0,
        deletedArtifacts: 0,
      }

      const mockRequestIds = getMockRequestIdsStatement.all() as Array<{
        requestId: string
        sessionId: string | null
      }>
      for (const request of mockRequestIds) {
        deleteRequestEventStatement.run({
          $requestId: request.requestId,
        } as never)
        result.deletedRequestEvents++
      }

      const mockSessionIds = getMockSessionIdsStatement.all() as Array<{
        sessionId: string
      }>
      for (const session of mockSessionIds) {
        const artifacts = listSessionArtifactsStatement.all({
          $sessionId: session.sessionId,
        }) as Array<RawArtifactRecord>
        for (const artifact of artifacts) {
          if (fs.existsSync(artifact.sourcePath)) {
            fs.rmSync(artifact.sourcePath, { force: true })
          }
          if (
            artifact.pinnedPath
            && artifact.pinnedPath !== artifact.sourcePath
            && fs.existsSync(artifact.pinnedPath)
          ) {
            fs.rmSync(artifact.pinnedPath, { force: true })
          }
          deleteRawArtifactStatement.run({
            $requestId: artifact.requestId,
            $kind: artifact.kind,
          } as never)
          result.deletedArtifacts++
        }

        deleteSessionStatement.run({
          $sessionId: session.sessionId,
        } as never)
        result.deletedSessions++
      }

      return result
    },

    clearMockData(): PurgeResult {
      return storage.resetMockData()
    },

    setSessionPinned(sessionId: string, pinned: boolean): boolean {
      return pinned ?
          storage.pinSession(sessionId)
        : storage.unpinSession(sessionId)
    },

    listSessions(
      options: { limit?: number; offset?: number } = {},
    ): Array<SessionListItem> {
      const rows = listSessionsStatement.all({
        $limit: options.limit ?? 50,
        $offset: options.offset ?? 0,
      }) as Array<SessionListItem>

      return rows.map((row) => ({
        ...row,
        pinned: toBoolean(row.pinned),
      }))
    },

    getSessionDetail(sessionId: string): SessionDetail | null {
      const session = storage.getSession(sessionId)
      if (!session) {
        return null
      }

      const rows = listRequestsBySessionStatement.all({
        $sessionId: sessionId,
      }) as Array<
        Omit<StoredRequestEvent, "rawReference"> & {
          rawReferenceJson: string | null
        }
      >

      return {
        session,
        requests: rows.map((row) => ({
          ...row,
          stream: toBoolean(row.stream),
          rawReference: deserializeRawReference(row.rawReferenceJson),
        })),
        analysisFacts: storage.listAnalysisFactsBySession(sessionId),
      }
    },

    getSummary(): ObservabilitySummary {
      const row = summaryStatement.get() as ObservabilitySummary | undefined
      return (
        row ?? {
          sessionCount: 0,
          requestCount: 0,
          pinnedSessionCount: 0,
          failedRequestCount: 0,
        }
      )
    },

    purgeExpired({
      ttlMs,
      now = DEFAULT_TIME(),
    }: {
      ttlMs: number
      now?: number
    }): PurgeResult {
      const cutoff = now - ttlMs
      const result: PurgeResult = {
        deletedSessions: 0,
        deletedRequestEvents: 0,
        deletedArtifacts: 0,
      }

      const expiredArtifacts = getExpiredArtifactsStatement.all({
        $cutoff: cutoff,
      }) as Array<RawArtifactRecord>
      for (const artifact of expiredArtifacts) {
        const session = storage.getSession(artifact.sessionId)
        const sessionProbe = session ?? { pinned: false, pinnedAt: null }
        if (artifact.pinned || sessionIsPinned(sessionProbe)) {
          continue
        }

        if (fs.existsSync(artifact.sourcePath)) {
          fs.rmSync(artifact.sourcePath, { force: true })
        }

        if (
          artifact.pinnedPath
          && artifact.pinnedPath !== artifact.sourcePath
          && fs.existsSync(artifact.pinnedPath)
        ) {
          fs.rmSync(artifact.pinnedPath, { force: true })
        }

        deleteRawArtifactStatement.run({
          $requestId: artifact.requestId,
          $kind: artifact.kind,
        } as never)
        result.deletedArtifacts++
      }

      const expiredRequestEvents = getExpiredEventsStatement.all({
        $cutoff: cutoff,
      }) as Array<{ requestId: string; sessionId: string | null }>
      for (const event of expiredRequestEvents) {
        const session =
          event.sessionId ? storage.getSession(event.sessionId) : null
        const sessionProbe = session ?? { pinned: false, pinnedAt: null }
        if (sessionIsPinned(sessionProbe)) {
          continue
        }

        deleteRequestEventStatement.run({
          $requestId: event.requestId,
        } as never)
        result.deletedRequestEvents++
      }

      const expiredSessions = getExpiredSessionsStatement.all({
        $cutoff: cutoff,
      }) as Array<{
        sessionId: string
        pinned: number
        pinnedAt: number | null
        updatedAt: number
      }>

      for (const session of expiredSessions) {
        if (session.pinned || session.pinnedAt) {
          continue
        }

        deleteSessionStatement.run({
          $sessionId: session.sessionId,
        } as never)
        result.deletedSessions++
      }

      return result
    },

    close(): void {
      db.close()
    },
  }

  return storage
}
