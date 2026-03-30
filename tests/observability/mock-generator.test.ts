import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { generateObservabilityMockData } from "../../src/lib/observability/mock"
import { createObservabilityStorage } from "../../src/lib/observability/storage"

const createTempDir = async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "observability-generator-"),
  )
  return dir
}

test("coverage preset generates mock sessions and requests", async () => {
  const baseDir = await createTempDir()
  const storage = createObservabilityStorage({ baseDir })

  try {
    const result = generateObservabilityMockData(storage, {
      preset: "coverage",
      count: 2,
      seed: 7,
    })

    expect(result.generatedSessions).toBe(2)
    expect(result.generatedRequests).toBeGreaterThan(0)
    expect(result.preset).toBe("coverage")

    const sessions = storage.listSessions({ limit: 10 })
    expect(sessions).toHaveLength(2)
    expect(sessions.every((session) => session.source === "mock")).toBe(true)
    expect(sessions.some((session) => session.scenario !== null)).toBe(true)
  } finally {
    storage.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})
