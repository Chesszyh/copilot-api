# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common development commands

- Install deps: `bun install`
- Dev server (watch): `bun run dev`
- Start server (prod mode): `bun run start`
- Build CLI dist: `bun run build`
- Lint changed scope: `bun run lint`
- Lint whole repo: `bun run lint:all`
- Lint & fix staged files (pre-commit hook): `bunx lint-staged`
- Typecheck: `bun run typecheck`
- Dead code / unused export check: `bun run knip`
- Run all tests: `bun test`
- Run one test file: `bun test tests/anthropic-request.test.ts`

CI (`.github/workflows/ci.yml`) runs this exact verification sequence:

1. `bun run lint:all`
2. `bun run typecheck`
3. `bun test`
4. `bun run build`

Useful local CLI entrypoints from source:

- `bun run ./src/main.ts start`
- `bun run ./src/main.ts auth`
- `bun run ./src/main.ts check-usage`
- `bun run ./src/main.ts debug --json`


## High-level architecture

### 1) CLI startup and process lifecycle

- `src/main.ts` parses global options (`--api-home`, `--oauth-app`, `--enterprise-url`) **before** dynamic imports, then dispatches `start`, `auth`, `check-usage`, `debug`.
- `src/start.ts` is the runtime bootstrap:
  - merges/creates config (`src/lib/config.ts`),
  - initializes optional proxy env,
  - applies runtime flags into global state (`src/lib/state.ts`),
  - ensures token/config/observability paths (`src/lib/paths.ts`),
  - initializes observability lifecycle,
  - resolves GitHub/Copilot tokens and model catalog,
  - starts Hono server via `src/server.ts`.

### 2) HTTP server and middleware layering

- `src/server.ts` constructs a single Hono app with:
  - trace propagation (`src/lib/trace.ts` + async context in `src/lib/request-context.ts`),
  - request logging,
  - CORS,
  - API-key auth middleware (`src/lib/request-auth.ts`).
- Auth behavior is config-driven (`config.auth.apiKeys`): when empty, API is open; when set, all non-whitelisted paths require `x-api-key` or `Authorization: Bearer`.
- Error normalization is centralized in `src/lib/error.ts`.

### 3) Route families and translation pipeline

Server exposes OpenAI-compatible, Anthropic-compatible, and provider-scoped routes.

#### OpenAI-compatible routes

- `/v1/chat/completions` (`src/routes/chat-completions/*`)
- `/v1/responses` (`src/routes/responses/*`)
- `/v1/models` (`src/routes/models/route.ts`)
- `/v1/embeddings` (`src/routes/embeddings/route.ts`)

#### Anthropic-compatible routes

- `/v1/messages` and `/v1/messages/count_tokens` (`src/routes/messages/*`)

`src/routes/messages/handler.ts` is the key decision point:

1. Parse/normalize Anthropic payload (+ subagent marker parsing).
2. Resolve model capabilities from cached catalog.
3. Route by model support/config:
   - native Copilot Messages API (`src/services/copilot/create-messages.ts`), or
   - Copilot Responses API with Anthropic↔Responses translation (`src/routes/messages/responses-translation.ts`, `responses-stream-translation.ts`), or
   - fallback Chat Completions with Anthropic↔OpenAI translation (`non-stream-translation.ts`, `stream-translation.ts`).

This is where premium-usage optimizations and initiator/session header shaping are applied (`x-initiator`, compact handling, warmup small-model redirection).

### 4) Provider pass-through (multi-provider Anthropic proxy)

- `/:provider/v1/messages`
- `/:provider/v1/messages/count_tokens`
- `/:provider/v1/models`

Implemented in `src/routes/provider/**` + `src/services/providers/anthropic-proxy.ts`, backed by `config.providers.<name>`. Supports per-model defaults (`temperature/top_p/top_k`) and optional input-token adjustment.

### 5) Tokens, models, config, and persistence

- Token lifecycle (`src/lib/token.ts`):
  - GitHub device auth flow,
  - Copilot token fetch + refresh loop.
- Model catalog (`src/services/copilot/get-models.ts`) cached in process state.
- Persistent app home from `COPILOT_API_HOME` or default `~/.local/share/copilot-api` (`src/lib/paths.ts`):
  - `config.json`
  - token file
  - observability DB/raw artifacts

### 6) Observability subsystem

Core modules are under `src/lib/observability/`:

- capture hooks (`capture.ts`) record request lifecycle from handlers,
- bounded priority queue (`queue.ts`),
- periodic worker flush (`worker.ts`),
- storage (`storage.ts`) in Bun SQLite + raw request/response artifacts,
- redaction (`redact.ts`) before persistence.

Routes/UI:

- `/observability/summary`
- `/observability/sessions` and `/observability/sessions/:sessionId`
- `/observability/pin/:sessionId`
- `/observability/mock/*` (guarded by debugMockEnabled)
- `/observability-viewer` (HTML from `pages/observability-viewer.html`)

## Repository structure notes

- `src/routes/**`: HTTP boundary and protocol translation.
- `src/services/copilot/**`, `src/services/github/**`: upstream API clients.
- `pages/**`: static web UIs (usage viewer + observability viewer).
- `tests/**`: protocol translation, request auth, observability storage/routes, and mock generation coverage.
- `claude-plugin/` and `.opencode/plugins/`: subagent marker/plugin integration assets.

## Instruction files discovered

- Repo has `AGENTS.md` with command/style notes.
- No `.cursorrules`, `.cursor/rules/`, or `.github/copilot-instructions.md` found at this time.
