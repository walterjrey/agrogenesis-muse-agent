import type { SessionState } from "./types.js";

/** The simulator\u0027s DAY_SECONDS: one simulated day is 60 simulated seconds. */
const SECONDS_PER_SIM_DAY = 60;
const delta = (a: number | null | undefined, b: number | null | undefined): number | null => (typeof a === "number" && typeof b === "number" ? Math.round((b - a) * 100) / 100 : null);

/**
 * Measured session report. Every value is either read from the simulator/model responses or null when it was not
 * observable; nothing is estimated or filled in. The shape is intentionally flat and stable so that a later
 * Manual-vs-Muse comparison can use the same fields.
 */
export function buildReport(state: SessionState) {
  const { baseline, latest } = state.metrics;
  const water = (o: typeof baseline) => o?.resources.find((r) => r.kind === "water")?.quantity ?? null;
  const toolCalls = state.decisions.reduce<Record<string, number>>((acc, d) => {
    for (const [name, count] of Object.entries(d.tools)) acc[name] = (acc[name] ?? 0) + count;
    return acc;
  }, {});
  const sum = (xs: Array<number | null>): number => Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0) * 100) / 100;
  const byType = (type: string) => state.actions.filter((a) => a.type === type);
  const done = (type: string) => byType(type).filter((a) => a.status === "completed");
  const costsByType = state.actions.reduce<Record<string, number>>((acc, a) => (a.consumedCredits === null ? acc : { ...acc, [a.type]: Math.round(((acc[a.type] ?? 0) + a.consumedCredits) * 100) / 100 }), {});
  const lifecycle = {
    plantings: done("plantField").map((a) => ({ fieldId: a.target, crop: a.params.crop ?? null, atSimTimeS: a.finishedAtS })),
    inspections: state.actions.filter((a) => a.type.startsWith("inspect") || a.type.startsWith("survey") || a.type === "sampleSoil").length,
    irrigations: { count: done("irrigateField").length, waterM3Consumed: sum(done("irrigateField").map((a) => a.consumedWaterM3)) },
    treatments: done("applyTreatment").length,
    harvests: done("harvestField").map((a) => ({ fieldId: a.target, atSimTimeS: a.finishedAtS, outcome: a.outcome })),
    sales: done("sellHarvest").map((a) => ({ product: a.params.product ?? null, kg: a.params.kg ?? null, atSimTimeS: a.finishedAtS, outcome: a.outcome })),
    harvestedGrainPeakKg: state.metrics.grainPeakKg,
    actionCreditsByType: costsByType,
    seedConsumedKg: sum(state.actions.map((a) => a.consumedSeedKg)),
    fuelConsumedL: sum(state.actions.map((a) => a.consumedFuelL)),
    netCreditsResult: delta(baseline?.credits, latest?.credits),
    cropCycleCompleted: done("harvestField").length > 0 && done("sellHarvest").length > 0,
  };
  const attribution = buildAttribution(state);
  const submitted = state.budgets.acceptedMutations + state.budgets.acceptedInspections + state.budgets.rejectedActions;
  return {
    sessionId: state.sessionId,
    gameId: state.gameId,
    model: state.config.modelId,
    status: state.status,
    stopReason: state.stopReason,
    stopDetail: state.stopDetail,
    mutationsEnabled: state.config.mutationsEnabled,
    cycles: state.cycle,
    decisions: state.decisions.length,
    toolCalls: { total: state.budgets.toolCalls, byTool: toolCalls },
    actions: {
      submitted,
      accepted: state.budgets.acceptedMutations,
      rejected: state.budgets.rejectedActions,
      completed: state.actions.filter((a) => a.status === "completed").length,
      failed: state.actions.filter((a) => a.status === "failed").length,
      inFlight: state.actions.filter((a) => a.status === "scheduled" || a.status === "running").length,
    },
    inspections: {
      accepted: state.budgets.acceptedInspections,
      attempts: state.budgets.inspectionAttempts,
      rejected: state.budgets.rejectedInspections,
      limit: state.config.limits.maxInspections,
    },
    pendingMutation: state.pendingMutation ? { tool: state.pendingMutation.tool, idempotencyKey: state.pendingMutation.idempotencyKey } : null,
    time: { advancedSimSeconds: state.budgets.advancedSimSeconds, simulatedDaysElapsed: Math.round((state.budgets.advancedSimSeconds / SECONDS_PER_SIM_DAY) * 1000) / 1000, advanceRequests: state.budgets.advanceRequests, lastSimTimeS: state.lastSimTimeS },
    waits: { count: state.waits.length, byOutcome: state.waits.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.outcome]: (acc[w.outcome] ?? 0) + 1 }), {}), byTrigger: { model_tool: state.waits.filter((w) => w.trigger === "model_tool").length, controller: state.waits.filter((w) => w.trigger === "controller").length } },
    progress: state.progress,
    scenario: state.config.scenario,
    planning: state.config.planning,
    lifecycle,
    attribution,
    farm: {
      revision: { first: baseline?.revision ?? null, last: latest?.revision ?? null },
      credits: { first: baseline?.credits ?? null, last: latest?.credits ?? null, delta: delta(baseline?.credits, latest?.credits) },
      realizedRevenueDelta: delta(baseline?.realizedRevenue, latest?.realizedRevenue),
      realizedCostsDelta: delta(baseline?.realizedCosts, latest?.realizedCosts),
      waterStockDelta: delta(water(baseline), water(latest)),
      resourcesLast: latest?.resources ?? null,
      fieldsLast: latest?.fields ?? null,
    },
    model_usage: { ...state.usage, modelCalls: state.budgets.modelCalls, failedModelCalls: state.budgets.failedModelCalls, modelRetryAttempts: state.budgets.modelRetryAttempts, estimatedCostUsd: Math.round(state.budgets.costUsd * 1e6) / 1e6 },
    budgets: { used: state.budgets, limits: state.config.limits },
    observation: { controllerReads: state.metrics.controllerReads, snapshotRefreshes: state.metrics.snapshotRefreshes, snapshotCacheHits: state.metrics.snapshotCacheHits, mixedRevisionDetections: state.metrics.mixedRevisionDetections },
    notes: "Null means not observable. Farm-outcome deltas describe this session only and are not a comparison against Manual management.",
  };
}

/**
 * Attribution from this session's own action provenance (who planted what), never from timing alone. A harvest is
 * "muse_planted" only when a completed plantField by this session precedes it on the same field; otherwise its origin
 * is "preexisting_or_unknown": the simulator does not publish the crops present at the start, so those fields are
 * not provably pre-existing, only not planted by Muse in this session. Stock deltas are pooled per observation
 * interval because the depot does not record which harvest produced which kilogram.
 */
export function buildAttribution(state: SessionState) {
  const { baseline, latest, ledger } = state.metrics;
  const plantings = state.actions.filter((a) => a.type === "plantField" && a.status === "completed" && a.finishedAtS !== null);
  const harvests = state.actions.filter((a) => a.type === "harvestField" && a.status === "completed" && a.finishedAtS !== null);
  const origin = new Map<string, { origin: "muse_planted" | "preexisting_or_unknown"; plantingActionId: string | null; crop: string | null }>();
  const harvestRows = harvests.map((h) => {
    const planting = plantings.filter((p) => p.target === h.target && p.finishedAtS! <= h.finishedAtS!).at(-1) ?? null;
    const row = planting ? { origin: "muse_planted" as const, plantingActionId: planting.actionId, crop: typeof planting.params.crop === "string" ? planting.params.crop : null } : { origin: "preexisting_or_unknown" as const, plantingActionId: null, crop: null };
    origin.set(h.actionId, row);
    return { actionId: h.actionId, fieldId: h.target, atSimTimeS: h.finishedAtS, ...row };
  });
  const intervals = ledger.map((e) => {
    const origins = new Set(e.harvestActionIds.map((id) => origin.get(id)?.origin ?? "preexisting_or_unknown"));
    const attributed = origins.size === 0 ? "no_harvest_in_interval" : origins.size === 1 ? [...origins][0]! : "mixed_pooled";
    return { ...e, harvestOrigin: attributed };
  });
  const grain = (o: typeof baseline) => Object.fromEntries((o?.resources ?? []).filter((r) => r.kind === "grain").map((r) => [r.id, r.quantity]));
  const sales = state.actions.filter((a) => a.type === "sellHarvest" && a.status === "completed");
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const sumKg = (rows: typeof intervals, predicate: (origin: string) => boolean) => round2(rows.filter((r) => predicate(r.harvestOrigin)).reduce((s, r) => s + Object.values(r.grainDeltaKg).filter((v) => v > 0).reduce((a, b) => a + b, 0), 0));
  return {
    method: "action provenance (completed plantField before harvestField on the same field) + pooled depot-stock deltas between consecutive authorized observations",
    initialGrainStockKg: grain(baseline),
    finalGrainStockKg: grain(latest),
    harvests: harvestRows,
    harvestCountByOrigin: { muse_planted: harvestRows.filter((h) => h.origin === "muse_planted").length, preexisting_or_unknown: harvestRows.filter((h) => h.origin === "preexisting_or_unknown").length },
    positiveStockGainKgByHarvestOrigin: { muse_planted: sumKg(intervals, (o) => o === "muse_planted"), preexisting_or_unknown: sumKg(intervals, (o) => o === "preexisting_or_unknown"), mixed_pooled: sumKg(intervals, (o) => o === "mixed_pooled") },
    intervals,
    sales: sales.map((s) => ({ actionId: s.actionId, product: s.params.product ?? null, kg: s.params.kg ?? null, atSimTimeS: s.finishedAtS, outcome: s.outcome, measurements: s.measurements, consumedCredits: s.consumedCredits })),
    realizedRevenue: baseline?.realizedRevenue != null && latest?.realizedRevenue != null ? round2(latest.realizedRevenue - baseline.realizedRevenue) : null,
    operatingCostsDelta: baseline?.realizedCosts != null && latest?.realizedCosts != null ? round2(latest.realizedCosts - baseline.realizedCosts) : null,
    netCashChange: baseline?.credits != null && latest?.credits != null ? round2(latest.credits - baseline.credits) : null,
    unsoldInventoryKg: grain(latest),
    note: "Revenue from sales is attributed to the sold product, not to who planted it; the depot pools all harvests, so revenue per origin is unknown unless only one origin existed.",
  };
}
