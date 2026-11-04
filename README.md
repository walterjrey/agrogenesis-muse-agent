# AgroGenesis Muse Agent

An autonomous farm manager powered by the **Meta Model API (Muse)**, built for the Meta Global AI Developer Hackathon 2026 (October 26 – November 4, 2026).

- **Live demo (AgroGenesis simulator):** <https://agrogenesis.fly.dev>
- **Demo video (3 minutes):** `TODO: add the video URL here before submission` *(placeholder, no video is stored in this repository)*

> **What is new and what is not.** The **AgroGenesis agricultural simulator predates the hackathon** (baseline tag `pre-hackathon-2026` in the simulator repository, `docs/HACKATHON_BASELINE.md` there). It is **not** claimed as a hackathon contribution. **This repository contains only the agent developed during the hackathon**: the Meta Muse integration, the autonomous controller, tool calling, observation and planning logic, persistence, and the tests and benchmarks around them. No simulator code is included here; the agent talks to the simulator only through its authorized HTTP API.

Package: `agrogenesis-muse-agent` **v0.1.23** (`package.json`). The repository is `private` and is **not published to npm**; it is consumed from Git tags (latest tag `v0.1.23`, commit `0ea7590`). AgroGenesis pins it with `git+https://github.com/walterjrey/agrogenesis-muse-agent.git#<tag>`.

## What it does

In *Muse AI* mode, AgroGenesis lets a Muse model run the farm on its own: it looks at what it is **allowed to know**, decides what is justified, and acts through the simulator's API. The simulator stays the only authority over validation, resources and the clock; the agent can observe, request actions and *request* time.

### Architecture

| Capability | How it is implemented | Where |
| --- | --- | --- |
| **Meta Model API integration** | Provider over the OpenAI-compatible Chat Completions endpoint (`https://api.meta.ai/v1`), `muse-spark-1.3` / `muse-wonder-1.0`, timeouts, bounded retries, native tool calls, token usage, cost estimate | `src/model` |
| **Autonomous agent controller** | Resumable decision-cycle loop with a lifecycle (running, paused, recovering, stopped, completed), budgets and stop reasons | `src/autonomy/controller.ts`, `docs/AUTONOMOUS_AGENT.md` |
| **Structured tool calling** | Muse chooses every action through tools such as `observe_snapshot`, `list_available_actions`, `describe_action`, `execute_action`, `plan_field_actions`, `wait_for_operation`, `wait_for_checkpoint`, `update_plan`, `get_action_status`, `get_recent_events`. Tool arguments are untrusted JSON and validated with zod | `src/autonomy/tools.ts`, `docs/MUSE_TOOL_CALLING.md` |
| **Partial observability** | The simulator client rejects any payload with undeclared (possibly ground-truth) fields. Water stress, pest pressure and crop health are not given for free: the agent only has what an inspection delivered | `src/simulator`, `src/contracts` |
| **Field inspections** | `inspectField` costs credits and simulated time and returns soil moisture, fertility, crop condition and infestation for a whole field. A separate inspection budget applies. Inspections of several due fields are started in one turn and their readings delivered together | `src/autonomy/tools.ts` |
| **Observation freshness** | Each reading has an age and validity window. A field whose reading is still valid (nothing changed since) is not paid for twice; expired, aged or invalidated readings are allowed again | `src/autonomy/freshness.ts` |
| **Multi-action planning** | One `plan_field_actions` call queues every justified irrigation and pest treatment for one or several fields from the same observation | `src/autonomy/planning.ts` |
| **Irrigation quantity calculation** | Muse decides *whether* to irrigate; the runtime computes the volume (target moisture minus observed moisture, times the field's soil capacity), splitting it into several simulator operations if needed, never padded | `src/autonomy/planning.ts` |
| **Pest treatment** | Refused below the pest threshold or when no observation newer than the last treatment exists | `src/autonomy/planning.ts`, `src/autonomy/riskLedger.ts` |
| **Persistent action queue** | Queued items survive simulated days and restarts and are executed by a queue runner through the idempotent mutation journal | `src/autonomy/actionQueue.ts`, `queueRunner.ts` |
| **Resource accounting** | Each queue item is checked with the simulator's dry run (eligibility and cost) before submission. Consumed water, fuel and credits are read from the completed action | `src/autonomy/planning.ts`, `economics.ts` |
| **Cost limits** | Meta spend guard (per request and per session, USD), maximum model calls (including a hard lifetime cap), tool calls, mutations, inspections and simulated time | `src/model/spendGuard.ts`, `src/autonomy/types.ts` |
| **Daily review scheduler** | One review per simulated day plus bounded event-driven reviews (alerts, crop ready, completed operations), so the model is not called on every tick | `src/autonomy/dailyScheduler.ts`, `riskLedger.ts` |
| **Session persistence and resume** | State in `state.json` (CLI) or PostgreSQL (`PostgresSessionStore`, fenced leases). Every state-changing request is journaled before sending and replayed with the same idempotency key after a crash | `src/autonomy/store.ts`, `postgresStore.ts` |
| **Worker** | Long sessions run in a background worker, never inside an HTTP request | `src/worker.ts`, `docs/LIBRARY.md` |
| **Decision timeline** | The AgroGenesis app stores and shows the agent's per-review decisions, actions and observations. This repository records each decision, plan and action in session state, which the app reads | `src/autonomy/report.ts`, AgroGenesis repository |
| **Logging** | Structured JSONL logs with secret redaction | `src/logging` |

## Demonstrated with the real Meta Muse API

All results below come from the **real Meta Model API** (`muse-spark-1.3`) driving a **real AgroGenesis simulator** on an isolated local PostgreSQL database. Nothing touched production data.

**1. Observation → planning → irrigation + pest treatment (v0.1.16 integration test).** An isolated field was prepared with both a meaningful soil-water deficit and pest pressure. Using a hard lifetime cap of 10 model calls and the existing session cost limit:

- Muse authorized and performed **one** inspection of the field (soil moisture 0.197, pest pressure 0.42).
- From that single observation it identified **both** problems and made **one** `plan_field_actions` call with both justified interventions.
- The persistent queue held the irrigation and the pest treatment. Irrigation was **calculated (about 953 m³ in total)** and split into eight chained queue items of roughly 119 m³ per day, instead of the earlier fixed ~101 m³. The first item consumed 118.9 m³ of water and 16.89 credits; the pest treatment cost 33.75 credits. Consumed water and costs were recorded from the simulator's completed actions.
- **No second inspection** was made and **no operation ran twice**.
- Total model use: **10 of 10 calls, about $0.088**.

This was a single focused run, performed once. Its session was transient and is not stored in the repository, so it is reported here as a measured result, not as a reproducible fixture. A later regression test of the same scenario against the real API has not been re-run for each subsequent release (v0.1.17–v0.1.23).

**2. Paired benchmark against a deterministic baseline (Phase 5B).** One 200-simulated-day run on seed 3303: Muse completed the full horizon with 130 model calls, about $0.88 and no limit reached, and earned less than the scripted baseline (cash delta +1631 vs +2516 credits). Muse performed no inspections, irrigation or pest treatment in that run (the planning and queue features did not exist yet). It is a single sample and supports **no** claim of superiority in either direction. See [docs/BENCHMARK_RESULTS.md](docs/BENCHMARK_RESULTS.md).

**3. Live deployment.** The agent runs as a background worker (Fly.io) against the live demo at <https://agrogenesis.fly.dev>. Behaviour there is subject to the limitations below.

## Real API tests vs. mocked tests

| Kind | What it is | How to run | Evidence of |
| --- | --- | --- | --- |
| **Automated test suite** (`npm test`) | Deterministic and **mocked**: hand-written fixtures and local HTTP servers stand in for the simulator and the Meta API, plus a timed mock simulator for the scheduler. ~320 tests | `npm test` | Contract validation, leak rejection, retries, spend limits, redaction, scheduler, queue, freshness, planning, idempotency, crash recovery. **Not** evidence of real integration |
| **Live PostgreSQL tests** | Run only when `DATABASE_URL` is set (otherwise skipped); simulator and model are still mocked | `DATABASE_URL=… npm test` | Real storage and lease behaviour |
| **Real Meta API** | `npm run model:ping` sends a trivial prompt and prints usage and cost | needs `MODEL_API_KEY` | Real Meta connectivity |
| **Real simulator read-only check** | `npm run integration:real` validates real endpoints against the contracts; never acts | needs simulator URL and token | Real contract compatibility |
| **Real end-to-end runs** | `npm run agent:autonomous` against an isolated game (see the section above and the benchmark) | needs both credentials | Actual Muse behaviour |

## Installation and configuration

Requires Node.js ≥ 20.12.

```bash
npm install
cp .env.example .env   # fill in values; .env is git-ignored. Never commit it.
```

Main variables (see `.env.example` for all of them):

| Variable | Purpose |
| --- | --- |
| `MODEL_API_KEY` | Meta Model API key. Server-side only |
| `MODEL_ID` | `muse-spark-1.3` (default) or `muse-wonder-1.0`. `*-contributor` models are deliberately unsupported (they allow training on your data) |
| `MODEL_MAX_COST_PER_REQUEST_USD`, `MODEL_MAX_SESSION_COST_USD` | Spend limits, estimated from published prices ([pricing](https://dev.meta.ai/docs/pricing-rate-limits)). The autonomous briefs may need a per-request cap above the $0.05 default (the docs used $0.10) |
| `MODEL_TIMEOUT_MS`, `MODEL_MAX_ATTEMPTS`, `MODEL_REQUEST_DEADLINE_MS` | Timeout and bounded retries |
| `SIMULATOR_BASE_URL`, `SIMULATOR_AGENT_TOKEN`, `SIMULATOR_GAME_ID` | Simulator API and a scoped per-game agent token (not an administrator password) |

## Commands

All scripts are from `package.json`.

```bash
npm run typecheck          # tsc --noEmit
npm run lint               # eslint .
npm test                   # vitest run (mocked/deterministic suite)
npm run build              # tsc -p tsconfig.build.json

npm run model:ping         # real Meta API call
npm run integration:real   # real simulator, read-only
npm run agent:observe      # observe only
npm run agent:autonomous -- --game-id <id> --enable-mutations --max-cost-usd N --max-mutations N --max-sim-seconds N --max-model-calls N
npm run agent:resume -- --session-id <id> --enable-mutations
npm run agent:status -- --session-id <id> --decisions
npm run baseline:start     # deterministic (no model) baseline
npm run benchmark:verify-pair
npm run benchmark:outcome
```

Mutations are off by default. Enabling them requires an explicit game, a `muse_ai` game, `observe`/`act`/`advance` scopes and explicit cost, mutation, simulated-time and model-call limits. Resume never raises budgets.

Under load, slow scheduler tests can exceed Vitest's default 5 s timeout. If so, use `npx vitest run --testTimeout 60000`.

### Using it as a library

AgroGenesis embeds the agent as a dependency and runs it in a worker. See [docs/LIBRARY.md](docs/LIBRARY.md).

## Known limitations

This is a hackathon prototype. We list these openly:

- **Long-running autonomy is not yet consistently reliable.** Short, focused scenarios work with the real API; multi-week runs have stalled or paused on simulator timeouts and lifecycle edge cases. Several fixes were released (v0.1.17–v0.1.19 and later), but we have not demonstrated stable unattended operation over a full crop cycle.
- **Agent execution can be slow.** Each Muse model call takes tens of seconds and one review can take 1–3 minutes, so reaching full crop development can take hours of real time. The simulator itself is fast (about 100 simulated days in a few seconds). Cadence tuning (fewer reviews, a settle window after acting, batched inspections) has not been benchmarked before and after.
- **Farm operating expenses can exceed manual management.** Inspections and model-driven operations add cost; in the one paired benchmark, Muse earned less than the baseline.
- **Economic optimization remains experimental.** The agent has no crop-profit model: crop choice, timing and selling are left to the model with only the information the simulator exposes.
- **Not production-ready.** Reported results are single runs, not statistically significant, and the Fly.io Docker builds of the app were not verified locally. Only the behaviours listed under "Demonstrated" were verified.

## Documentation

- [Autonomous agent (controller, budgets, sessions)](docs/AUTONOMOUS_AGENT.md)
- [Muse tool calling](docs/MUSE_TOOL_CALLING.md)
- [Using the agent as a library](docs/LIBRARY.md)
- [Simulator integration proposal](docs/SIMULATOR_INTEGRATION.md) and [simulator audit](docs/SIMULATOR_AUDIT.md)
- [Planning policy](docs/PHASE5C_PLANNING_POLICY.md), [economic reasoning](docs/ECONOMIC_REASONING.md), [crop lifecycle](docs/CROP_LIFECYCLE.md), [agricultural progress](docs/AGRICULTURAL_PROGRESS.md)
- [Benchmark foundation](docs/BENCHMARK_FOUNDATION.md), [results](docs/BENCHMARK_RESULTS.md), [decision audit](docs/BENCHMARK_DECISION_AUDIT.md)
- [Render deployment notes](docs/RENDER_DEPLOYMENT.md)

Some of these documents describe earlier phases and may not reflect every later change; this README and the code are authoritative.

Meta Model API docs: <https://dev.meta.ai/docs/overview>, [tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling). Constraints honored: base URL `https://api.meta.ai/v1`, `max_completion_tokens`, only `tool_choice: "auto"`, tool arguments validated as untrusted JSON.

## Security

Credentials stay server-side, are never written to session state, and are redacted from logs. Do not import this package from client code.
