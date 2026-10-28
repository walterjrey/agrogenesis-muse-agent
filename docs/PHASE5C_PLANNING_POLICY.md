# Phase 5C planning policy (version `phase5c-v1`)

The versioned configuration is `config/phase5c-planning-v1.json`. Every new session stores its `policyVersion` and optional explicit `horizonDays` in `state.json` and reports them. A horizon is measured from the first authorized observation and is separate from the hard simulated-time budget. Resume cannot replace it.

## What the agent can compare

The new `compare_crop_options` tool and each cycle's `planning` block derive only from the consistent `/api/agent/v1` snapshot:

- crop names supported by the authorized `plantField` parameter enum;
- configured sale quotes when finance observations are authorized;
- observed seed/grain quantities;
- currently eligible planting targets and the simulator's planting action previews;
- current cash, realized revenue/costs, available resources, pending operations, and reported observation freshness.

The catalog's plant estimate is reported per field as returned and explicitly **not crop-specific**. A quoted price per kilogram cannot be converted into expected profit without yield and input-cost assumptions. Expected yield, crop-specific duration, seed rate, water requirement and profit per area stay `null`/unknown. No simulator internals, hidden crops/stages, future weather, RNG state or scenario outcomes are used. No crop is preferred by the tool or runtime.

The existing system prompt contains only generic guidance that crop cycles take about 100 simulated days. Phase 5C labels this as an approximate, non-crop-specific estimate, not a simulator guarantee or a maturity reading. It is used only to communicate planning uncertainty and schedule reviews; harvest eligibility remains the simulator's observable readiness signal.

## Horizon and review scheduling

Start a new run with an explicit horizon when the evaluation defines one:

```powershell
npx tsx scripts\agent-autonomous.ts start --game-id <authorized-game-id> `
  --enable-mutations --max-sim-days 200 --planning-horizon-days 200 `
  --max-cost-usd <fixed-budget> --max-model-calls <fixed-budget> --max-mutations <fixed-budget>
```

The planning brief shows current day, start/end day, days remaining, the independent session time budget, known own planting commitments, a generic maturity estimate marked as uncertain, and whether that estimate falls past the experiment horizon. This is informational; it does not prevent late planting.

When Muse calls `wait_for_checkpoint`, it still chooses a wait up to 30 days and an internal checkpoint interval. The runtime only bounds these requests:

- at/after the generic planting review window (75–115 days), maximum model wait 5 days and internal checkpoints 2 days;
- far from that window, internal checkpoints are at most 10 days, but the model's requested wait is preserved;
- configured experiment horizon clamps remaining wait;
- known pending completion, stale/expired critical measurements, or recent material events shorten review.

Internal checkpoints and event interruption do not issue model calls. The supervisor still returns on material events and never selects or performs a farm action. The manifest records every threshold and the provenance/unknown policy. No threshold uses the simulator's hidden 98% harvest rule.

## Evaluation discipline

Treat Phase 5C as a new agent version. Keep Phase 5B output and traces immutable and keep baseline R0–R6 unchanged. Before any future live test, freeze this policy/config manifest and model/budget settings, verify same-seed authoritative fingerprints and authorized-observation equality, and preserve partial/failing runs. Compare paired runs over multiple predeclared seeds and repeated Muse trials if budget allows; report single-run differences without significance claims. Do not select or tune a policy based only on seed 3303.
