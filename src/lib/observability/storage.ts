import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

import {
  buildArtifactPaths,
  normalizeSessionUpsert,
  sessionIsPinned,
  type SessionUpsertInput,
  type StoredSessionRecord,
} from "./session"
import type {
  ObservabilityRawReference,
  RequestEventRecord,
} from "./types"

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

interface ResolvedStoragePaths {
  dbPath: string
  rawDir: string
  pinnedDir: string
}

const DEFAULT_TIME = () => Date.now()

const resolvePaths = (options: ObservabilityStorageOptions): ResolvedStoragePaths => {
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

const fromJson = <T>(value: string | null | undefined): T | null => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as T
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
): ObservabilityRawReference | null => fromJson<ObservabilityRawReference>(value)

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
  `)

  const insertOrUpdateSession = db.prepare(`
    INSERT INTO sessions (
      session_id,
      root_trace_id,
      user_id,
      client_type,
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

  const storage = {
    upsertSession(input: SessionUpsertInput): StoredSessionRecord {
      const now = input.updatedAt ?? DEFAULT_TIME()
      const session = normalizeSessionUpsert(input, now)

      insertOrUpdateSession.run({
        $sessionId: session.sessionId,
        $rootTraceId: session.rootTraceId,
        $userId: session.userId,
        $clientType: session.clientType,
        $startedAt: session.startedAt,
        $endedAt: session.endedAt,
        $status: session.status,
        $pinned: session.pinned ? 1 : 0,
        $pinnedAt: session.pinnedAt,
        $updatedAt: session.updatedAt,
      })

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
      })

      return event
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
      const { sourcePath, pinnedPath } = buildArtifactPaths(
        paths.rawDir,
        paths.pinnedDir,
        input.sessionId,
        input.requestId,
        input.kind,
      )
      const targetPath = sessionPinned ? pinnedPath : sourcePath

      writeBodyFile(targetPath, input.body)

      const reference: ObservabilityRawReference =
        input.kind === "request"
          ? { bodyPath: targetPath, pinned: sessionPinned }
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
      })

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
      })

      const artifacts = listSessionArtifactsStatement.all({
        $sessionId: sessionId,
      }) as RawArtifactRecord[]

      for (const artifact of artifacts) {
        if (artifact.pinned) {
          continue
        }

        if (!fs.existsSync(artifact.sourcePath)) {
          continue
        }

        const { pinnedPath } = buildArtifactPaths(
          paths.rawDir,
          paths.pinnedDir,
          sessionId,
          artifact.requestId,
          artifact.kind,
        )
        copyBodyFile(artifact.sourcePath, pinnedPath)
        setArtifactPinnedStatement.run({
          $requestId: artifact.requestId,
          $kind: artifact.kind,
          $pinnedPath: pinnedPath,
          $updatedAt: pinnedAt,
        })
      }

      return true
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
      }) as RawArtifactRecord[]
      for (const artifact of expiredArtifacts) {
        const session = storage.getSession(artifact.sessionId)
        if (artifact.pinned || sessionIsPinned(session ?? { updatedAt: 0 })) {
          continue
        }

        if (fs.existsSync(artifact.sourcePath)) {
          fs.rmSync(artifact.sourcePath, { force: true })
        }

        if (artifact.pinnedPath && artifact.pinnedPath !== artifact.sourcePath) {
          if (fs.existsSync(artifact.pinnedPath)) {
            fs.rmSync(artifact.pinnedPath, { force: true })
          }
        }

        deleteRawArtifactStatement.run({
          $requestId: artifact.requestId,
          $kind: artifact.kind,
        })
        result.deletedArtifacts++
      }

      const expiredRequestEvents = getExpiredEventsStatement.all({
        $cutoff: cutoff,
      }) as Array<{ requestId: string; sessionId: string | null }>
      for (const event of expiredRequestEvents) {
        const session = event.sessionId ? storage.getSession(event.sessionId) : null
        if (sessionIsPinned(session ?? { updatedAt: 0 })) {
          continue
        }

        deleteRequestEventStatement.run({
          $requestId: event.requestId,
        })
        result.deletedRequestEvents++
      }

      const expiredSessions = getExpiredSessionsStatement.all({
        $cutoff: cutoff,
      }) as Array<{ sessionId: string; pinned: number; pinnedAt: number | null; updatedAt: number }>

      for (const session of expiredSessions) {
        if (session.pinned || session.pinnedAt) {
          continue
        }

        deleteSessionStatement.run({
          $sessionId: session.sessionId,
        })
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
