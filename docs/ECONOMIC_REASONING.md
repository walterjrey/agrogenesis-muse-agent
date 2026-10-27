# Phase 4B — Economic reasoning, observability and agent efficiency

Everything below comes from the code and from two real runs (Meta Muse Spark 1.3, real simulator, isolated PostgreSQL DB `agrogenesis_phase4b`, seed 3303 "established"). Mocked tests are labeled MOCKED and prove bookkeeping only, not farm mechanics.

## 1. Fuel discrepancy: not a defect

- Machines start with full tanks (tractor 300 L, harvester 400 L). When an operation starts, the simulator draws from the **depot** only `max(0, estimate - tank)`; if the tank covers the job the depot stays at 3000 L. Burn reduces the tank and is reported as `action.consumed.fuelL`.
- The agent API only published depot fuel, so consumption (4A: 223 L) was invisible in stock. It is a presentation gap, not an accounting bug. The simulator's own test (`machinery.test.ts`, "consumes fuel…") already asserts `300 − tank == consumed.fuelL` and depot unchanged.
- No mechanic was changed. The overview now labels depot fuel as "excludes fuel already in machine tanks" and adds a `fuel-in-machine-tanks` resource. Regression test: `readModels.test.ts` ("exposes machine-tank fuel separately…", real simulation).
- Live check (run 2): action `consumed.fuelL` summed to 190.26 L; machine tanks went 1000 → 809.739 L (Δ 190.26); depot stayed 3000 L.

## 2. Why 5,933 kg stayed unsold in 4A

From the 4A traces: `sellHarvest` was always in the catalog and `describe_action` showed the stock, so discoverability was fine. Missing information: no price, no expected revenue, no explanation that harvested grain earns nothing until sold (the system prompt never mentioned selling), and no recorded outcome of a sale. Storage capacity is not modeled/published (reported as unknown). The 200-day limit then ended the run. Conclusion: mostly missing information and motivation, not a defect; one sale was made. No auto-sale exists.

## 3–4. Information added

Simulator (`feature/muse-autonomous-agent`, additive, tested): `finance.marketPricesPerKg` and `finance.priceConfigVersion` (the game's configured quote, identical to what the ledger sells at; tested against `DEFAULT_MARKET_PRICES`) and the machine-tank fuel resource. The agent contract treats the price fields as optional; without them prices are shown as `unknown`.

Agent: `economy` block in the cycle brief (`src/autonomy/economics.ts`): credits, stock by product with price status (`known_configured_quote` / `unknown`), estimated unsold value (quote × stock, explicitly not cash, no forecast), session revenue/cost/credit deltas, depot vs tank fuel, storage capacity "not published (unknown)", the last sale's simulator-reported result, and pooled harvest/sale effects of the last intervals. Sale outcomes (revenue, kg, price) are now captured from the simulator response.

Crop observability: `knownCrop`/`knownGrowthStage` remain null (nothing hidden is exposed). The runtime keeps what Muse planted and the days since, from its own completed `plantField`. **Leak assessment:** `harvestField` eligibility is a binary maturity threshold (98% development), i.e. it does reveal "mature / not mature" from ground truth, but not a percentage; the not-mature reason is already collapsed to `conditions_not_suitable`. A safer alternative (not implemented, proposed): an inspection action returning a noisy maturity estimate with uncertainty and age, and keeping eligibility as the only hard check. A known planting date is not an observed maturity.

## 5–6. Context and continuity

Changes: the brief's snapshot is marked delivered so `observe_snapshot` does not resend it; read results older than the latest successful state change are stubbed (tool-call/result pairing untouched); the recurring action catalog is now `{type: [eligible targets]}` (parameters/estimates via `describe_action`). After a harvest or sale the next brief carries the stock deltas, credits/revenue deltas and the sale result.

Measured with real API usage:

| Run | Model calls | Input tokens | Avg input/call | Cost |
|---|---|---|---|---|
| 4A (p4a-1) | 144 | 1,176,133 | 8,168 | $1.274 |
| 4B run 1 (economics, snapshot-delivered, stale-stub; old catalog) | 150 | 1,220,306 | 8,135 | $1.323 |
| 4B run 2 (+ terse catalog) | 138 | 950,529 | 6,888 | $1.089 |

Avg input per call −15.7% vs 4A (run 2). The economy block adds tokens, so run 1 shows no gain by itself. Per-call figures are comparable; totals are not (different horizon and trajectory).

## 7. Attribution (run 2, from action provenance)

A harvest is `muse_planted` only if a completed `plantField` by this session precedes it on the same field; otherwise `preexisting_or_unknown` (the simulator does not publish the starting crops, so these fields are only "not planted by Muse"). Stock deltas are pooled per observation interval.

- Harvests: 6 (3 Muse-planted soybean fields, 3 pre-existing/unknown). Stock gained: 1,655.1 kg from Muse-planted, 3,969.5 kg from pre-existing/unknown, 0 mixed intervals.
- Revenue is per product sold, not per origin (depot is pooled), so revenue by origin is unknown.

## 8. Live results (isolated, seed 3303, same start: credits 2500, seeds 800/1500/3000 kg, fuel 3000 L)

Reproducibility: world-config sha256 `eef4536795e31d016e0446df15cb2758b9526684a562a1f7865d179edc0bace6` and game-snapshot sha256 `10012faaaa087e0ebb3798b34f57e3b72c148050978d89d7a55dbbe058e73f69` (SHA-256 of `JSON.stringify` of the DB `world_config`/`snapshot` JSON) were identical for both games. The 4A hashes used a different, unrecorded method and are not comparable.

| | 4A | 4B run 1 | 4B run 2 |
|---|---|---|---|
| Simulated days | 200 | 165.4 | 187.2 |
| Stop reason | day limit | model-call budget (150) | mutation budget (25) |
| Model calls / advance requests | 144 / 64 | 150 / 52 | 138 / 58 |
| Actions (plant/harvest/sell) | 25 (8/7/1) | 25 (6/7/6) | 25 (6/6/5) |
| Credits | 2500 → 2722.81 | → 4530.86 | → 4119.01 (verified via API) |
| Revenue / operating costs | 432.2 / 209.4 | 2188.72 / 157.86 | 1774.67 / 155.66 |
| Unsold grain | 5,933 kg | ≈0.45 kg | ≈0.14 kg |
| Fuel consumed (actions) | 223 L | not recorded* | 190.26 L |

\* Run 1 predates the capture of consumed resources for synchronous results; run 1 sale outcomes were not recorded in session state (sold amounts come from the actions' parameters; revenue from the overview).

Run 2 sales (simulator outcomes): wheat 1696.65 kg → 424.16; corn 1668 kg → 333.60; soybean 1305 kg → 587.25; 509 kg → 229.05; 445.79 kg → 200.61. Resumes: 3 (slices of 8 cycles), 0 conflicts, 0 duplicate effects. Muse planted soybean in every case; no irrigation or treatment; one `surveyField`.

**Comparability warning.** 4A and 4B differ in prompt (selling guidance), observations (prices), horizon (166/187 vs 200 days) and stopping rule. The higher cash is consistent with Muse now selling its stock, but this is not a controlled proof: part of the stock came from crops that existed at the start, and LLM decisions are not deterministic. Two runs are not a benchmark.

## 9. Tests

Agent: 115 tests (11 new in `tests/autonomy/economics.test.ts`, all MOCKED: economic summary, fuel labeling, ledger/attribution, brief content, history compaction with call/result pairing, terse catalog). tsc, eslint and build pass. Simulator: `src/server/agent` and `src/simulation/machinery` vitest pass (real simulation, 2 new tests).

## Remaining limitations

- Storage capacity is unmodeled/unknown; price is the configured quote only (no market dynamics).
- Per-harvest yield is only visible as pooled stock deltas; sale revenue cannot be split by crop origin.
- Pre-existing crops are not directly observable, so their origin is "unknown", not proven.
- Displayed quantities are rounded to 3 decimals and can slightly exceed true stock (one rejected sale `insufficient_stock`, then retried).
- Maturity is only exposed via the binary harvest eligibility.
