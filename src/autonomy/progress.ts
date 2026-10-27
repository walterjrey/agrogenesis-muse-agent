import type { ObservationSummary } from "./types.js";
import { TERMINAL_ACTION_STATUSES, type ProgressRecord, type SessionState } from "./types.js";

const MAX_COMPLETED = 6;
/** The simulator's DAY_SECONDS. */
const SECONDS_PER_SIM_DAY = 60;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Factual operational record derived ONLY from simulator data stored in the session (action views, observation
 * summaries, budgets). It never contains a plan or model reasoning; when the model has not planned, nothing is
 * invented. `nextRequiredDecision` states what the facts require, not what to farm.
 */
export function buildProgress(state: SessionState): ProgressRecord {
  const { actions, budgets, config, metrics, pendingMutation } = state;
  const pending = actions.filter((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
  const done = actions.filter((a) => TERMINAL_ACTION_STATUSES.has(a.status));
  const latest: ObservationSummary | null = metrics.latest;
  const baseline = metrics.baseline;

  const fields = (latest?.fields ?? []).map((f) => {
    const forField = actions.filter((a) => a.target === f.fieldId);
    const active = forField.find((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
    const last = forField[forField.length - 1];
    const completed = (type: string) => forField.filter((a) => a.type === type && a.status === "completed" && a.finishedAtS !== null).at(-1);
    const planting = completed("plantField");
    const harvest = completed("harvestField");
    const harvestedAfterPlanting = planting && harvest && harvest.finishedAtS! >= planting.finishedAtS!;
    const now = state.lastSimTimeS;
    return {
      fieldId: f.fieldId,
      knownCrop: f.knownCrop,
      knownGrowthStage: f.knownGrowthStage,
      activeOperation: active ? `${active.type} (${active.actionId})` : null,
      lastActionType: last?.type ?? null,
      plantedCrop: planting && !harvestedAfterPlanting ? (typeof planting.params.crop === "string" ? planting.params.crop : null) : null,
      plantedAtSimTimeS: planting && !harvestedAfterPlanting ? planting.finishedAtS : null,
      simDaysSincePlanting: planting && !harvestedAfterPlanting && now !== null ? round2((now - planting.finishedAtS!) / SECONDS_PER_SIM_DAY) : null,
      lastHarvestAtSimTimeS: harvest?.finishedAtS ?? null,
      lastInspectionAtSimTimeS: completed("inspectField")?.finishedAtS ?? null,
    };
  });

  const blockers: string[] = [];
  if (pendingMutation) blockers.push(`unconfirmed ${pendingMutation.tool}; must be reconciled with its original idempotency key before anything else`);
  for (const a of done.slice(-MAX_COMPLETED)) if (a.status === "failed" || a.status === "rejected") blockers.push(`${a.type} ${a.actionId} ${a.status}${a.failure ? `: ${a.failure}` : ""}`);
  const l = config.limits;
  if (budgets.consecutiveRejections > 0) blockers.push(`${budgets.consecutiveRejections} consecutive rejected action(s)`);
  if (config.mutationsEnabled) {
    if (budgets.acceptedMutations >= l.maxMutations) blockers.push("mutation budget exhausted");
    if (budgets.advancedSimSeconds >= l.maxSimSeconds) blockers.push("simulated-time budget exhausted");
  }

  let nextRequiredDecision: string;
  if (pendingMutation) nextRequiredDecision = "reconcile the unconfirmed request (automatic); no new mutation until then";
  else if (pending.length > 0) nextRequiredDecision = `operation(s) in flight: ${pending.map((a) => a.actionId).join(", ")}; wait for them or choose an independent action`;
  else if (done.length === 0) nextRequiredDecision = "no operation started yet; choose the first agricultural action";
  else {
    const last = done[done.length - 1]!;
    nextRequiredDecision = `review the result of ${last.type} ${last.actionId} (${last.status}) and choose the next action`;
  }

  return {
    objective: config.objective,
    simTimeS: state.lastSimTimeS,
    fields,
    pendingOperations: pending.map((a) => ({ actionId: a.actionId, type: a.type, target: a.target, status: a.status, progress: a.progress, estimatedCompletionS: a.estimatedCompletionS })),
    completedOperations: done.slice(-MAX_COMPLETED).map((a) => ({ actionId: a.actionId, type: a.type, target: a.target, status: a.status, finishedAtS: a.finishedAtS, outcome: a.outcome, failure: a.failure })),
    blockers,
    nextRequiredDecision,
    expenses: {
      realizedCostsDelta: latest?.realizedCosts != null && baseline?.realizedCosts != null ? round2(latest.realizedCosts - baseline.realizedCosts) : null,
      creditsDelta: latest?.credits != null && baseline?.credits != null ? round2(latest.credits - baseline.credits) : null,
      actionConsumedCredits: round2(actions.reduce((sum, a) => sum + (a.consumedCredits ?? 0), 0)),
    },
  };
}
