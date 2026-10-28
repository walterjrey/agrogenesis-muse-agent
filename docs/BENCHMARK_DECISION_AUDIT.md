# Phase 5B — Audit of Muse's agricultural decisions

This audit analyzes the single real Phase 5B run (`p5b-muse`) and the preserved paired baseline (`p5a-baseline`). It did not call the Meta API and did not change either strategy. The run reached 200 simulated days. Results are one paired comparison only: **no statistical significance or general superiority claim is supported**. The baseline is a deterministic reference strategy, not a human competitor.

Evidence labels:

- **Trace fact**: present in preserved action/session state or JSONL tool/model trace.
- **Decision-summary statement**: the model's recorded end-of-cycle summary; evidence of what it said, not proof of hidden internal reasoning.
- **Code fact**: established from the prompt, context builder, or baseline policy.
- **Unknown**: the available observations/traces do not establish it.

## What Muse could observe

**Trace facts.** The initial overview exposed 2500 credits; seed stock of corn 800 kg, soybean 1500 kg and wheat 3000 kg; no grain inventory; configured prices of corn 0.20, wheat 0.25, soybean 0.45 and hay 0.10 credits/kg; machinery and action cost estimates. The action catalog exposed `plantField` with the enum `corn | soybean | wheat`. During the run, `describe_action(plantField)` reported generic field-work, prepared-soil, seed-stock and temperature preconditions, eligible fields, and estimated costs/seed/fuel/duration. It did **not** provide per-crop expected yield, expected profit, crop-specific maturity forecasts or a crop-suitability score. A generic prompt said crops mature on the order of 100 simulated days.

The model could see its own completed plantings and elapsed time since planting. Crop identity/stage in field observations remained unknown; `harvestField` eligibility was the simulator's binary maturity signal. It could observe authorized measurements and eligible actions, not the hidden crop state. Storage capacity was not published. Prices were configured quotes, not forecasts or dynamic market predictions.

**Trace limitation.** Run logs retain model outputs, tool calls/results, message counts and token usage, but not the complete submitted prompt body. The decision summaries therefore help reconstruct what the model reported seeing, but cannot prove every token in each request.

## Timeline and observed consequences

Simulated day is approximately `simTimeS / 60`. The phases below combine the durable action log with the recorded cycle summaries. Proceeds are simulator-reported realized revenue; harvest origin is not always identifiable from the pooled depot.

| Sim day | Decision/action evidence | Economic/agricultural result |
|---:|---|---|
| 0 | Prepared field-4, then planted soybean. **Decision-summary statement:** soybean had the highest known price/kg; the summary also said field-4 was the only field eligible for the productive crop-cycle action at that point. | Preparation and planting used about 9.10 + 3.99 credits. Starting conditions had no harvested-grain inventory. |
| 30–60 | Waited a 30-day checkpoint. At about day 60, harvested field-3 (not planted by Muse), then planted soybean on field-3. | 1731.287 kg wheat entered stock; sale of that wheat realized 432.82 credits. Field-3 planting cost 3.75 credits. The baseline harvested the initial field-3 crop at day 45.2; Muse's harvest was at day 60.1. |
| 90 | Harvested field-2 (not planted by Muse); attempted to sell 1705.683 kg corn, rejected as `insufficient_stock`, re-observed, then sold 1705 kg. Prepared and planted soybean on field-2. | 1705.683 kg corn harvested; 341.00 credits realized on the successful sale, leaving about 0.683 kg. The rejection reserved/consumed nothing. |
| 120 | Harvested field-4 (Muse-planted soybean) and field-1 (not planted by Muse); sold 1299.54 kg soybean; prepared and replanted fields 1 and 4 with soybean. | 699.032 kg from the field-4 harvest and 600.508 kg from field-1 were pooled by product. The sale realized 584.79 credits; the revenue cannot be allocated by crop provenance. |
| 150 | Harvested Muse-planted soybean on field-3, sold 526.3 kg, prepared and replanted field-3 with soybean. | 526.338 kg harvested; sale realized 236.84 credits. |
| 180 | Harvested Muse-planted soybean on field-2, sold 434.64 kg, prepared and replanted field-2 with soybean. | 434.605 kg harvested; sale realized 195.59 credits. The new planting had about 20 days left in the horizon. |
| 200 | Waited the remaining 19.56 days. The final decision summary says no harvest/plant/sell action was eligible and all fields were unobserved. | Full 200-day horizon reached. Final cash 4131.25; revenue 1791.04; costs 159.79; estimated grain-stock value 0.14. Four late soybean plantings remained unharvested and are not valued. |

Totals cross-checked against `sessions/p5b-muse/state.json` and the run traces: 7 completed plantings, 6 completed harvests, 5 completed sales, 25 accepted management mutations, 1 rejected mutation, 60 time advances, 130 model calls and estimated Meta API cost **$0.878**. The successful action quantities, times, costs, fuel and seed usage are in `docs/benchmark/phase5b/actions.csv` and `results.json`; `act-0008` is the rejected sale attempt.

The baseline made 9 plantings and 8 harvests and used a 5-day review cadence (R0–R6 in `src/baseline/policy.ts`). It harvested initial standing crops on fields 3/2/1 at days 45.2/90.4/95.7, versus Muse at 60.1/90.1/120.2. The baseline also harvested its first field-4 soybean at day 95.8; Muse harvested its field-4 soybean at day 120.2. These trace timings are consistent with more frequent baseline review and Muse's 30-day checkpoints, but a single paired run cannot isolate timing as the only cause.

## Findings by question

### Why did Muse repeatedly plant soybean?

**Observed:** All seven successful Muse plantings were soybean. In the first and later cycle summaries the model explicitly said it selected soybean because its quoted price, 0.45 credits/kg, was higher than corn (0.20) and wheat (0.25). Soybean seed was available at the start and remained available; the planting schema allowed all three crops.

**Not established:** There is no trace evidence of a hardcoded soybean rule. Nor is there evidence the model compared net returns, since it did not receive expected crop yields or a crop-specific profitability estimate. The highest unit price alone does not establish highest profit. The repeated choice is consistent with a price-per-kg heuristic expressed in the model's own summaries, but that is not proof of the internal cause.

### Were corn and wheat available and economically comparable?

Both crops were available options in the planting schema and had seed stock. The model received configured quote prices, so nominal price/kg could be compared: soybean > wheat > corn. **Economic return was not meaningfully comparable** from those quotes alone: per-crop expected yield, seed-to-yield conversion, time-to-maturity, and risk-adjusted operating return were not provided. The action estimates provided resource costs for eligible field work, not crop-specific expected revenue. Wheat and corn were harvested and sold from the standing initial crops, demonstrating that the simulator supported those crops; this does not prove a new planting of either would have been more profitable.

### What suitability and financial information did it receive?

It received cash, current seed/grain quantities, configured market quotes, operation estimates, and field/action eligibility. `describe_action(plantField)` exposed generic work/soil/seed/temperature preconditions and `conditions_not_suitable` where applicable. The API did not expose a ranked crop recommendation or expected yield. It could see that a field was ready for planting, but not a field-by-crop profitability or maturity forecast. Starting fields 1–3 had crops already standing, but their identities and stages were hidden.

### Why did harvest timing differ, and were opportunities missed?

**Observed:** Muse used waits/checkpoints that advanced roughly 30 days at a time when no action appeared ready. Its trace shows harvests at days 60.1, 90.1, 120.2, 120.2, 150.3 and 180.4. The baseline checked more often under R6's five-day cadence. On field-3, baseline's successful harvest was day 45.2 versus Muse's day 60.1; on field-1, day 95.7 versus 120.2; on field-4's first soybean, day 95.8 versus 120.2. Field-2's initial crop was harvested at nearly the same time (90.4 vs. 90.1).

**Assessment:** Coarser checkpoints plausibly delayed detection of eligibility on fields 3, 1 and 4; exact readiness instants are not logged, so the baseline's harvest times are comparison points, not proof of the precise missed-ready duration in Muse's game. Muse did harvest all actions it later observed as eligible. The final cycle reported no eligible harvest. No bulk harvested stock remained unsold at the end; Muse sold its marketable harvests, with only rounding-scale residue and one corrected rejected attempt. The trace does not show a clearly eligible, bulk harvest or sale left unacted upon at day 200.

### Did crop-stage observability limit decisions?

Yes, materially. There were no direct crop identity or growth-stage observations for standing crops. Muse knew identity/date only for its own successful plantings, and relied on `harvestField` eligibility as a binary maturity signal. It could not directly forecast a particular standing crop's maturity or inspect a maturity percentage. It performed no `inspectField` or `surveyField` calls. Initial crop identity/provenance and the exact standing-crop yields therefore remain unknown through the authorized observation API.

### How did the 200-day horizon affect planning?

**Observed:** The controller brief included the remaining simulated-time budget, and the system prompt stated an approximate 100-day crop maturation period. Muse planted new soybean crops around days 120, 120, 150 and 180; none of those later plantings was harvested by day 200. At day 200 the remaining budget was exhausted and the model chose to stop/hold.

**Interpretation:** Late plantings were inconsistent with realizing a harvest inside the remaining horizon under the generic 100-day guidance (especially the day-150 and day-180 plantings). The summaries say the model wanted to keep fields productive, but do not establish whether it intentionally valued post-horizon production or underweighted the horizon. The run did not assign value to standing crops, so their economic contribution is unknown rather than zero.

### Did context compression lose important information?

**Code facts:** Each cycle includes the current snapshot, operational record, economy summary, previous plan and the last three decision summaries. The operational record reconstructs the model's own current plantings and days-since-planting from successful actions; it retains recent completed operations. The economy summary includes cash, stock/prices, recent pooled ledger effects and last sale. Tool-call/result pairing is preserved within each model run. Older summaries are not all repeated indefinitely.

**Unknown:** The trace does not retain complete submitted prompt bodies, and there is no evidence that losing an older summary caused the crop choices, delays or late planting. Current planted crop/date was available in the operational record. It would be unsupported to attribute the outcomes to compression.

### Why did neither strategy irrigate or treat pests?

**Baseline — code fact:** R0–R6 never select irrigation, pest treatment, field inspection or scouting. This is a fixed simplicity limitation of the reference policy, not a model decision.

**Muse — trace fact:** The initial action catalog listed irrigation and pest treatment as eligible, with estimated costs/water; the model never executed either. Its cycle-3 summary said field-3 had a fresh crop-health value around 0.52, water around 0.95 and vegetation around 0.97, and said observations did not justify irrigation/treatment. Other summaries repeatedly describe field measurements as unknown. No pest-pressure inspection was made, so the trace does not establish pest pressure across the farm. The only supported explanation is that no treatment/irrigation decision appears in the action trace; the model's stated rationale at that point was insufficient evidence. It is not possible to determine whether there was unobserved disease or pest damage.

### Can still-growing crops be valued?

No defensible value can be calculated from these traces. Planting dates and crop identities for Muse's own four late soybean stands are known, but their stage, remaining time, final yield, risk and future input costs are not. Initial standing crop identities are also hidden. The known configured sale quote is not a forecast of the quantity or timing that could be sold. Accordingly, the four stands are excluded from the estimated total economic position, not treated as worthless.

## Proposed improvements, ranked by expected impact

These are proposals only; none is implemented in this task.

1. **Horizon-aware crop planning.** Include remaining days next to the generic crop-cycle guidance and require the agent to compare the remaining horizon against known/estimated time to harvest before planting. Do not invent a crop forecast; if crop-specific time/yield is unavailable, state that uncertainty. This directly addresses four late unharvested plantings.
2. **Crop-specific economic decision support.** Provide only simulator-authorized facts: seed quantity/cost, quoted price, available action estimates and, if the simulator can safely expose it, clearly labeled historical/estimated yield and crop-cycle ranges. Keep forecasts separate from known observations and leave crop selection to Muse.
3. **More timely maturity checks.** Test shorter checkpoint intervals near expected maturity or an authorized maturity/inspection signal, balancing API calls and simulated opportunity cost. Do not infer hidden maturity from planting date.
4. **Targeted agronomic inspection.** Make the cost, coverage and information returned by inspect/survey tools explicit; use noisy observations to decide if irrigation/treatment is justified. Never treat missing pest observations as evidence of no pests.
5. **Explicit sales rounding.** Derive sell quantity from observed stock rounded safely below available quantity, then verify the result. This should prevent the observed `insufficient_stock` rejection while preserving conservative resource validation.
6. **Decision-context retention audit.** Preserve a compact, factual decision ledger with current planted crops/dates, horizon, recent observations, unresolved operations and sales. Capture prompt fingerprints or redacted structured context summaries in future runs so claims about context loss can be tested without exposing credentials.

## Fair test plan for a later improved agent

1. Freeze this run and the baseline rules R0–R6 as immutable reference artifacts; do not tune the baseline after viewing results.
2. Before each paired comparison, create independent same-seed games, verify authoritative snapshot/world-config fingerprints (including RNG), and verify authorized-observation equivalence before either strategy acts.
3. Run the existing agent and the improved version against separate but identical initial states, same simulator build, permissions, equipment, market, 200-day horizon and explicit budgets. Use the same observation/action APIs; do not expose hidden simulator state.
4. Keep model version/configuration and limits fixed before the run. Preserve all requests, actions, rejections, observations, resume events, costs and failures. Do not silently retry with expanded budgets or discard partial runs.
5. Run multiple predeclared seeds and, for the stochastic model, repeated runs per seed if budget permits. Report paired per-run values and uncertainty; do not claim superiority from one pair.
6. Separate cash, realized revenue, expenses, inventory value estimates, attributable production, pre-existing/unknown harvests and unvalued standing crops. Keep mocked tests distinct from live simulator/model evidence.

## Evidence files

- `docs/BENCHMARK_RESULTS.md` and `docs/benchmark/phase5b/{results.json,results.csv,actions.csv,harvests.csv}`
- `sessions/p5b-muse/state.json` and `sessions/p5b-muse/runs/*.jsonl`
- `sessions/p5a-baseline/state.json`
- `docs/BENCHMARK_FOUNDATION.md` (fingerprint and R0–R6 details)
- `src/autonomy/prompt.ts`, `src/autonomy/progress.ts`, `src/autonomy/economics.ts`
- `src/baseline/policy.ts`
