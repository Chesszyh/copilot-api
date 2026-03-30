import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")
const APP_DIR = process.env.COPILOT_API_HOME || DEFAULT_DIR

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
const CONFIG_PATH = path.join(APP_DIR, "config.json")
const OBSERVABILITY_DIR = path.join(APP_DIR, "observability")
const OBSERVABILITY_RAW_DIR = path.join(OBSERVABILITY_DIR, "raw")
const OBSERVABILITY_PINNED_DIR = path.join(OBSERVABILITY_DIR, "pinned")
const OBSERVABILITY_DB_PATH = path.join(OBSERVABILITY_DIR, "events.db")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
  OBSERVABILITY_DIR,
  OBSERVABILITY_RAW_DIR,
  OBSERVABILITY_PINNED_DIR,
  OBSERVABILITY_DB_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(path.join(PATHS.APP_DIR, AUTH_APP), { recursive: true })
  await fs.mkdir(PATHS.OBSERVABILITY_RAW_DIR, { recursive: true })
  await fs.mkdir(PATHS.OBSERVABILITY_PINNED_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
