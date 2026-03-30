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

export interface BuildArtifactPathsInput {
  rawDir: string
  pinnedDir: string
  sessionId: string
  requestId: string
  kind: "request" | "response"
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
  value.replaceAll(/[^\w.-]+/g, "_")

export const buildArtifactPaths = (
  input: BuildArtifactPathsInput,
): ArtifactPaths => {
  const safeSessionId = sanitizePathSegment(input.sessionId)
  const safeRequestId = sanitizePathSegment(input.requestId)
  const fileName = `${safeRequestId}-${input.kind}.body`
  const relativePath = path.join(safeSessionId, fileName)

  return {
    sourcePath: path.join(input.rawDir, relativePath),
    pinnedPath: path.join(input.pinnedDir, relativePath),
  }
}
