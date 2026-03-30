# Agent Observability Design

## Summary

This document proposes a local observability system for `copilot-api` focused on:

- user and session behavior analysis
- prompt and agent quality analysis
- cost and quota analysis as secondary dimensions
- performance and stability analysis as secondary dimensions

The system must preserve or improve the proxy's existing request forwarding performance. It is therefore designed as a sidecar-style observation layer inside the same process, with minimal synchronous work on the request path and all heavier processing delegated to asynchronous background workers.

## Goals

- Provide a useful local analytics system for a single power user first.
- Keep the design extensible for future multi-user dashboards.
- Support request-level and session-level analysis, with session analysis as the primary unit.
- Default to sanitized and summarized storage.
- Retain raw request and response bodies for the most recent 3 days only.
- Allow manual pinning for permanent retention of selected sessions or requests.
- Avoid regressions in proxy latency, throughput, and memory behavior.

## Non-Goals

- Replacing GitHub's upstream quota APIs.
- Building a multi-tenant auth or billing system in the first iteration.
- Performing semantic correctness evaluation of coding outputs in the MVP.
- Adding synchronous external SaaS tracing or analytics calls on the request path.
- Building a real-time distributed telemetry stack in the MVP.

## Current Project Context

The current project already has several building blocks that make this feasible:

- request entry points for `messages`, `responses`, and `chat.completions`
- route-local logging in handler-specific files
- request-scoped `trace_id` storage via async local storage
- deterministic request and session identifiers
- usage data from GitHub's upstream `copilot_internal/user` endpoint

What it does not have yet is a dedicated local analytics model. Existing logs are useful for debugging but not sufficient for structured analysis.

## Existing External Building Blocks

There are already general-purpose LLM and agent observability tools worth aligning with:

- OpenTelemetry GenAI and agent span conventions
- Langfuse tracing and prompt management
- Arize Phoenix tracing and evaluation workflows

These are useful as reference points for field naming and future interoperability, but they do not directly solve this repository's core requirement: a local, low-overhead, coding-agent-oriented observability layer attached to this Bun proxy without degrading request performance.

## Design Principles

### 1. Observability is a side path, not part of the core request path

The proxy must continue to prioritize request translation and forwarding. Observability code may observe request lifecycle events, but must not block model requests on storage, redaction, summarization, aggregation, or scoring.

### 2. Facts and inferences must be separated

Raw measurable facts such as latency, token usage, retries, and tool counts must be stored independently from derived quality judgments such as "wasted request" or "low-efficiency tool path".

### 3. Session-first analysis, request-grounded storage

The primary product experience is session analysis. The primary source-of-truth event unit is still the concrete HTTP request. Session views are built by grouping lower-level events.

### 4. Default-safe data retention

The default storage mode is sanitized summaries plus metadata. Raw request and response bodies are retained for 3 days unless explicitly pinned for permanent retention.

### 5. Graceful degradation under pressure

When the observability queue or worker falls behind, the system must degrade by dropping detail before it drops core request forwarding.

## Product Scope

### Primary systems

- Session behavior analytics
- Prompt and agent quality analytics

### Secondary systems

- Cost and quota analytics
- Performance and stability analytics

## Candidate Product Directions Considered

### Approach A: Behavior-first analytics

This approach focuses on session completion, abandonment, retries, tool paths, and user interruption behavior.

Pros:

- fastest path to useful insights
- highly aligned with single-user agent workflows
- low semantic ambiguity

Cons:

- prompt quality analysis is indirect

### Approach B: Quality-first analytics

This approach prioritizes prompt template comparisons, tool selection quality, retry-after-answer analysis, and agent path quality.

Pros:

- directly useful for prompt and agent optimization

Cons:

- requires stronger inference rules earlier
- harder to make reliable in MVP

### Approach C: Dual-layer analytics

This approach uses one shared event pipeline and exposes two top-level perspectives:

- behavior analysis
- quality analysis

Cost and performance are supporting dimensions.

Pros:

- best long-term structure
- avoids rework
- matches the project's stated goals

Cons:

- must be disciplined to stay MVP-sized

### Recommendation

Use Approach C, implemented in a behavior-first order. The shared event model should support both behavior and quality analysis from the start, but the first release should favor reliable behavior and efficiency signals over fragile semantic scoring.

## Core Data Model

The MVP should start with three persisted entities and a derived facts layer.

### `session`

Represents a work session as the primary analysis unit.

Key fields:

- `session_id`
- `root_trace_id`
- `user_id` or anonymous principal
- `client_type`
- `started_at`
- `ended_at`
- `status`
- `pinned`

Optional derived fields:

- `session_effectiveness_score`
- `final_outcome_label`

### `request_event`

Represents a concrete inbound proxy request.

Key fields:

- `request_id`
- `session_id`
- `trace_id`
- `route_type`
- `model`
- `stream`
- `request_started_at`
- `first_token_at`
- `request_finished_at`
- `status_code`
- `error_type`
- `input_tokens`
- `output_tokens`
- `cached_tokens`
- `reasoning_tokens`
- `raw_payload_ref`
- `sanitized_payload`
- `sanitized_response`

### `tool_event`

Represents a concrete tool invocation or tool call chain.

Key fields:

- `tool_event_id`
- `session_id`
- `request_id`
- `tool_name`
- `tool_type`
- `arguments_summary`
- `started_at`
- `finished_at`
- `success`
- `retry_of`
- `output_summary`
- `is_redundant_call`
- `is_recovery_call`

### `analysis_fact`

Derived metrics for fast read paths.

Example fields:

- `wasted_token_ratio`
- `detour_ratio`
- `first_useful_output_ms`
- `retry_after_answer_rate`
- `user_correction_rate`
- `redundant_tool_call_rate`
- `high_reasoning_low_outcome_rate`

## Why Turn-Level Modeling Is Deferred

A dedicated `turn` entity is useful, but not required for the MVP. The current proxy already has strong request boundaries and recoverable session linkage. Request-level capture plus session-level grouping is sufficient for the first release. `turn` can be introduced later as a derived view or promoted entity if request clustering logic matures.

## Data Retention Model

### Default retention

- structured metadata: retained until explicitly pruned
- sanitized payload and response summaries: retained by default
- raw bodies: retained for 3 days

### Permanent retention

- selected sessions or requests may be manually pinned
- pinned raw artifacts are moved or copied into long-term storage

### Storage split

- SQLite for structured events and aggregated facts
- short-term raw body files for 3-day retention
- long-term pinned artifact directory for permanent retention

## Analytics Surfaces

### 1. Session behavior analytics

Questions answered:

- Which session types finish successfully?
- Which sessions are abandoned, interrupted, or retried?
- Which task categories consume the most requests or tools?
- Where do users most often take over manually?
- Which sessions appear to involve repeated or wasted work?

Core metrics:

- completion rate
- abandonment rate
- average requests per session
- average tools per session
- interruption rate
- repeated-session pattern rate

### 2. Prompt and agent quality analytics

Questions answered:

- Which prompt patterns trigger retries or corrections?
- Which agent paths over-explore before acting?
- Which tools are selected redundantly?
- Which requests incur high reasoning cost without good outcomes?
- Which outputs lead to immediate follow-up corrections?

Core metrics:

- retry-after-answer rate
- user correction rate
- redundant tool call rate
- over-exploration rate
- high-reasoning low-outcome rate
- completion-without-followup rate

### 3. Cost and quota analytics

Questions answered:

- Which task types cost the most?
- How much cost is associated with abandoned or failed sessions?
- Where is prompt cache helping?
- What is the token and premium cost of a successful session?

Core metrics:

- tokens per completed session
- wasted token ratio
- cached token ratio
- premium-associated request distribution

### 4. Performance and stability analytics

Questions answered:

- Which routes or models have the worst tail latency?
- How long until first useful output, not merely first token?
- Which streams terminate early or fail mid-flight?
- Which tools introduce major delays?

Core metrics:

- latency p50/p95/p99
- time to first byte
- time to first useful output
- stream failure rate
- tool latency distribution

## Metric Layers

### Layer 1: facts

Examples:

- latency
- token counts
- request counts
- tool call counts
- retries
- compact events
- model switches
- status codes

### Layer 2: derived efficiency metrics

Examples:

- token throughput
- cache benefit ratio
- reasoning cost ratio
- cost per successful session
- detour ratio
- wasted token ratio

### Layer 3: quality signals

Examples:

- `user_correction_signal`
- `redundant_tool_signal`
- `over_exploration_signal`
- `high_reasoning_low_outcome_signal`
- `manual_takeover_signal`
- `strong_completion_signal`

### Layer 4: explainable scores

The MVP may expose scores, but only as explainable composites:

- `session_effectiveness_score`
- `agent_efficiency_score`
- `prompt_stability_score`
- `overall_quality_score`

Each score must be traceable back to contributing facts and signals.

## MVP Scope

The MVP should answer four questions:

1. Which sessions finish, and which do not?
2. Which agent paths are visibly wasteful or repetitive?
3. Which tools are used redundantly?
4. Where do token cost and latency accumulate?

### In scope

- lightweight capture on the request path
- async worker processing
- SQLite structured storage
- 3-day raw retention
- manual pinning hooks
- session overview
- session detail view
- quality diagnostics
- cost and latency side views

### Out of scope

- model-graded semantic correctness scoring
- vector search over all history
- full multi-tenant permissions
- distributed queue infrastructure
- live streaming dashboard updates
- third-party SaaS dependency on the critical path

## Architecture

The implementation should be decomposed into six modules.

### `capture`

Synchronous, request-path-safe instrumentation.

Responsibilities:

- create minimal event shells
- record request lifecycle timings
- enqueue lightweight events

Must not perform:

- redaction
- summarization
- storage
- scoring

### `event-queue`

In-process bounded queue used to decouple request forwarding from analytics processing.

Requirements:

- bounded capacity
- batch consumption
- pressure-aware degradation
- dropped event counters

### `processor`

Asynchronous event pipeline.

Stages:

- normalize
- redact
- summarize
- extract
- score
- persist

### `storage`

Persistence layer for structured and raw artifacts.

Targets:

- SQLite database for events and facts
- short-term raw storage
- long-term pinned storage

### `analysis`

Computes online facts and scheduled aggregations for dashboard APIs.

### `viewer/api`

Read-only analytics and inspection endpoints for:

- upstream GitHub quota data
- local observability summaries
- per-session detail
- per-request detail

## Performance Constraints

This is a hard requirement for implementation.

### Request-path budget

- additional synchronous overhead target: `p50 < 1ms`
- additional synchronous overhead target: `p95 < 3ms`

### Stream handling

- no deep per-chunk processing
- only lightweight counters on the chunk path
- response assembly and analysis only after stream completion or failure

### Queue degradation behavior

Under pressure:

1. drop detailed body capture first
2. keep minimal structured events
3. continue request forwarding regardless

### Storage behavior

- no synchronous SQLite writes on the request path
- no synchronous raw body file writes on the request path
- batch persistence only

### Memory control

The system must enforce:

- per-request body capture limits
- per-stream buffer limits
- per-session pending event limits
- queue backlog limits

## Existing Performance Opportunity

The current code already performs some payload serialization for debugging. A structured observability pipeline can reduce repeated stringification and duplicated logging work, especially in verbose scenarios. This creates a realistic path to "no regression" and potentially slight improvement under some operating modes.

## Validation and Benchmarking

The implementation is not complete unless benchmarked.

Minimum validation:

- compare observability off vs on
- benchmark `messages`, `responses`, and `chat.completions`
- benchmark both streaming and non-streaming routes
- inspect:
  - RPS
  - p50/p95/p99 latency
  - memory RSS
  - event loop lag
  - GC behavior
  - queue backlog
  - dropped event counts

## Recommended Documentation Set

After this design is accepted, the implementation phase should create:

- `docs/observability-data-model.md`
- `docs/observability-mvp-plan.md`
- `docs/observability-benchmarks.md`

This current document serves as the top-level design entry point.

## Recommended Implementation Order

1. Add a minimal capture abstraction and bounded queue.
2. Persist only the smallest structured request facts.
3. Add raw body retention with expiry and pin support.
4. Add session aggregation.
5. Add rule-based quality signals.
6. Add local analytics endpoints and UI.
7. Add benchmark and regression checks.

## Risks

### 1. Hidden request-path overhead

Mitigation:

- keep request-path instrumentation extremely shallow
- benchmark before and after each phase

### 2. Memory growth under long streaming sessions

Mitigation:

- hard caps on buffers
- truncated capture behavior

### 3. Overly ambitious scoring logic

Mitigation:

- start with explicit rule-based signals
- defer semantic quality evaluation

### 4. Sensitive data retention risk

Mitigation:

- sanitize by default
- raw retention TTL of 3 days
- explicit pin workflow for permanent storage

### 5. Analysis sprawl

Mitigation:

- lock MVP to behavior and quality diagnostics first
- keep cost and performance as supporting views

## Decision Summary

The recommended path is:

- implement a local, side-path observability layer
- optimize for session behavior and prompt/agent quality analysis
- preserve request-path performance through async queue-based processing
- store sanitized metadata by default
- retain raw bodies for 3 days with manual permanent pinning
- align field naming where practical with emerging agent observability conventions

This design is intentionally local-first and performance-constrained so it fits the project's real operating conditions.
