# Using the agent as a library

`agrogenesis-muse-agent` can run as a dependency of a Node server (for example AgroGenesis on Render) as well as through its CLI. Both paths use the same controller, budgets, idempotency and revision checks, and both talk to the simulator **only** through its authorized `/api/agent/v1` HTTP API. No simulator code is included in the package.

## Install

From a pinned commit (the `prepare` script compiles `dist/` on install; requires network access to GitHub and installs the dev toolchain for the build):

```bash
npm install github:walterjrey/agrogenesis-muse-agent#<full-commit-sha>
```

From a tarball (private distribution, no registry, no Git access needed at install time):

```bash
npm pack                       # in this repository; produces agrogenesis-muse-agent-<version>.tgz
npm install ./agrogenesis-muse-agent-<version>.tgz   # in the consumer
```

Requires Node.js >= 20.12. ESM only. The package is marked `private`, so `npm publish` is refused by default.

## Public API (`import … from "agrogenesis-muse-agent"`)

| Export | Purpose |
| --- | --- |
| `startSession(deps, options)` | Checks token authorization for the game, then persists a new *paused* session. Executes nothing. Mutations need explicit budgets (`maxCostUsd`, `maxMutations`, `maxModelCalls`, `maxSimSeconds`) and a `muse_ai` game with `act` + `advance` scopes. |
| `runSessionSlice(deps, options)` | Runs one bounded slice (default 3 decision cycles) and returns `{ state, report, finished }`. Mutations run only if the session allows them **and** the call passes `mutationsEnabled: true`. |
| `getSessionReport(backend, id)` | Read-only report (no credentials, no simulator snapshot). |
| `SessionBackend` / `SessionLease` | Storage interface (async). Implement it to use any database. |
| `PostgresSessionStore` | PostgreSQL backend (`pg.Pool`-compatible; the library does not depend on `pg`). Leases are fenced inside the `UPDATE`, so a displaced controller cannot overwrite newer state. |
| `FileSessionStore` | The CLI's file backend (`state.json` + `lock.json`). Not suitable for ephemeral disks. |
| `MemorySessionStore` | Tests and local experiments. |
| `AutonomousController`, `newSessionState` | Lower-level control for custom runners. |
| `SimulatorClient`, `MetaModelProvider`, `SpendGuard`, `createLogger` | Building blocks. |
| `SessionLockedError`, `SessionLockLostError`, `SessionAlreadyExistsError` | Errors callers should handle. |

Contracts (zod schemas for the simulator API) are available at `agrogenesis-muse-agent/contracts`.

```ts
import { PostgresSessionStore, startSession, runSessionSlice } from "agrogenesis-muse-agent";

const backend = new PostgresSessionStore(pool);          // pool: pg.Pool
await backend.ensureSchema();
const deps = {
  backend,
  simulator: { baseUrl: process.env.AGENT_SIMULATOR_BASE_URL!, agentToken: process.env.AGENT_SIMULATOR_TOKEN! },
  model: { apiKey: process.env.MODEL_API_KEY! },         // server-side only
};
const { sessionId } = await startSession(deps, { gameId, mutationsEnabled: true, planningHorizonDays: 200,
  limits: { maxCostUsd: 1, maxMutations: 40, maxModelCalls: 300, maxSimSeconds: 200 * 60 } });
const { finished } = await runSessionSlice(deps, { sessionId, mutationsEnabled: true });
```

## Rules the library enforces

- **Credentials stay server-side.** The Meta key and simulator token are passed in memory, never written to the session state, and logs redact them. Do not import this package from client components.
- **Partial observability is preserved.** The package contains no simulator logic and sees only what the authorized API returns; the simulator remains the sole authority for validation, resources and time.
- **Long sessions never run inside an HTTP request.** `startSession` returns immediately; `runSessionSlice` belongs in a worker or job runner. A slice can take minutes, and nothing relies on a promise surviving after a response.
- **Crash safety.** Every state-changing request is journaled in the backend before it is sent and replayed with the same idempotency key after a crash, so a lost response never repeats an action or a time advance.
- **Single owner per session.** A second controller gets `SessionLockedError`; a displaced controller gets `SessionLockLostError` on its next save.

## Model-call budget accounting

`maxModelCalls` (and `budgets.modelCalls`) counts **logical model calls only**: one entry per `provider.complete()` call that
returned a usable response. A logical call may need several **physical HTTP attempts** internally (timeouts, HTTP 429/5xx are
retried up to the provider's `maxAttempts`, default 4); those retries are transparent to the model-call budget and are never
separately billed or counted against it — only the final, successful attempt's token usage is priced.

A logical call that exhausts every retry and never returns a response does **not** consume `modelCalls` (it was never
"used"), but it does count toward `budgets.failedModelCalls`, and its physical retries toward `budgets.modelRetryAttempts`
(both persisted, cumulative across cycles and resumes, like every other budget). It also ends that cycle immediately
(`stopReason: "model_error"`) and increments the session's `consecutiveErrors` counter, which is bounded independently by
`maxConsecutiveErrors`. `buildReport(...).model_usage` exposes `modelCalls`, `failedModelCalls` and `modelRetryAttempts`
alongside token usage, so logical calls, physical attempts, successes and failures stay distinguishable without exposing
API keys or request bodies (only status codes, provider error codes, request ids and latencies are ever recorded).

A session stopped by `model_call_budget_exhausted` (or `cost_budget_exhausted`) reached its own configured limit; this is
never the same condition as Meta API rate limiting. A Meta 429 is retried internally and, only if every retry is exhausted,
surfaces as a per-cycle `stopReason: "model_error"` (with the HTTP status in the error message) — a transient provider
condition, not an exhausted session budget.

## Session storage on Render

Render web-service disks are ephemeral and not shared between instances, so do not use `FileSessionStore` there. Use `PostgresSessionStore` against a PostgreSQL database that the service can reach (the application's own database is fine; the store only touches its own `agent_sessions` table). The lease TTL (default 60 s) lets a restarted or redeployed worker take over a session whose previous owner stopped heartbeating.

## Operating it

Run slices from an independent process (a Render *Background Worker*, or a second process of the same service). See `examples/agrogenesis-integration/` for a route that creates and reports sessions, and a worker that resumes them. The example is not part of the published package and does not modify the AgroGenesis application.

## Worker, control and Render

See [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md). Exports: `runWorker`, `runWorkerOnce`, `buildSessionRecord` (credential-free enqueue), `PostgresSessionStore.migrate/requestControl`, `postgresJsQueryable`. Real-stack check: `examples/real-integration-check/check.mjs`.


## Model retries (0.1.1)

`MetaModelProvider` owns retries (the SDK's own retries are disabled so every attempt is recorded):

- Retried: HTTP 408, 429, 5xx, network errors and per-attempt timeouts, up to `maxAttempts` total attempts (default 4, max 8; legacy `maxRetries` = attempts - 1), with exponential backoff and equal jitter. `Retry-After` is honored; a value above 30 s, or one that does not fit the overall `requestDeadlineMs` (default 120 s) or the caller's `deadlineMs`, stops retrying instead of waiting.
- Never retried: 400, 401, 403, other 404s, malformed requests, spend-limit errors and any simulator mutation (mutations have their own idempotent retry path).
- `retryModelNotFound` (env `MODEL_RETRY_MODEL_NOT_FOUND=true`, default off): additionally retries `404` whose structured `error.code` is exactly `model_not_found`, only for models in the package's price table. Meta was observed returning this transiently for a valid model.
- A `signal` (`RunSliceOptions.signal`, `runWorker` signal) aborts an in-flight request or backoff wait.
- Each attempt is returned in `ModelResponse.attempts` / `ModelApiError.attempts` (status, provider code, latency, request id, backoff, `possiblyBillable`). Only the successful response is priced and charged to the spend guard; timeouts, dropped connections and 5xx are flagged `possiblyBillable` because their cost cannot be known.
- An observe-only session whose model call failed now ends `failed` / `model_error` instead of `completed` / `observe_only_complete`.
