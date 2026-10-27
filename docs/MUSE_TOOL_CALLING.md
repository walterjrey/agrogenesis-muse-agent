# Muse native tool calling (Phase 3A)

New code written during the hackathon, in this repository only. The AgroGenesis simulator is pre-existing; it is reached exclusively through its agent-safe HTTP API (`/api/agent/v1`).

## Model

| Setting | Value |
|---|---|
| Endpoint | `https://api.meta.ai/v1` (Chat Completions, OpenAI-compatible) |
| Default model | `muse-spark-1.3` |
| Optional | `muse-wonder-1.0` (set `MODEL_ID`) |
| Tool choice | `auto` only (the only value the API supports) |
| Output cap | `max_completion_tokens` |

No multi-model orchestration. Model ID is configuration, not code.

## Tools (`src/agent/tools.ts`)

Arguments are validated with strict Zod schemas (unknown fields rejected); JSON Schema sent to Muse is generated from the same schemas.

| Tool | Mutating | Simulator call |
|---|---|---|
| `observe_farm` | no | `GET /games/:id/overview` |
| `observe_fields` | no | `GET /games/:id/fields` |
| `list_available_actions` | no | `GET /games/:id/actions` |
| `get_action_status` | no | `GET /games/:id/actions/:actionId` |
| `get_recent_events` | no | `GET /games/:id/events` |
| `execute_action` | **yes** | `POST /games/:id/actions` |
| `advance_time` | **yes** | `POST /games/:id/clock/advance` |

The agent contains no agronomic validation. The simulator accepts or rejects actions; a rejection (HTTP 422) is returned to the model as a normal result and counted as an attempt.

## Request/response flow (`src/agent/runtime.ts`)

1. Send system prompt, brief and the tools allowed by the mode.
2. Receive native `tool_calls`.
3. For each call, serially: unknown tool → not exposed → per-step/total limits → JSON parse → Zod validation → mutating call must be alone in its step → policy → run.
4. Replay the full assistant message, then append one `role:"tool"` message per `tool_call_id` (required by the API).
5. Repeat until a final answer or a limit. On a limit, tools are removed and the model is asked for a final summary.

## Execution modes

- **Observe Only** (`npm run agent:observe`): mutating tools are not offered and are denied (`mutation_disabled`) if requested.
- **Controlled Mutation** (`npm run agent:test-action -- --enable-mutations --game-id <id>`): requires the flag, an explicit game id, a `muse_ai` game, and a token with `observe`, `act`, `advance`. Defaults: 1 accepted mutation, 3 attempts, 1800 s per advance, 3600 s total. No autonomous loop.

Server-side mode isolation still applies: Manual and Hybrid games reject agent writes (403 `mode_not_supported`).

## Revisions and idempotency

- The model cannot set `expectedRevision` or `idempotencyKey`. The runtime uses the revision of the latest observation and a fresh UUID per mutation, and sends `dryRun:false`.
- A mutation needs a prior observation; after any accepted mutation, advance, or conflict a new observation is required.
- Timeout/network/5xx: retried with the **same** key (up to 2 times). If unconfirmed → `outcome_unknown`, further mutations are locked for the run.
- HTTP 409 `stale_revision`: no retry; the latest overview and `currentRevision` are returned to the model, which must re-observe and decide again.

## Partial observability

Responses are parsed with strict contracts; a payload with extra (hidden) fields is withheld as `contract_violation` and never forwarded to the model or written to the trace. The agent has no database access, and snapshots, RNG state, and private data are not exposed by the agent API.

## Cost controls

Reuses the spend guard. Per-run defaults: 10 model calls, 4 tool calls per step, 20 total, 2048 output tokens, $0.10 per request, $0.25 total (CLI flags can only tighten the env limits). Totals report model ID, input/output/cached tokens, estimated USD, tool calls, mutations and advanced seconds.

## Audit trail

`logs/runs/<runId>.jsonl` (gitignored) records run start/end, model requests/responses with usage, tool requests/results, mutation submit/result/retry/conflict, and errors; plus `<runId>.summary.json`. Credentials are redacted; no chain-of-thought is recorded, only the model's visible text and the `rationale` it supplies.

## Environment

`MODEL_API_KEY` (in a gitignored `.env`), `MODEL_ID`, `SIMULATOR_BASE_URL`, `SIMULATOR_AGENT_TOKEN`, `SIMULATOR_GAME_ID`. See `.env.example`.

## Tests

`tests/agent/*.test.ts` are **mocked** (scripted model + fake HTTP simulator). They are not evidence of live Meta or simulator behavior. Live validation is performed by the CLI scripts against a real model and a local simulator; its results are below.

## Live validation results

Run on 2026-10-27 against a local simulator (Next dev, port 3100) with an isolated PostgreSQL database (`agrogenesis_phase3a`), a `muse_ai` test game (seed 12345, "established" scenario) and a dedicated 6-hour token with `observe,act,advance`. Real Meta API, model `muse-spark-1.3`.

| Check | Result |
|---|---|
| `npm run model:ping` | OK, 131 tokens, $0.0005 |
| `agent:observe` | OK: 3 model calls, 5 tool calls (`observe_farm`, `observe_fields`, `list_available_actions` x2, `get_recent_events`), 35,212 in / 2,663 out tokens (11,874 cached), ≈ $0.042. Muse chose to take no action (no fresh field/weather data) and proposed a drone survey. No mutation was offered. |
| `agent:test-action --enable-mutations` | OK: 7 model calls, 9 tool calls, 73,809 in / 2,299 out (35,268 cached), ≈ $0.063. Muse inspected, then selected `inspectField` on `field-1` (25 credits) on its own, then `get_action_status`, `observe_farm`, `advance_time` (10 s requested, 5 s granted, stopped on `action_completion`). |
| Independent verification | Simulator reports revision 3, sim time 5 s, credits 2475 (charged once), `act-0001` `inspectField` `completed`. |
| Secret scan of run logs | token and API key not present |

An earlier first observe run stopped safely on the per-request spend guard (`$0.0523 > $0.05`) because `list_available_actions` returns a large catalog (~9k tokens); the runs above used `MODEL_MAX_COST_PER_REQUEST_USD=0.10`.

Mocked suite: 35/35 tests pass (`npm test`; includes the HTTP 422 client regression). TypeScript, lint and build pass. These mocked tests are not live evidence.

### What the live runs confirmed

- **Real native tool calling:** `muse-spark-1.3` returned native `tool_calls` (including several in one step); the runtime executed them and replied with `role:"tool"` messages carrying the matching `tool_call_id`.
- **Real simulator integration:** every tool result came from the pre-existing simulator's `/api/agent/v1` API running on an isolated PostgreSQL database; the agent has no database access.
- **Autonomous selection:** no action was suggested in the prompt. In controlled-mutation mode Muse chose `inspectField` on `field-1` by itself, after observing that all field data was `never_observed`. In observe-only mode it chose to take no action.
- **Action completion and charge:** the simulator shows `act-0001` `inspectField` `completed`; credits went 2500 → 2475 (exactly 25, charged once).
- **Idempotency (live):** the simulator log shows one `POST /actions` (201) and one `POST /clock/advance` (200) in that run, each with a runtime-generated UUID key; no duplicate action or charge. Retry-with-same-key and `outcome_unknown` behavior was **not** triggered live; it is covered only by mocked tests.
- **Re-observation and time:** the runtime required a fresh observation after the accepted action; Muse then advanced 10 s requested / 5 s granted (stopped on `action_completion`), well within the 1800 s / 3600 s limits.
- **Estimated cost:** ≈ $0.042 (observe) + ≈ $0.063 (controlled mutation), plus ≈ $0.0005 ping, estimated from published per-token prices.

Sanitized trace (events only): `run.start` → `model.request/response` → `tool.request`/`tool.result` ×4 → `mutation.submit/result` (`execute_action`) → `tool.request` ×3 (`get_action_status`, `observe_farm`) → `mutation.submit/result` (`advance_time`) → `model.response` (final) → `run.end`.

## Known limitations

This is a bounded, single-run tool-calling demonstration, **not** a fully autonomous farm manager.

- **Phase 3B issue — mixed revisions:** observation tools are called separately, so one model decision can combine overview, field, and action-catalog data from different game revisions. The runtime guards mutations with the revision of the latest observation and the simulator rejects stale ones (409), but the model can still reason over a mixed-revision picture. Phase 3B should return a revision with every observation and have the model reconcile or re-fetch.
- No autonomous loop, scheduling, or long-term memory (Phase 3B).
- Only one real mutation scenario (`inspectField`) was demonstrated live; production crop management was not exercised.
- Pricing is estimated from published prices.
- `list_available_actions` returns a large catalog (~9k tokens); results are capped at 60,000 characters and per-request spend is limited (raise `MODEL_MAX_COST_PER_REQUEST_USD` to 0.10 for these runs).
- Live retry/timeout recovery has not been exercised against the real simulator.
