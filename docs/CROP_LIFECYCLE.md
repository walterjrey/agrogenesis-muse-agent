# Phase 4A — Crop lifecycle with Meta Muse

Everything under "Live evidence" comes from one real run: Meta Muse Spark 1.3, the real simulator
(`feature/muse-autonomous-agent`, Next.js dev server) and an isolated PostgreSQL database (`agrogenesis_phase4a`).
Everything under "Mocked tests" is NOT live evidence. No simulator code or crop mechanic was changed.

## 1. Diagnosis (simulator read-only)

| Item | Finding |
|---|---|
| Tick / day | 0.1 simulated s per tick; 1 simulated day = 60 s = 600 ticks |
| Growth model | Growing degree days: `development = GDD / gddToMaturity` (`src/simulation/ecosystem/crops.ts`) |
| Maturity | Corn 1300 GDD (base 8 °C), soybean 1100 (base 10 °C), wheat 1700 (base 2 °C, start development 0.55 when pre-established); harvest-ready at development ≥ 0.98 |
| Cycle length | Simulator calibration: ~98 days for soybean in a normal season; observed live below |
| Yield | Reduced by water stress, nutrients, light, temperature, waterlogging, compaction, plant condition and pests |
| Operations via ManagementSystem | `prepareSoil`, `plantField`, `irrigateField`, `applyTreatment`, `harvestField`, `sellHarvest`, inspections/sampling are all in the registry and the agent API |
| Observability | Crop identity and growth stage are **never** observable (`knownCrop`/`knownGrowthStage` always null). The only agent-visible maturity signal is `harvestField` eligibility ("Crop is mature (98% development)", shown generically as `conditions_not_suitable` when not ready). There is no pest or harvest-ready event |
| Economy | `realizedRevenue` / `realizedCosts` in the overview; grain goes to depot stock; `sellHarvest` converts it to credits |
| Time cost | A full crop cycle is ~5,400–6,000 s, i.e. a handful of advance requests; time is not the bottleneck, decisions and observability are |

Crop progression itself is verified by the simulator's own test suite (yield, calibration and ecosystem tests: 67/67 passed when
run read-only for this diagnosis). The agent repository intentionally contains no copy of that logic.

## 2. What was added

- `superviseInterval` / tool `wait_for_checkpoint`: Muse picks a horizon (≤ 30 days) and a checkpoint size (default 5 days, 0.5–10).
  Time advances in checkpoint-sized, journaled, idempotent, revision-checked requests (`stopOn: any_event`). Any non-routine event
  (weather alert, equipment change, operation finished/failed, mode change) returns control to Muse. It never starts farm actions,
  never requests the server maximum (14,400 s) and accounts only the time the server actually granted.
- Progress record: `plantedCrop`, `plantedAtSimTimeS`, `simDaysSincePlanting`, `lastHarvestAtSimTimeS`,
  `lastInspectionAtSimTimeS` per field, derived only from this session's completed actions (never from hidden state).
- Report `lifecycle` section (plantings, inspections, irrigation water, treatments, harvests, sales, grain peaks, credits by
  action type, seed/fuel consumed, net credits, `cropCycleCompleted` only when a harvest **and** a sale completed) and a
  `scenario` manifest.
- Reproducibility: CLI flags `--scenario-name --scenario-seed --start-snapshot-sha256 --world-config-sha256`; the agent adds the
  sha256 of its first authorized observation, start revision and start simulated time.
- Context: compact field observations (`compactFields`), digest catalog (Phase 3B/3C), at most 6 completed operations in the
  brief, and a leaner `describe_action` result (zero-valued estimates and duplicate labels removed).

## 3. Live evidence — session `p4a-1`

### Scenario (not changed during the run)
- Game `253d90d1-530d-45da-a803-d03490c63418`, scenario `established`, seed **3303**, mode `muse_ai`, start revision 1, sim time 0.
- World config sha256 `1c8d87e70005f73d441c1e864206a84f626dc6ad702d6e16de0a03a7b3406a93`
- Start snapshot sha256 `87a5dd9028a412c805c4b022f7db2c5b7b49afe8ee56eee2d0de5589a7151099` (game row snapshot, 949,946 bytes)
- Agent start-observation sha256 `98e8a64ca1834891043b1970d7201dfa4eddc963a87d6e778d7536219d84892d`
- Model `muse-spark-1.3`; limits: cost $3, 150 model calls, 450 tool calls, 25 mutations, 200 sim days, 150 advance requests,
  1,500 farm credits; run in 6 process slices (resume after each).
- Scenario note: fields 1–3 appear to have held crops at game start that Muse could not see (crop identity is unobservable):
  harvest eligibility appeared at day 60 (field-3), day 90 (field-2) and day 120 (field-1) although Muse had planted nothing
  there. That is an inference from timing, not an observation. Four harvests are of crops **Muse planted itself**: field-4 wheat
  (day 0 → harvested day 90), field-3 wheat (day 60 → day ~150), field-4 corn (day 90 → day ~180) and field-2 soybean (day 90 → day ~180).

### Outcome (verified independently through the simulator API at the end)
| Metric | Value |
|---|---|
| Simulated time | 12,000 s = **200 days**, revision 1 → 90, stopped by the `max-sim-days` limit (`sim_time_limit_reached`) |
| Model calls / cost | 144 calls, **$1.274** (estimated from Meta pricing: $1.25 / $0.15 cached / $4.25 per 1M) |
| Tokens | 1,176,133 input (424,023 cached), 63,524 output |
| Advance requests | 64, 0 conflicts |
| Actions | 25 submitted, 25 distinct ids and idempotency keys: 8 prepareSoil, 8 plantField, 7 harvestField, 1 inspectField, 1 sellHarvest; 0 rejected, 0 failed |
| Crops planted by Muse | wheat f4 (day 0), wheat f3 (day 60), soybean f2 (day 90), corn f4 (day 90), corn f1 (day 120), soybean f3 (day 150), corn f2 (day 180), wheat f4 (day 180) |
| Harvests | 7, each only after `harvestField` became eligible; the 4 Muse-planted crops harvested had matured in ~90 days |
| Sales | **1**: 1,728.784 kg wheat for 432.196 credits (0.25 per kg) |
| Credits | 2,500 → 2,722.81 (**net +222.81**); realized revenue 432.2, realized costs 209.39 |
| Unsold grain at end | corn 3,154.05 kg, soybean 1,037.97 kg, wheat 1,740.71 kg (Muse chose not to sell it in the cycles that remained; nothing was forced) |
| Water applied | 0 m³ (Muse judged irrigation unjustified; it had one field inspection, then all measurements expired) |
| Pest treatments | 0 |
| Seed consumed | 874.8 kg; fuel used by actions 223.18 L (the depot `fuel` stock still read 3000 L; not investigated) |
| Action credits by type | prepareSoil 72.58, plantField 31.67, inspectField 25.00, harvestField 80.14 |
| Resumes | 5 process restarts; no duplicate action, no repeated advance |

### Verdict
A full production cycle **was completed**: Muse planted crops, let them grow by choosing 30-day checkpoints, harvested when the
simulator's maturity signal appeared, and sold one harvest for real revenue. The economic result is modest and incomplete:
only one of seven harvests was sold, so most of the output is unsold stock at run end. Limiting factors: the session stopped at
the 200-day limit I set, and Muse did not choose to sell more.

### Decision quality (honest notes)
- Muse repeatedly harvested only when `harvestField` was eligible and re-planted after each harvest (prepareSoil → plantField).
- It never irrigated or treated: with all measurements expired it consistently judged there was no evidence. With a single
  inspection in 200 days, it was mostly blind; whether sparser sensing cost yield was not measured.
- It stayed off selling. The prompt does not mention selling; no hint was added to force it.

## 4. Context cost

| | Phase 3C (live) | Phase 4A (live) |
|---|---|---|
| Average prompt tokens per model call | ~7,600 (182,878 / 24) | **8,165** (1,176,133 / 144) |
| First step of a cycle | ~5,600 | 6,705 average (grows as the record and fields grow) |
| Cached share | — | 36% |

No net reduction was achieved in the live run; the average rose slightly (a longer prompt with lifecycle guidance, 4 fields,
and later cycles carrying more completed operations). Breakdown measured on this run (chars): `observe_snapshot` result
~7,500, `describe_action` ~2,000, `execute_action` ~680, `wait_for_operation` ~570, `wait_for_checkpoint` ~330. Measured on
stored live data after the run, the leaner `describe_action` is 2,037 → 1,623 chars (-20%), but it was **not** used in the live
run. The dominant cost is repeated re-observation (`observe_snapshot`, ~7.5k chars) plus ~6 model calls per cycle, each re-sending
the history. Next corrective step: drop the digest catalog from repeated `observe_snapshot` results and let a cycle finish in
fewer model calls.

## 5. Mocked tests (NOT live)

`tests/autonomy/lifecycle.test.ts` (10 tests, mocked HTTP simulator + hand-built state): checkpoint horizon and size, never
the server maximum, event interrupt at a checkpoint, request/time budgets, 409 refresh, lost response with the same key
(one advance applied), deterministic repeat, compaction of fields, planted-crop/day bookkeeping, harvest and sale economics,
`cropCycleCompleted` only after harvest and sale. The existing 94 mocked tests continue to pass (104 total).
No real-PostgreSQL automated test exists in this repository; the live run above is the only database-backed evidence.

## 6. Reproduce

```
# simulator: create the game with seed 3303 (scenario "established"), mint a token with observe/act/advance, start the server
npm run agent:autonomous -- --game-id <id> --session-id p4a-1 --enable-mutations --max-cost-usd 3 --max-model-calls 150 \
  --max-tool-calls 450 --max-mutations 25 --max-sim-days 200 --max-advance-requests 150 --max-consecutive-advances 40 \
  --max-cycles 40 --max-farm-spend 1500 --slice-cycles 5 --scenario-name established --scenario-seed 3303 \
  --start-snapshot-sha256 <sha> --world-config-sha256 <sha>
npm run agent:resume -- --session-id p4a-1 --enable-mutations --slice-cycles 5
```

The model is non-deterministic: the same seed and start state reproduce the same world, not the same decisions.

## 7. Limitations

- One run, one seed; not a statistical result. Model decisions vary.
- Pre-established crops on fields 1–3 contributed part of the harvest; per-harvest yields were not recorded (grain is pooled
  in depot stock), only the peak per grain type. The sold wheat came from the pre-established field-3 crop.
- Fuel stock and fuel consumed by actions disagree in the observation; not investigated.
- The farm-spend limit is approximate. Token reduction goal not met.
