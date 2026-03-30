import path from "node:path"

import type { SessionRecord } from "./types"

export interface StoredSessionRecord extends SessionRecord {
  pinnedAt: number | null
  updatedAt: number
}

export interface SessionUpsertInput
  extends Omit<SessionRecord, "pinned" | "startedAt"> {
  startedAt: number
  pinned?: boolean
  pinnedAt?: number | null
  updatedAt?: number
}

export interface ArtifactPaths {
  sourcePath: string
  pinnedPath: string
}

export const sessionIsPinned = (session: {
  pinned?: boolean | null
  pinnedAt?: number | null
}): boolean => Boolean(session.pinned || session.pinnedAt)

export const isSessionExpired = (
  session: {
    updatedAt: number
    pinned?: boolean | null
    pinnedAt?: number | null
  },
  cutoff: number,
): boolean => !sessionIsPinned(session) && session.updatedAt < cutoff

export const normalizeSessionUpsert = (
  input: SessionUpsertInput,
  now: number,
): StoredSessionRecord => ({
  sessionId: input.sessionId,
  rootTraceId: input.rootTraceId ?? null,
  userId: input.userId ?? null,
  clientType: input.clientType ?? null,
  startedAt: input.startedAt,
  endedAt: input.endedAt ?? null,
  status: input.status ?? "unknown",
  pinned: input.pinned ?? false,
  pinnedAt: input.pinnedAt ?? (input.pinned ? now : null),
  updatedAt: input.updatedAt ?? now,
})

export const sanitizePathSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "_")

export const buildArtifactPaths = (
  rawDir: string,
  pinnedDir: string,
  sessionId: string,
  requestId: string,
  kind: "request" | "response",
): ArtifactPaths => {
  const safeSessionId = sanitizePathSegment(sessionId)
  const safeRequestId = sanitizePathSegment(requestId)
  const fileName = `${safeRequestId}-${kind}.body`
  const relativePath = path.join(safeSessionId, fileName)

  return {
    sourcePath: path.join(rawDir, relativePath),
    pinnedPath: path.join(pinnedDir, relativePath),
  }
}
