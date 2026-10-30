# Phase 3B/3C — Bounded Autonomous Farm Agent

Phase 3B turns the single-run tool-calling runtime (Phase 3A, `docs/MUSE_TOOL_CALLING.md`)
into a **bounded, resumable** controller that manages a Muse-mode game over several decision cycles.
It uses only the existing simulator API (`/api/agent/v1`) and native Meta Model API tool calls
(`muse-spark-1.3`). There is no second simulation engine and the simulator was not modified.

This is **not** a proven long-term farm optimizer, and nothing here supports a claim about
superiority over Manual management.

## Architecture (`src/autonomy/`)

| File | Role |
|---|---|
| `controller.ts` | Cycle loop, budgets, stop logic, mutation journal, reconciliation, finalize |
| `store.ts` | Durable `state.json` (zod-validated, atomic temp+rename) and exclusive `lock.json` |
| `observation.ts` | Consistent snapshot (overview + fields + actions share revision and simTime) |
| `catalog.ts` | Compact action catalog, on-demand `describe_action` |
| `tools.ts` | Autonomous tool set and revision-keyed snapshot cache |
| `prompt.ts` | System prompt, default objective, per-cycle brief |
| `report.ts` | Metrics from real values only (`null` when unobservable) |
| `types.ts` | zod schemas for limits, plan, decisions, journal, state |

Cycle: reconcile pending mutation → refresh actions → budget check → consistent snapshot → recent
events → model decision with tools (`observe_snapshot`, `list_available_actions`, `describe_action`,
`update_plan`, `execute_action`, `advance_time`, `get_action_status`, `get_recent_events`) →
progress evaluation → persisted decision record → stop checks. The model chooses every action;
there is no scripted sequence. If the model is about to answer without calling `update_plan`, it is
reminded once.

## CLI

```
npm run agent:autonomous -- --game-id <id> [--session-id <id>] [--enable-mutations]
    --max-cost-usd N --max-mutations N --max-sim-seconds N --max-model-calls N [--slice-cycles N]
npm run agent:resume -- --session-id <id> [--enable-mutations] [--slice-cycles N]
npm run agent:status -- --session-id <id> [--decisions]
```

Environment: `SIMULATOR_BASE_URL`, `SIMULATOR_AGENT_TOKEN` (isolated test token with
`observe`/`act`/`advance`), `MODEL_API_KEY`, and `MODEL_MAX_COST_PER_REQUEST_USD=0.10` (the default
$0.05 per-request cap is too small for these briefs). Credentials are never written to session state.

Defaults are observe-only. `--enable-mutations` requires an explicit game ID, a `muse_ai` game,
all three scopes and explicit cost / mutation / sim-time / model-call limits. Resume needs the flag
again, cannot upgrade an observe-only session, requires the same model, and never raises budgets.

## Budgets and stop reasons

Independent limits: Meta cost, model requests, tool calls, mutations, simulated seconds,
wall-clock, consecutive errors, consecutive no-progress cycles (plus cycles).

- **Paused** (resumable): `slice_complete`, `unresolved_mutation`, `inconsistent_observation`,
  `authentication_failure`, `consecutive_errors`, `controller_error`.
- **Stopped** (final): any exhausted budget, `no_progress`, `repeated_rejections`.
- **Completed**: `model_declared_done`, `observe_only_complete`, `no_eligible_actions`.

Progress means an accepted mutation or an observed `action_completed` / `action_failed` /
`observation_delivered` event. Time-only, observe-only or rejected-only cycles do not count.

## Session storage and ownership

`sessions/<id>/state.json` holds session/game IDs, model, limits, objective, plan, decision
summaries, tracked actions, completed operations, pending mutation, last confirmed revision and
simTime, usage and cost, remaining budgets, and the stop reason. `lock.json` is created exclusively;
a stale lock is taken over only if its pid is dead or its heartbeat expired, and a displaced
controller fails with `SessionLockLostError` on its next save. `sessions/` is gitignored.

## Consistent observations

Overview, fields and actions must report the same revision and simTime; otherwise the controller
re-reads (up to 3 rounds) and then pauses with `inconsistent_observation`. Snapshots are cached by
revision so an unchanged game is not re-read. Sensor timestamps and ages are preserved as returned;
snapshot consistency is not treated as sensor freshness, and missing observations stay missing.

## Mutation safety and recovery

Before sending, the intent (exact payload, idempotency key, expected revision) is persisted. After
the response it is settled. On 409 the state is refreshed and a structured conflict is returned to the
model. On a timeout or unknown outcome the **same key and payload** are replayed (up to 3 attempts);
a 4xx settles as `not_applied`, otherwise the session pauses as `unresolved_mutation` and no further
mutation is allowed. Resume reconciles before anything else.

## Token cost: catalog compaction

Measured on the real live catalog (`GET /actions`, game with 4 fields):
raw 53,322 chars → compact 9,533 chars (**−82%**; roughly 13k → 2.4k tokens at ~4 chars/token, an
estimate, not a Meta-reported count). Phase 3A's catalog was 32,586 chars (~9k tokens). Validation
rules are not copied: `describe_action` returns the simulator's own parameters, and the simulator still
validates every request.

Real per-call input is still large (≈ 8.9k tokens/call in session `live-2`: 124,593 input tokens over
14 calls) because the brief embeds the overview and field state and `observe_snapshot` repeats it.

## Token cost: per-cycle brief deduplication

`observe_snapshot` does **not**, in fact, repeat an unchanged snapshot: it already returns a short
`{unchanged: true}` marker when the revision/simTime match what the controller last delivered in the
brief (`SnapshotProvider.delivered`, checked in `tools.ts`). The remaining per-call cost comes from
**cross-section duplication inside a single cycle's own JSON brief**, not from history accumulating
across cycles (each cycle starts a fresh two-message `[system, user]` array; see `controller.ts`/`runtime.ts`)
and not from `observe_snapshot` repeating data the model already has.

Removed, with before/after values coming from the SAME authorized snapshot already present elsewhere in
the same brief (verified in `tests/autonomy/prompt.test.ts`):

| Duplicate | Where it was repeated | Already available at |
|---|---|---|
| `resourceInventory`, `currentCashCredits`, `marketPricesPerKg`, `economicLedger`, `pendingOperations` | `planning` block | `snapshot.overview.{resources,finance}`, `economy`, `operationalRecord.pendingOperations` |
| `knownCrop`/`knownGrowthStage` per field | `operationalRecord.fields[]` | `snapshot.fields.fields[]` |
| `objective`, `simTimeS` | `operationalRecord` | top-level `objective`, `snapshot.simTimeS` |
| `revision`, `simTimeS` | nested inside `snapshot.fields` (from `compactFields`) | sibling `snapshot.revision`/`snapshot.simTimeS` |
| `asOfSimTimeS`, `credits` | `economy` | `snapshot.simTimeS`, `snapshot.overview.finance.credits` |
| always-null agronomic fields, `asOf`, per-preview `note` | `planning.cropOptions` (auto-embedded copy only) | stated once in `cropOptions.unknowns`; full detail stays on the on-demand `compare_crop_options` tool, unaffected |
| `source`/`note` prose, `durationEstimateSource`, a 2-sentence `uncertainty` block | `planning.genericCropWindow`/`knownCropCommitments` | the system prompt already states these are generic, non-crop-specific estimates |
| double computation of `buildProgress()`/`buildEconomics()` | `buildPlanningContext()` internals | the controller already builds both once per cycle; `buildPlanningContext()` now accepts the precomputed `progress` |

`buildCropEconomics()` itself (used by the `compare_crop_options` tool) and `compactFields()`/`terseCatalog()`
(used standalone by `observe_snapshot`/`list_available_actions`) are **unchanged**; only the copies
auto-embedded in the per-cycle brief were trimmed, via small wrapper functions (`compactCropOptions`,
`promptOperationalRecord`, `promptFields`, `promptEconomy` in `prompt.ts`/`planning.ts`).

**Prompt caching** (Meta Muse Spark 1.3): already active, not newly implemented. `MODEL_PRICING["muse-spark-1.3"]`
prices `cachedInput` at 0.15 vs. 1.25 USD/1M tokens (an 88% discount) and `MetaModelProvider.complete()` already
captures `usage.prompt_tokens_details.cached_tokens`; session `live-2` above already shows 20,435 cached tokens
out of its real request. The byte-identical `AUTONOMOUS_SYSTEM_PROMPT` prefix is already served from cache after
the first cycle — left unchanged, since no code change can improve on provider-side caching that is already active.

**Instrumentation** (`promptMetrics.ts`): `measureCycleBrief()` reports a per-section character/estimated-token
breakdown (clearly labeled `estimated`, chars/4 heuristic, never sent to the model) before each model call, and
the controller logs real provider `usage` (input/output/cached tokens, cost, modelCalls/failedModelCalls/
modelRetryAttempts) after it, both keyed by cycle number, so an estimated per-cycle prompt size can always be
cross-checked against the real Meta-reported token count for that same cycle.

**Benchmark** (`tests/autonomy/prompt.test.ts` + an ad-hoc fixture matching the real 4-field catalog size noted
above — 4 fields × 6 action types = 24 actions, 3 planted fields, one pending planting): reconstructing the
pre-dedup brief shape and comparing it to the current one on the identical fixture gives **13,916 → 10,568
chars (≈3,479 → 2,642 estimated tokens, −24.1%)**. The largest remaining contributors are `snapshot.overview`
(raw `FarmOverview`, left untouched — equipment/weather fields were judged higher-risk to compact without
real-traffic evidence of which sub-fields are safe to drop) and `snapshot.fields`/`snapshot.actions`
(already compacted elsewhere at −70%/−82%). This falls short of a 30% target; closing the remaining gap would
require compacting `overview` itself (e.g. dropping `label` fields that are a pure reformatting of `id`) or
shortening the static `cropOptions.unknowns` prose, both deferred pending confirmation that no decision context
would be lost.



Local simulator, isolated DB, Muse-mode game, rotated key, `muse-spark-1.3`.

**Session `live-1`** (2 slices, resumed in a new process): 20/20 model calls, 4 cycles, cost
≈ **$0.227**. Muse chose `inspectField` on field-1, -2, -3 and advanced 5 s twice (≈ 10 s simulated).
Credits 2500 → 2425 (3 × 25), 0 rejected, 0 duplicates.

**Session `live-2`** (1 cycle, then resume with 3 cycles): 14/14 model calls, cost ≈ **$0.167**
(124,593 input / 7,864 output / 20,435 cached tokens), 2 accepted mutations (limit 2), 10 s simulated.
- Cycle 1: Muse inspected field-4 (`act-0004`, completed) and advanced 5 s.
- Cycle 2: Muse started `prepareSoil` on field-4 (`act-0005`) and advanced 5 s.
- Cycle 3 (after resume): no new mutation; verified `act-0005` still running.
- Stopped on `model_call_budget_exhausted`.

**Independent check against the simulator** (direct overview call, not the agent's state): credits
2425 → **2390.88** (= 25 for `act-0004` + 9.12 for `act-0005`), realized costs 75 → 109.12 (= 4 × 25 +
9.12), revision 10, simTime 20 s, `tractor-1` busy with `act-0005`. No duplicated action or charge.
No revenue (no crop was planted or harvested). Mixed-revision detections: 0.

Resume across processes worked without replaying completed actions and with cumulative budgets.

## Mocked vs live

- **Mocked (71 tests, fake model and fake simulator)**: multi-cycle autonomy, persistence, resume,
  mixed revisions, every budget, loop prevention, failed model calls, stale revisions, lost responses
  after accepted mutations, idempotent recovery, concurrent session ownership, invalid arguments,
  partial observability, decision/cost accuracy. These are not live evidence.
- **Live (manual runs above)**: native tool calling, inspections, a `prepareSoil` action, time
  advancement, cost accounting, resume, and the independent charge check.
- **Not exercised live**: timeout/lost-response recovery, HTTP 409 handling, crash mid-mutation.
  Mocked only. No real-PostgreSQL automated tests were added in this repository.

## Known limitations

- Muse did **not** reliably call `update_plan` (0 of the live cycles recorded a plan despite a stronger
  prompt and a one-time reminder). Decision summaries are therefore the model's final text and are
  marked `(model final text, no plan recorded)`; the rolling plan field is mostly empty.
- Live runs reached only inspections and one soil preparation; no planting, harvest, livestock, revenue
  or economic improvement was observed. Simulated time was ≈ 20 s (1/3 of a simulated day; 1 day = 60 s); the sim-time
  limit was never reached.
- Runs ended by the model-call budget, mostly spent on repeated observation tools.
- Per-call context (~9k tokens) remains the dominant cost.
- No Manual vs Muse comparison was run. `report.ts` records the baseline/latest metrics needed for a
  later reproducible comparison.

## Next steps

Slim the brief (send deltas instead of the full snapshot), enforce plan output (e.g. a forced final
tool call), run a longer session covering plant → grow → harvest, live-test 409 and timeout recovery,
then a Manual vs Muse comparison with identical seeds.


---

# Phase 3C — Long-horizon supervision

Diagnosis, measurements and live results: [AGRICULTURAL_PROGRESS.md](AGRICULTURAL_PROGRESS.md).

## What changed

- **Operation supervisor** (`src/autonomy/supervisor.ts`): for an action Muse already authorized, it
  polls the action status and advances server time (`/clock/advance`, `stopOn:["action_completion"]`,
  fresh idempotency key, `expectedRevision`) until the action completes, fails, a material event
  occurs, or a limit is hit. It accounts the **granted** seconds returned by the server, not the
  requested ones. It never chooses farm actions. Exposed to the model as `wait_for_operation` and run
  automatically by the controller (`autoWait`; disable with `--no-auto-wait`) for in-flight actions.
- **409**: refresh the revision and retry up to `maxConflicts`. **Uncertain outcome**: the journal
  entry stays pending; resume replays the same key and payload.
- **Factual progress record** (`src/autonomy/progress.ts`): derived from tracked actions, metrics and
  budgets; independent of `update_plan`; no plan is invented.
- **Context compression**: superseded tool results become stubs (`src/agent/history.ts`);
  `observe_snapshot` returns `unchanged` if revision/time were already delivered; the catalog is a
  digest (eligible types only, targets grouped, reasons behind `describe_action`).
- **New limits/flags**: `--max-sim-days` (1 day = 60 s), `--max-advance-requests`,
  `--max-consecutive-advances`, `--max-conflicts`, `--max-farm-spend`, `--no-auto-wait`. New stop
  reasons: `advance_request_budget_exhausted`, `consecutive_advance_limit`,
  `database_conflict_limit`, `farm_spend_limit_reached`.
- Report bug fixed: simulated days used 86,400 s/day; now 60 s/day.

## Mocked vs live (3C)

- **Mocked** (23 new tests, `tests/autonomy/timedSim.ts`; 94 total): time units, granted time,
  completion, estimate already passed, long operations, failure/weather interrupts, limits, 409, lost
  responses with same-key replay, resume, compaction, determinism.
- **Live**: sessions `p3c-1` and `p3c-2`. HTTP 409, timeouts and mid-mutation crashes were **not**
  observed live.

# Phase 4A — Crop lifecycle

Adds `wait_for_checkpoint` (Muse-chosen horizon up to 30 simulated days, checkpoints of 0.5–10 days, returns early on non-routine events, never starts farm actions), per-field planting/harvest bookkeeping in the progress record, a `lifecycle` report section, scenario manifest flags and compact field observations. A real 200-simulated-day run (144 Muse calls, $1.274) harvested 7 times and sold once. Details, evidence and limitations (including that the average prompt size did not decrease) are in [CROP_LIFECYCLE.md](CROP_LIFECYCLE.md).
