# Render deployment design (not deployed)

Status: **design only**. Nothing here has been deployed, and no migration has been applied to production. Everything
marked "verified" was run locally against a real simulator (`next dev`), a real PostgreSQL 17 database and the real Meta
API; see `docs/LIBRARY.md` for the library API.

## Topology

| Service | Render type | Purpose |
| --- | --- | --- |
| AgroGenesis | Web Service (existing) | UI, simulator API, `/api/muse/sessions/*` (enqueue/status/pause/resume/cancel). Holds **no** agent token and **no** Meta key. |
| PostgreSQL | Existing instance | Simulator tables plus `muse_agent_sessions` and `muse_agent_sessions_migrations`. No second database is needed (verified: no collisions with the simulator's `agent_*` tables). |
| Muse worker | Background Worker (optional) | Runs bounded `runSessionSlice` calls. The only process holding `AGENT_API_TOKEN` and `MODEL_API_KEY`. |

A worker is needed only for unattended sessions. For a short demo the same slices can be driven by `muse-worker once`
from a shell, but never from inside a Next.js request.

## Package installation

The simulator must depend on the agent package. Options, best first:

1. A prebuilt tarball (`npm pack`) committed to a release/artifact URL, pinned by SHA-512 in `package-lock.json`.
2. `github:walterjrey/agrogenesis-muse-agent#<full commit sha>` (never a branch). The package builds `dist/` in its
   `prepare` script; npm may require install-script approval for git dependencies (`npm warn install-scripts`), so
   verify this on Render's Node version before relying on it.

Requires Node >= 20.12 (package is ESM-only). `postgres` is already a simulator dependency; the agent library itself
does not need `pg` when `postgresJsQueryable(sql)` is used.

## Commands

- Web build: `npm ci && npm run build` (unchanged). Start: `npm run start` (unchanged).
- Worker build: `npm ci`. Worker start: `npx tsx scripts/muse-worker.mts run` (`tsx` must be available in the worker
  build, i.e. a dependency or installed with dev dependencies).
- Migration (one-off, before first worker start, manually): `npx tsx scripts/muse-worker.mts migrate`. Idempotent and
  recorded in `muse_agent_sessions_migrations` (`0001_sessions`, `0002_worker_control`). The simulator's own
  `npm run db:migrate` is independent. Verified: running twice applies nothing the second time.

## Environment variables (names only)

Web: `DATABASE_URL`, `AUTH_SECRET`, `AGROGENESIS_ADMIN_USERNAME`, `AGROGENESIS_ADMIN_PASSWORD_HASH`, `APP_ORIGIN`,
`MUSE_SESSIONS_ENABLED` (must be `true`, otherwise all Muse routes answer 404), optional `MUSE_MODEL_ID`.

Worker: `DATABASE_URL`, `AGENT_API_URL` (the web service's internal URL), `AGENT_API_TOKEN` (scoped token, see below),
`MODEL_API_KEY`, optional `MODEL_ID`, `MODEL_BASE_URL`, `MUSE_MUTATIONS_ALLOWED` (default `false`), `MUSE_SLICE_CYCLES`
(default 3), `MUSE_POLL_MS` (default 10000).

## Safety model

- Web tier: administrator session required, same-origin check on every POST, game must be owned and `muse_ai`, session
  ids are validated UUIDs and foreign/unknown sessions are indistinguishable (404). Budgets are hard-capped
  (`src/server/muse/config.ts`) and mandatory when mutations are enabled. One unfinished session per game (409).
- Worker: re-validates token authorization against the game on every slice; skips (and pauses) a mutating session if
  `MUSE_MUTATIONS_ALLOWED` is not `true`; per-session budgets (USD, model calls, mutations, simulated seconds, farm
  spend) stop the session with an explicit reason.
- Only one process runs a session at a time (fenced lease with TTL, 60 s default). Verified: two concurrent worker
  processes ran exactly one slice.
- The simulator remains the authority: idempotency keys, expected revisions and scopes are enforced by its API.

## Restart behaviour (what was actually tested)

- SIGTERM/SIGINT: the worker finishes the slice in progress, then exits (implemented; the signal path was not
  exercised on Render).
- Hard kill: **one** SIGKILL in the middle of a slice with real Meta + simulator + PostgreSQL. The lease stayed held
  until its TTL expired, a new process then resumed and finished; simulator idempotency keys, audit log and game
  revision showed no duplicated actions or time advances. Repeated crashes, crashes during a mutation commit and
  multi-day soaks were **not** tested.
- Worker `Background Worker` restarts on Render are therefore expected to idle for up to one lease TTL after a hard kill.

## Agent token provisioning (open item)

`AGENT_API_TOKEN` is a bearer token scoped to specific games (`observe`, and `act`/`advance` for mutation). The
simulator's `scripts/agent-token.mts` issues tokens from the CLI; there is no UI to provision them. Today a worker holds
one token, so it can serve only the games that token is scoped to. A per-session token vault is out of scope here.

## Logging and monitoring

The worker emits one JSON line per event (`slice_started`, `slice_finished`, `skipped_*`, `cancelled`, `slice_failed`)
on stdout, which Render collects. Session status, cost, mutation counts and `last_error` are read through
`GET /api/muse/sessions/:id` or SQL on `muse_agent_sessions`. Alert on repeated `slice_failed` and on sessions stuck in
`running` beyond the lease TTL. No external metrics are implemented.

## Budget guidance

Measured locally with Muse Spark 1.3: observe-only session ~ $0.02 for 2 calls; a 18-call mutating session ~ $0.16.
Set per-session `maxCostUsd` and the web caps conservatively, and keep `MUSE_MUTATIONS_ALLOWED=false` until intended.

## Cost and complexity

Additional cost: one Background Worker instance (Render's smallest paid tier; free tier does not offer background
workers) plus negligible extra Postgres storage. Complexity: one more service, one migration command, one scoped token,
two secrets. Not required if sessions are driven manually for the demo.

## Remaining blockers before deploying

1. Decide and verify the package install method on Render (tarball vs pinned git commit).
2. Add the dependency line to the simulator `package.json` (intentionally not done; local tests used `--no-save`).
3. Provision a scoped agent token for the demo game and store it only in the worker's secrets.
4. Run `muse-worker migrate` against production manually after review.
5. A minimal UI for the Muse routes does not exist; they are API-only.
