# Benchmark foundation (Phase 5A)

Scope: one paired scenario, a deterministic non-LLM baseline, and the controls needed for a fair comparison with Muse.
**No Muse run was made in this phase, so nothing here claims one strategy is better.** Muse is stochastic; a single run would not prove anything either way.

Evidence labels: **[live]** = real simulator + real PostgreSQL; **[mocked]** = unit tests with fakes (no simulator, no model).

## 1. Skipped simulator tests

The 30 skipped tests are exactly the 30 tests in `src/server/agent/agentApi.integration.test.ts` (token hashing, auth, scopes, expired/revoked tokens, rate limiting, audit, action execution, invalid/unsupported actions, 409 stale revision, idempotency replay, concurrent idempotent requests, concurrent action/advance serialization, browser/agent write race, deterministic replay, async robotics completion, snapshot persistence, Manual isolation, Hybrid unavailable).
They are gated by `describe.skipIf(!process.env.AGENT_TEST_DATABASE_URL)` and need a real PostgreSQL. They ran against isolated throwaway databases after `npm run db:migrate`. **[live]**

- First run on a fresh database: **29/30**. "rejects missing, malformed and invalid credentials uniformly" failed once (130 ms).
- It then passed alone and 30/30 on three further runs. Passing afterwards did not explain the failure, so it was investigated (below).

### Intermittent authentication failure: investigation **[live, real PostgreSQL]**

Mechanism (reproduced): the suite called the routes without a client address, so every request used the shared bucket `address:direct`/`failure:direct` in the `agent_rate_limits` table. Those rows **persist in PostgreSQL** (limits: 240 requests/60 s per address, 20 auth failures/300 s per address) and were only deleted in `afterAll`. A run that is interrupted, a second process on the same database, or any earlier run inside the 300 s window leaves them behind. Seeding `failure:direct=15` before a run made 4 tests fail (the credentials test first) with `expected 429 to be 401`. The test's own `203.0.113.77` bucket for the rate-limit test had the same weakness, and `afterAll` deleted tokens by owner/label, so two concurrent runs destroyed each other's tokens (reproduced: Manual-isolation and Hybrid tests failed).

Measured load of one clean run: peak `failure:direct` 10/20 and `address:direct` 67/240, so a clean run on an empty database stays under the limits. The production code (atomic `INSERT … ON CONFLICT` in `consumeAgentRateLimit`, check order address → authentication → failure → token) is correct and unchanged.

**Root cause status:** the failure *class* is identified and reproduced (shared persistent rate-limit state across runs/processes). **The specific trigger of the original single failure is not proven**: I did not capture the database state before that run, so I cannot confirm it was leftover state rather than something else. It is reported as "mechanism reproduced, original trigger unconfirmed", not as "resolved because later runs passed".

Fix (simulator, test-only): each run uses its own `x-forwarded-for` address (with `TRUST_PROXY_HEADERS` stubbed), its own rate-limit address, and its own owner id; cleanup is scoped to those. Regression test added ("is isolated from exhausted rate-limit state on the shared default address"). Verification: 31/31 with `failure:direct`/`address:direct` pre-seeded to 1000, 31/31 three times sequentially, 31/31 on three concurrent processes on one database.


## 2. Scenario reproducibility

`npm run agent:game -- create-pair --seed N` (simulator, admin tool) creates two independent games from the same seed/scenario, reads them back from PostgreSQL and compares a canonical fingerprint: sha256 of canonical (key-sorted) JSON of the persisted `world_config` and `snapshot`. Game id, name, owner, timestamps and revision are excluded, so they cannot cause false differences. It exits non-zero if the fingerprints differ. **[live]**

Seed 3303, scenario `established`:

| | sha256 |
|---|---|
| worldConfig | `f6cb31def3d5c53fa06361166d2f371a2f5a2d3473eb82951278fe8778ce87a6` |
| snapshot | `f05ecc762334918970d66c1c252d41ec11fb1302575db4e3e0d18943d54e1204` |
| combined | `2c86746eb5b20b22d5c1e37a7795ec63c1e7d6ce95960f36943977d198554934` |

- Negative control: seed 3304 gives a different combined hash (`c074e9b4…3871`).
- A third creation (replay pair) reproduced the identical hashes.
- Agent-API level (`npm run benchmark:verify-pair`, before any strategy ran): overview, fields and available-actions hashes (gameId excluded) are identical for the Muse and baseline games; revision 1, simTime 0.
- Official pair: Muse `a384c161-fcf0-429d-bb46-2cc4431d6619` (untouched, revision 1), baseline `e0d6f3cb-d9fd-4e53-8349-c1bfade45e13`.

### Fingerprint coverage and exclusions

The fingerprint is sha256 over canonical JSON (sorted keys, because PostgreSQL `jsonb` reorders them) of the persisted `world_config` and the **entire serialized `snapshot`**, not agent-visible observations. The snapshot holds the simulation seed, `tickCount`, `time`, weather/environment, soil, ecosystem/crops, livestock (each animal's `rngSeed` and `rngCounter`), machinery, robotics, management, resources/ledger, events, history and actions. Deterministic RNG state is therefore covered (seed plus per-entity seeds and counters, all at 0 at start).

Checked directly against the stored rows of two untouched games (`P5A muse` and `P5A-replay muse`, same seed): **0 leaf differences** in `snapshot` and `world_config`, and every other column compared identical except the excluded ones below. The baseline games' own initial equivalence was established by the fingerprint at creation and re-checked (revision 1, same combined hash) immediately before the baseline run; afterwards they necessarily differ (revision 101).

| Excluded | Why it is safe |
|---|---|
| `id`, `name`, `owner_id` | Identity/labels; the engine never reads them. They would make every pair differ. |
| `created_at`, `updated_at`, `last_played_at` | Wall-clock bookkeeping, outside the simulated state. |
| `revision` | Optimistic-lock counter; both start at 1 (compared separately). |

Other columns (`seed`, `management_mode`, `lifecycle`, `snapshot_version`, `baseline_id`, `source_game_id`, `forked_at`, `baseline_hash`, `comparison_id`) are not hashed but were compared one by one and are identical. Not covered: server code version and environment (the same build served both games), and the agent token/DB identity.

Start state: 2500 credits, no grain, seeds corn 800 / soybean 1500 / wheat 3000 kg, fuel depot 3000 L, machine tanks 1000 L, prices corn 0.20 / soybean 0.45 / wheat 0.25 / hay 0.10 per kg.
Fields 1–3 hold **pre-existing standing crops** that are not visible to the agent API; only `prepareSoil field-4` is eligible at day 0.

## 3. Baseline ("reference farmer v1")

A **simple deterministic reference strategy**, not an optimized farmer and not a model of a human competitor. `src/baseline/policy.ts` (pure, deterministic) + `runner.ts` (durable, resumable) use only the authorized agent API and the baseline's own action history. Rules in strict priority, exactly as implemented (config defaults: horizon 200 d, checkpoint 5 d, wait chunk 30 s, `minSellKg` 1, rejection cooldown 60 simulated s):

| Rule | Behaviour |
|---|---|
| R0 | Stop once `simTimeS >= horizonDays × 60`. |
| R1 | If `activeActionCount > 0`, advance `min(30 s, remaining)`, `stopOn: action_completion`. |
| R2 | For each product with stock ≥ `minSellKg` (alphabetical): if it has a published price > 0 and no active sale cooldown, sell `floor(stock)` kg (`sellHarvest`). Products without a published price are held and the hold is logged. |
| R3 | `harvestField` on the first (by id) field where it is eligible and not on cooldown. |
| R4 | For the first plantable field: rotation soybean→corn→wheat starting after the last crop *this baseline* planted there (soybean if none); crops with no seed stock are skipped (logged); a dry run validates the plant before committing; a rejection puts that crop on cooldown. |
| R5 | `prepareSoil` (`terminateCrop=false`) on the first eligible field that is not plantable, not marked "growing" by the baseline's memory, and not on cooldown. |
| R6 | Otherwise advance `min(5 d, remaining)`, `stopOn: any_event`. |

Fairness review (code inspection plus the live runs):
- **Observations only:** `decide()` receives just `{overview, actions}` from the agent API; the runner also reads field observations only for the pair fingerprint. Nothing reads the database or the simulator code.
- **Same action API as Muse:** `executeAction`, `getAction`, `advance` of the same `SimulatorClient`, with the same scoped token type (observe/act/advance on one game). No admin or extra scope.
- **Revision/idempotency:** every mutation sends `expectedRevision` and a persisted idempotency key; resume re-sends the same key (kill/resume verified live).
- **No seed knowledge:** the seed is only a recorded label (`scenario.seed`); no code branches on it, and `grep` finds no seed or scenario constant in `src/baseline`.
- **Memory:** it learns only from its own completed actions (`learn`). It is not told which fields hold pre-existing crops; it discovers them only through `harvestField` eligibility, the same signal Muse has.
- **Asymmetries (not hidden):** the baseline never inspects, irrigates or treats; it sells everything immediately; its rotation, horizon and 5-day cadence are arbitrary design choices.

Safety: one durable pending intent (body + idempotency key) is saved before each request; a resumed process re-sends the same key. 409 → re-observe; network/timeout/5xx → keep pending and retry; other 4xx → stop. Requests are paced (700 ms) and a 429 is retried after 61 s (the server limit is 120 req/60 s per token and 240/60 s per address). A resumed process resets the transient error counters.

CLI: `baseline:start|resume|status`, `benchmark:verify-pair`, `benchmark:outcome`.

## 4. Controlled variables and recorded differences

Same: seed, initial fingerprint, horizon (200 d), starting credits, equipment, market, observation permissions, action constraints, and the same API.
Unavoidable differences: Muse is stochastic and has latency and API cost; Muse chooses its own checkpoints and can stop for budget rules, the baseline always runs 200 d; baseline requests are paced; both runs from one machine share the address rate bucket; Muse inspects/decides freely while the baseline never inspects.

## 5. Baseline result (seed 3303, 200 simulated days) **[live]**

| Metric | Value |
|---|---|
| Initial / final credits | 2500 / 5015.82 |
| Net cash change | +2515.82 |
| Realized sales revenue | 2724.65 |
| Operational expenses | 208.83 |
| Initial inventory (kg) | 0 |
| Final inventory (kg) | corn 0.53, soybean 0.866, wheat 0.784 |
| Final inventory value (at known prices) | 0.69 |
| Total estimated value (credits + inventory) | 2500 → 5016.51 (+2516.51) |
| Seed consumed (kg) | corn 130.5, soybean 417.6, wheat 189 |
| Fuel | depot unchanged (3000 L); machine tanks −252.98 L |
| Actions | 34 (9 prepareSoil, 9 plantField, 8 harvestField, 8 sellHarvest); 66 advances; 0 conflicts, 0 rejections |

### Provenance of production (`src/benchmark/attribution.ts`, derived from the action history)

A harvest is credited to the strategy only if it completed a `plantField` on that field before the harvest and no harvest of that field intervened. Everything else is "not planted by the strategy" (crop already standing in the initial scenario, or unknown provenance; the API cannot tell these apart, and the crop type is not observable). Pre-existing harvests are never counted as production generated by the strategy.

| Provenance | Harvests | Grain (kg) | Value at known prices |
|---|---|---|---|
| Planted by the baseline | 5 (4 soybean-era fields + corn; soybean 2597.67 kg, corn 1675.83 kg) | 4273.50 | 1504.12 (estimate: kg × published price) |
| Not planted by the baseline (pre-existing or unknown) | 3 (field-3 day 45.2, field-2 day 90.4, field-1 day 95.7) | 4621.68 | crop unknown, not valued |

Realized revenue (2724.65) is **aggregate only**: sales draw from a fungible per-product inventory, so revenue is not split by provenance (that would need an assumption such as FIFO). Consequently the net result +2515.82 mixes pre-existing and self-generated production; the self-generated part is bounded by the harvested-kg estimate above, not measured as cash. Note the 8 harvested crops total 8895 kg while inventory ended near 0, so all harvests were sold or nearly so. Any Muse comparison must use the same split and the same caveat. This attribution was computed offline from the saved run state, not re-run.

Known prices are published constants; "estimated" inventory value uses them and is not a market forecast. Machine-tank fuel decreases while the depot does not (the depot/tank distinction audited in 4B).

Reliability **[live]**:
- Kill/resume: a run was killed mid-request and resumed; it finished at 200 d with 100 unique idempotency keys and no duplicated actions (scratch run `dev-2`).
- Determinism: a second baseline run on an independent same-seed game (`7b3b90bd…`) produced identical actions (type, params, status, times, costs), identical start observation hash and identical outcome comparison.

## 6. Mocked tests **[mocked]**

`tests/benchmark/baseline.test.ts`: policy rules and holds, rotation/seed skipping, cooldowns, determinism, learning from failed actions, 429 retry and its limit, canonical fingerprint. `tests/benchmark/attribution.test.ts`: provenance rules (never-planted fields, plant-before-harvest, failed plantings, unknown prices). These do not touch the simulator or the model.

## 7. Limitations

- One scenario, one seed, one baseline run (plus one determinism replay); no statistics.
- No Muse run yet; no superiority claim. Muse is stochastic, so a single run could not support one anyway.
- The baseline's 5-day cadence, rotation and sell-everything rule are design choices, not an optimized strategy.
- Revenue cannot be split by provenance; self-generated production is only estimated from harvested kg × published price.
- The original credentials-test failure: mechanism reproduced, original trigger not confirmed (see §1).
- Simulator changes are limited to the admin helper (`create-pair`, `fingerprint`) and the test isolation fix, committed locally only on `feature/muse-autonomous-agent` (not pushed).
