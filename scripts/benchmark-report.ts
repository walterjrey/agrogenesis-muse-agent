/**
 * Builds the machine-readable Phase 5B comparison (JSON + CSV) from two preserved session states.
 * Muse's final outcome is read live from the authorized agent API (read-only); the baseline's is the preserved one.
 * Usage: tsx scripts/benchmark-report.ts --baseline <sessionId> --muse <sessionId> --out docs/benchmark/<name>
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SimulatorClient } from "../src/simulator/client.js";
import { compareOutcome, outcomeSnapshot, type OutcomeSnapshot } from "../src/benchmark/outcome.js";
import { attributeProduction, type AttributionAction } from "../src/benchmark/attribution.js";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const load = (id: string) => JSON.parse(readFileSync(resolve("sessions", id, "state.json"), "utf8"));
const loadRejectedAttempts = (sessionId: string): RawAction[] => {
  const traceDirectory = resolve("sessions", sessionId, "runs");
  const events = readdirSync(traceDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(resolve(traceDirectory, name), "utf8").split(/\r?\n/).filter(Boolean))
    .map((line) => JSON.parse(line) as {
      event: string;
      name?: string;
      result?: { action?: { actionId: string; type: string; status: string; requestedAtS?: number; startedAtS?: number | null; finishedAtS?: number | null; failure?: { detail?: string } }; args?: { type: string; params: Record<string, unknown> } };
    });
  return events.flatMap((event) => {
    if (event.event !== "tool.result" || event.name !== "execute_action" || event.result?.action?.status !== "rejected") return [];
    const action = event.result.action;
    return [{
      actionId: action.actionId,
      type: action.type,
      status: action.status,
      params: event.result.args?.params ?? {},
      startedAtS: action.startedAtS ?? null,
      finishedAtS: action.finishedAtS ?? null,
      measurements: {},
    }];
  });
};

interface RawAction extends AttributionAction {
  actionId?: string;
  creditsConsumed?: number;
  consumedCredits?: number;
  consumedFuelL?: number;
  consumedSeedKg?: number;
  consumedWaterM3?: number;
}

function actionSummary(actions: RawAction[]) {
  const byType: Record<string, number> = {};
  let fuelL = 0, seedKg = 0, waterM3 = 0, credits = 0;
  for (const a of actions) {
    byType[a.type] = (byType[a.type] ?? 0) + 1;
    fuelL += a.consumedFuelL ?? a.measurements.fuelUsedL ?? 0;
    seedKg += a.consumedSeedKg ?? a.measurements.seedUsedKg ?? 0;
    waterM3 += a.consumedWaterM3 ?? a.measurements.waterDeliveredM3 ?? 0;
    credits += a.creditsConsumed ?? a.consumedCredits ?? 0;
  }
  return { byType, total: actions.length, fuelUsedByOperationsL: round(fuelL, 3), seedUsedKg: round(seedKg, 3), waterDeliveredM3: round(waterM3, 3), actionCreditsConsumed: round(credits) };
}

async function main() {
  const baseline = load(arg("baseline"));
  const muse = load(arg("muse"));
  const museRejectedAttempts = loadRejectedAttempts(muse.sessionId);
  const client = new SimulatorClient({ baseUrl: process.env.SIMULATOR_BASE_URL ?? "http://localhost:3100", agentToken: process.env.SIMULATOR_AGENT_TOKEN ?? "", timeoutMs: 30000 });
  const museFinal: OutcomeSnapshot = outcomeSnapshot(await client.getFarmOverview(muse.gameId));
  const start: OutcomeSnapshot = baseline.startOutcome;
  const baseFinal: OutcomeSnapshot = baseline.finalOutcome;
  const prices = museFinal.marketPricesPerKg;

  const museCompare = compareOutcome(start, museFinal);
  const baseCompare = compareOutcome(start, baseFinal);
  const museAttr = attributeProduction(muse.actions, prices);
  const baseAttr = attributeProduction(baseline.actions, prices);
  const museActions = actionSummary(muse.actions);
  const baseActions = actionSummary(baseline.actions);

  const museTools: Record<string, number> = {};
  for (const d of muse.decisions) for (const [k, v] of Object.entries(d.tools as Record<string, number>)) museTools[k] = (museTools[k] ?? 0) + v;
  const u = muse.usage as { inputTokens: number; outputTokens: number; cachedTokens: number };
  const museComplete = muse.budgets.advancedSimSeconds >= 12000 && museFinal.simDay >= 200;

  const report = {
    generatedAt: new Date().toISOString(),
    note: "One paired run. No statistical significance or general superiority can be inferred.",
    scenario: { seed: baseline.scenario.seed, horizonDays: 200, initialStateFingerprint: baseline.scenario.initialStateFingerprint },
    initial: start,
    strategies: {
      baseline: {
        kind: "deterministic reference strategy (non-LLM)",
        sessionId: baseline.runId,
        gameId: baseline.gameId,
        status: baseline.status,
        stopReason: baseline.stopReason,
        complete: baseFinal.simDay >= 200,
        final: baseFinal,
        comparison: baseCompare,
        attribution: baseAttr,
        actions: baseActions,
        inspections: 0,
        advanceRequests: baseline.counters.advanceRequests,
        rejections: baseline.counters.rejections,
        conflicts: baseline.counters.conflicts,
      },
      muse: {
        kind: "Meta Muse Spark 1.3 autonomous agent",
        sessionId: muse.sessionId,
        gameId: muse.gameId,
        modelId: muse.config.modelId,
        status: muse.status,
        stopReason: muse.stopReason,
        stopDetail: muse.stopDetail,
        complete: museComplete,
        limits: muse.config.limits,
        final: museFinal,
        comparison: museCompare,
        attribution: museAttr,
        actions: museActions,
        toolCalls: museTools,
        advanceRequests: muse.budgets.advanceRequests,
        rejectedActions: muse.budgets.rejectedActions,
        conflicts: muse.budgets.conflicts,
        cycles: muse.cycle,
        api: {
          modelCalls: muse.budgets.modelCalls,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedTokens: u.cachedTokens,
          estimatedCostUsd: round(muse.budgets.costUsd, 4),
          wallClockMs: muse.budgets.wallClockMs,
        },
      },
    },
  };

  const outDir = resolve(arg("out"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "results.json"), JSON.stringify(report, null, 2) + "\n");

  const rows: Array<[string, unknown, unknown]> = [
    ["complete_200_days", report.strategies.baseline.complete, museComplete],
    ["initial_credits", start.credits, start.credits],
    ["final_credits", baseFinal.credits, museFinal.credits],
    ["cash_delta", baseCompare.netCashChange, museCompare.netCashChange],
    ["realized_revenue", baseCompare.realizedRevenue, museCompare.realizedRevenue],
    ["operational_expenses", baseCompare.operationalExpenses, museCompare.operationalExpenses],
    ["final_inventory_value_estimate", baseFinal.estimatedInventoryValue, museFinal.estimatedInventoryValue],
    ["total_estimated_position", baseFinal.totalEstimatedValue, museFinal.totalEstimatedValue],
    ["total_estimated_change", baseCompare.totalEstimatedValueChange, museCompare.totalEstimatedValueChange],
    ["actions_total", baseActions.total, museActions.total],
    ["rejected_action_attempts", baseline.counters.rejections, muse.budgets.rejectedActions],
    ["plantings", baseAttr.plantings, museAttr.plantings],
    ["harvests_planted_by_strategy", baseAttr.plantedByStrategy.harvests, museAttr.plantedByStrategy.harvests],
    ["grain_kg_planted_by_strategy", baseAttr.plantedByStrategy.grainKg, museAttr.plantedByStrategy.grainKg],
    ["harvests_not_planted_by_strategy", baseAttr.notPlantedByStrategy.harvests, museAttr.notPlantedByStrategy.harvests],
    ["grain_kg_not_planted_by_strategy", baseAttr.notPlantedByStrategy.grainKg, museAttr.notPlantedByStrategy.grainKg],
    ["fuel_used_by_operations_L", baseActions.fuelUsedByOperationsL, museActions.fuelUsedByOperationsL],
    ["seed_used_kg", baseActions.seedUsedKg, museActions.seedUsedKg],
    ["advance_requests", baseline.counters.advanceRequests, muse.budgets.advanceRequests],
    ["model_calls", "", muse.budgets.modelCalls],
    ["input_tokens", "", u.inputTokens],
    ["output_tokens", "", u.outputTokens],
    ["cached_tokens", "", u.cachedTokens],
    ["estimated_api_cost_usd", "", round(muse.budgets.costUsd, 4)],
  ];
  writeFileSync(resolve(outDir, "results.csv"), ["metric,baseline,muse", ...rows.map((r) => r.join(","))].join("\n") + "\n");

  const harvestRows = [
    ["strategy,fieldId,harvestedAtDay,grainKg,provenance,crop"],
    ...(["baseline", "muse"] as const).flatMap((s) => (s === "baseline" ? baseAttr : museAttr).harvests.map((h) => `${s},${h.fieldId},${h.harvestedAtDay},${h.grainKg},${h.provenance},${h.crop ?? "unknown"}`)),
  ];
  writeFileSync(resolve(outDir, "harvests.csv"), harvestRows.join("\n") + "\n");

  const actionRows = [
    ["strategy,actionId,type,fieldOrProduct,kg,status,startedAtS,finishedAtS"],
    ...(["baseline", "muse"] as const).flatMap((s) =>
      [...(s === "baseline" ? baseline.actions : muse.actions), ...(s === "muse" ? museRejectedAttempts : [])].map((a: RawAction) => `${s},${a.actionId ?? ""},${a.type},${(a.params.fieldId as string) ?? (a.params.product as string) ?? ""}${a.params.crop ? `:${a.params.crop}` : ""},${a.params.kg ?? ""},${a.status},${a.startedAtS ?? ""},${a.finishedAtS ?? ""}`),
    ),
  ];
  writeFileSync(resolve(outDir, "actions.csv"), actionRows.join("\n") + "\n");
  console.log(JSON.stringify({ outDir, museComplete, museFinal: { credits: museFinal.credits, day: museFinal.simDay }, museCompare, museAttr: museAttr.plantedByStrategy, notPlanted: museAttr.notPlantedByStrategy }, null, 1));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
