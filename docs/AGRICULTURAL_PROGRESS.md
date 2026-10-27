# Phase 3C — Agricultural progress report

## 1. Simulation-time diagnosis (simulator read-only + live probes)

| Item | Value |
|---|---|
| Fixed tick | 0.1 s (`FIXED_STEP_SECONDS`) |
| 1 simulated day | 60 s = 600 ticks |
| Per-request cap | 14,400 s (= 240 days), server loops `advance` in 50-tick chunks |
| Granted vs requested | Equal below the cap; above it `granted_limit_reached` |

Measured on a throwaway game (requested → granted, wall time): 5 s → 5 (196 ms); 60 s → 60 (143 ms);
600 s → 600 (326 ms); 3,600 s → 3,600 (1.1 s); 14,400 s → 14,400 (3.0 s); 20,000 s → 14,400 (3.0 s).

- The Phase 3B "only 5 s granted" was **not** a server limit: Muse itself requested 5 s with
  `stopOn:["action_completion"]`.
- One hour of simulated time = 1 request; one day = 1 request. Completing `prepareSoil` needs 1–2
  requests. There is **no HTTP bottleneck**; the bottlenecks were the model choosing tiny advances,
  polling, and ~9k tokens of context per call. No simulator change was needed.
- Long advances execute every tick, so no engine events are skipped. Server `stopOn` only covers action
  completion/new observations; weather/equipment events are detected by the supervisor between chunks.
- Action durations are real simulated time and can exceed the catalog estimate (`prepareSoil`
  estimated 1.0 s, observed ~11 s in Phase 3B), so the supervisor does not trust estimates.

## 2. Token profile (chars, demo game)

System prompt 2,081 · 8 tool definitions 6,341 · cycle brief 13,042 · raw catalog 51,796 ·
compact catalog 9,414.

Real input tokens per model call: Phase 3B baseline ≈ 8.9k average. Phase 3C live:
`p3c-1` 182,878 input / 24 calls ≈ **7.6k per call** (51,976 cached); `p3c-2` 46,689 / 6 ≈ 7.8k.
That is ≈ 14% lower, **not** a large reduction: the system prompt and tool definitions are fixed cost
and per-call context still grows within a cycle. The catalog digest and history stubs are
implemented; their isolated effect was not measured separately.

## 3. Live demonstration (real Meta `muse-spark-1.3`, real simulator, isolated PostgreSQL)

Game `39148f3e…` (Muse mode, seed 3303). Nothing scripted; limits were upper bounds.

**Session `p3c-1`** (≤4 mutations, ≤3 days, ≤30 calls, ≤$1) — stopped `mutation_budget_exhausted 4/4`.
Muse chose, in order: `prepareSoil` field-4 (completed at sim 1.1 s) → `inspectField` field-4 →
`plantField` field-4 (completed at 5.6 s) → `inspectField` field-4 (at 70 s). 24 model calls,
22 tool calls, 6 advance requests, 74.6 s simulated (1.24 days), tokens 182,878 in / 10,829 out,
**$0.217**. Credits 2500 → 2436.91 (−63.09).

**Session `p3c-2`** (≤3 mutations): Muse inspected field-1, field-2 and field-3 (3 × 25 credits).
During this run the CLI process was killed mid-session (my output filter closed the pipe), which
accidentally exercised a real process-level crash; `agent:resume` in a new process continued, with
nothing replayed. Totals: 3 actions completed, 4 advance requests, 15.5 s simulated, 6 model calls,
46,689 in / 3,731 out, **$0.051**. Credits 2436.91 → 2361.91 (−75).

**Independent check** (simulator overview): revision 18, simTime 90.1 s (tick 901), credits 2361.91
= 2500 − 63.09 − 75; seeds: corn 800 kg, soybean 1500 kg, wheat 2811 kg. No duplicate charge.

### Outcomes against the objective

| Goal | Result |
|---|---|
| prepareSoil finishes under supervision | Yes (live) |
| Muse then chooses the next action itself | Yes: it chose `plantField` and it completed |
| Full crop cycle | **No.** Crop was planted at 5.6 s; the session ended at ~1.5 days, far short of growth/harvest. No revenue |
| Muse-driven decisions | Mix of inspections and planting; the choice of planting is Muse's, unforced |

Totals across both sessions: 30 model calls, 10 advance requests, ~90 s simulated, 229,567 input /
14,560 output tokens, ≈ **$0.268**.

## 4. Not verified live

HTTP 409 recovery, lost-response/timeout replay, and long (multi-day) supervised waits are verified
only with mocks (`tests/autonomy/supervisor.test.ts`). Crop growth stage and which crop was planted
were not read back by the agent (`knownCrop` stays null: partial observability). There are no
real-PostgreSQL automated tests in this repository.

## 5. Remaining bottlenecks

- Context still ~7–9k tokens/call; Muse spends many calls on `describe_action`/observation.
- A mutation budget of 4 ended `p3c-1` before any long advance; a crop cycle needs a larger
  sim-day budget with a lower mutation count and a sensible number of waiting-only cycles.
- Crop growth is only visible through inspections; there is no automatic "review point" trigger.
- Farm-spend limit is approximate (not enforced inside a cycle).
