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
  const submitted = state.budgets.acceptedMutations + state.budgets.rejectedActions;
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
    pendingMutation: state.pendingMutation ? { tool: state.pendingMutation.tool, idempotencyKey: state.pendingMutation.idempotencyKey } : null,
    time: { advancedSimSeconds: state.budgets.advancedSimSeconds, simulatedDaysElapsed: Math.round((state.budgets.advancedSimSeconds / SECONDS_PER_SIM_DAY) * 1000) / 1000, advanceRequests: state.budgets.advanceRequests, lastSimTimeS: state.lastSimTimeS },
    waits: { count: state.waits.length, byOutcome: state.waits.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.outcome]: (acc[w.outcome] ?? 0) + 1 }), {}), byTrigger: { model_tool: state.waits.filter((w) => w.trigger === "model_tool").length, controller: state.waits.filter((w) => w.trigger === "controller").length } },
    progress: state.progress,
    scenario: state.config.scenario,
    lifecycle,
    farm: {
      revision: { first: baseline?.revision ?? null, last: latest?.revision ?? null },
      credits: { first: baseline?.credits ?? null, last: latest?.credits ?? null, delta: delta(baseline?.credits, latest?.credits) },
      realizedRevenueDelta: delta(baseline?.realizedRevenue, latest?.realizedRevenue),
      realizedCostsDelta: delta(baseline?.realizedCosts, latest?.realizedCosts),
      waterStockDelta: delta(water(baseline), water(latest)),
      resourcesLast: latest?.resources ?? null,
      fieldsLast: latest?.fields ?? null,
    },
    model_usage: { ...state.usage, modelCalls: state.budgets.modelCalls, estimatedCostUsd: Math.round(state.budgets.costUsd * 1e6) / 1e6 },
    budgets: { used: state.budgets, limits: state.config.limits },
    observation: { controllerReads: state.metrics.controllerReads, snapshotRefreshes: state.metrics.snapshotRefreshes, snapshotCacheHits: state.metrics.snapshotCacheHits, mixedRevisionDetections: state.metrics.mixedRevisionDetections },
    notes: "Null means not observable. Farm-outcome deltas describe this session only and are not a comparison against Manual management.",
  };
}
