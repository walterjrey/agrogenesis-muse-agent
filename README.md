# AgroGenesis Muse Agent

> **The AgroGenesis agricultural simulator predates the hackathon. This repository contains the newly developed Meta-powered autonomous agent and its integration components. The simulator itself is not claimed as a hackathon contribution.**

Submission for the Meta Global AI Developer Hackathon 2026 (October 26 – November 4, 2026).

## Background

**AgroGenesis** is a 3D agricultural simulator (Next.js, TypeScript, Three.js, PostgreSQL) with weather, soil, crops, livestock, machinery, drones/rovers, an economy, and a management framework with partial observability. It lives in a separate repository and was developed before the event (baseline tag `pre-hackathon-2026`, see its `docs/HACKATHON_BASELINE.md`). Muse AI / Hybrid modes existed there only as disabled placeholders.

## What this repository contains

Built during the hackathon window, with no simulator code copied:

- **Integration contracts** (`src/contracts`): strict zod schemas for farm overview, field observations (age, confidence, uncertainty, missing data), available actions, action execution (async), events and requested time advance.
- **Simulator client** (`src/simulator`): bearer-token HTTP client that validates every response, rejects payloads containing undeclared (possibly ground-truth) fields, times out, and defaults actions to dry-run.
- **Meta Model API adapter** (`src/model`): provider abstraction over the OpenAI-compatible Chat Completions endpoint (`https://api.meta.ai/v1`), configurable model id (`muse-spark-1.3`, `muse-wonder-1.0`), timeouts, retries, native tool-call passthrough, token usage, cost estimate and spend limits.
- **Structured JSONL logging** with secret redaction (`src/logging`).
- Docs: [simulator audit](docs/SIMULATOR_AUDIT.md), [integration proposal](docs/SIMULATOR_INTEGRATION.md).

## How it talks to the simulator

Server-to-server HTTP under `/api/agent/v1` with a scoped per-game bearer token. The simulator remains the only authority for validation, resource accounting and the clock; the agent can only observe, request actions and *request* time. Details in [docs/SIMULATOR_INTEGRATION.md](docs/SIMULATOR_INTEGRATION.md).

## Status

| Item | Status |
| --- | --- |
| Contracts, simulator client, Meta adapter, logging, spend guard | Implemented, covered by **mocked** tests |
| Real Meta Model API connectivity | Implemented as `npm run model:ping`; requires your `MODEL_API_KEY` and has to be run by you |
| Simulator agent endpoints + token auth | **Not implemented** – required changes in the simulator repo (see integration doc) |
| Real simulator integration run | **Not yet possible** until those endpoints exist; `npm run integration:real` is ready |
| Tool definitions for Muse, agent loop, autonomous farm management | **Planned**, not implemented |
| Evaluation / Manual vs Muse comparison | **Planned**, not implemented |

## Setup

Requires Node.js ≥ 20.12.

> **Using this as a library** (for example from AgroGenesis): see [docs/LIBRARY.md](docs/LIBRARY.md).

```bash
npm install
cp .env.example .env   # then fill in values; .env is git-ignored
```

### Meta Model API

Set `MODEL_API_KEY` (from the Meta Model API dashboard), and optionally `MODEL_ID` (`muse-spark-1.3` default, or `muse-wonder-1.0`), timeouts and spend limits (`MODEL_MAX_COST_PER_REQUEST_USD`, `MODEL_MAX_SESSION_COST_USD`). Keep the key server-side only. Contributor-mode models (`*-contributor`) are deliberately not supported because they allow training on your data. Costs are estimates from published Standard-mode prices ([pricing](https://dev.meta.ai/docs/pricing-rate-limits)).

```bash
npm run model:ping   # real call: sends a trivial prompt and prints usage and estimated cost
```

## Tests

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All automated tests are **mocked/contract tests**: they use hand-written fixtures and local HTTP servers that stand in for the simulator and Meta API. They verify contract validation, leak rejection, error handling, spend limits and redaction. They are not evidence of a working real integration.

## Reproducing the real simulator integration

Once the simulator exposes the agent API and an administrator issues a token with the `observe` scope:

```bash
# .env: SIMULATOR_BASE_URL, SIMULATOR_AGENT_TOKEN, optionally SIMULATOR_GAME_ID
npm run integration:real
```

It lists authorized games, selects one, reads overview, field observations and eligible actions, validates them against the contracts and logs the outcome to `logs/integration.jsonl`. It never executes actions or advances time.

## References

Meta Model API docs: <https://dev.meta.ai/docs/overview>, [tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling). Documented constraints honored here: base URL `https://api.meta.ai/v1`, `MODEL_API_KEY`, `max_completion_tokens`, only `tool_choice: "auto"`, tool arguments are untrusted JSON strings that must be validated.
