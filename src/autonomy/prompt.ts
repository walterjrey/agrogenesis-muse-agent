import type { Snapshot } from "./observation.js";
import { terseCatalog } from "./catalog.js";
import { compactFields } from "./compactObservation.js";
import type { EconomicSummary } from "./economics.js";
import type { ProgressRecord, SessionState } from "./types.js";
import type { GameEvent } from "../contracts/time.js";
import { buildPlanningContext } from "./planning.js";

export const DEFAULT_OBJECTIVE =
  "Maximize long-term farm viability and profitability while respecting water, money, equipment, crop cycles and uncertainty.";

export const AUTONOMOUS_SYSTEM_PROMPT = `You manage a simulated farm (AgroGenesis) over several decision cycles, only through the provided tools. A controller runs the cycles, enforces hard budgets and records your decisions. You choose what to do; nothing is scripted.

Information:
- You see only what farm management has observed. Each measurement carries value, uncertainty, age, freshness and confidence. Missing, stale or expired quantities are unknown: say so, do not assume them.
- Each cycle starts with a CONSISTENT snapshot (one game revision and simulated instant). After any change (your action, advancing time) it is stale; call observe_snapshot again before the next mutation. Never combine numbers from different revisions.
- The action catalog lists eligible action types and targets only. Use describe_action for the exact parameter schema before execute_action, but only once per action type: if you already hold that type's schema from earlier in this session, reuse it and call describe_action again only when a submission was rejected for its parameters or you need eligibility details you lack. Use compare_crop_options for the compact, authorized crop/market comparison; it labels unknown yields, duration and crop-specific input requirements rather than estimating them. Only the simulator validates actions and may reject them.

Acting:
- execute_action, advance_time, wait_for_operation and wait_for_checkpoint change the farm; call each alone. You cannot set revisions or idempotency keys. Costs are real simulated resources: avoid duplicate, repeated or speculative actions, and prefer doing nothing over an unjustified action.
- Time: one simulated day is 60 simulated seconds and the server advances in 0.1 s ticks. An operation you started takes simulated time to finish. The runtime automatically supervises a pending operation to completion after your cycle ends, at no model-call cost, so normally just finish the cycle with your decision summary and let it complete. wait_for_operation remains available (one call, the runtime sizes the advances, stops when it finishes, fails or something important happens, and reports facts) when you need the outcome within this cycle, e.g. to act on it immediately; do not poll with repeated advance_time/get_action_status. The only crop-cycle guidance is a generic estimate of about 100 simulated days, not crop-specific and not a simulator guarantee. Use the planning block's explicit experiment horizon and known commitments; a planting that may not mature before the horizon is a consideration, not a prohibition. To let a crop grow, call wait_for_checkpoint with a review interval you choose (maximum 30 days); the runtime may shorten it near a generic review window, a pending completion, stale critical observations, recent material events, or the configured horizon. It advances in bounded review checkpoints and returns early on relevant events; it never starts farm actions. Use advance_time only for a short, justified jump; the server grants at most what it allows and reports the granted time. Never advance just to loop.
- Crop identity and growth stage are NOT observable. The operational record keeps what you planted and when (plantedCrop, simDaysSincePlanting) from your own completed actions; harvestField becoming eligible is the simulator's own maturity signal. Inspect fields, irrigate or treat only when the observations justify it, and judge readiness from the catalog, not from the calendar.
- On stale_revision or conflict, observe again and reconsider. On outcome_unknown, stop acting this cycle and report.
- Economics: harvested grain earns nothing until you sell it with sellHarvest at the market price; unsold stock is only an estimate. The brief has an economy block (credits, stock by product, price status known/unknown, recent harvest and sale effects, fuel in depot vs machine tanks). Prices and storage limits shown as unknown are unknown; do not invent forecasts. Whether to sell, store, plant, inspect or wait is your decision, based on the objective, costs and the remaining horizon.
- Budgets are hard limits; remainingBudgets also shows the separate inspection allowance (observation-only actions) and farm-action allowance. Having an allowance is not a reason to use it. When little remains, prefer a safe state and a clear report.

The cycle brief already contains a consistent snapshot and a factual operational record kept by the runtime (it is not a plan). Do not call observe_snapshot again until something changed. Each cycle: decide, act if justified, wait or verify, then finish with a short explicit decision summary (what you decided and why, from the observations). update_plan is optional: use it only to record a rolling plan (priorities, constraints, missing observations, next review) or nextStep "stop" when no useful, safe action remains.`;

const round = (n: number): number => Math.round(n * 100) / 100;

export interface CycleBriefInput {
  state: SessionState;
  snapshot: Snapshot;
  events: GameEvent[];
  progress: ProgressRecord;
  economics?: EconomicSummary | null;
}

/**
 * Prompt-facing view of the operational record. Drops fields already present elsewhere in this same brief:
 * knownCrop/knownGrowthStage per field (sensor-reported, duplicated under snapshot.fields), objective (duplicated
 * at the top level of the brief) and simTimeS (duplicated at the top of snapshot: state.lastSimTimeS is always
 * set to snapshot.simTimeS before the brief is built). The full ProgressRecord (used for persistence, resume and
 * reporting) is never mutated or shortened.
 */
export function promptOperationalRecord(progress: ProgressRecord) {
  const { objective: _objective, simTimeS: _simTimeS, ...rest } = progress;
  void _objective;
  void _simTimeS;
  return { ...rest, fields: progress.fields.map(({ knownCrop: _knownCrop, knownGrowthStage: _knownGrowthStage, ...fieldRest }) => { void _knownCrop; void _knownGrowthStage; return fieldRest; }) };
}

/**
 * Prompt-facing view of compacted field observations: drops revision/simTimeS, since this is always embedded next
 * to a sibling snapshot.revision/snapshot.simTimeS in this same brief. compactFields() itself is unchanged and
 * keeps both (it is also returned standalone, as the self-contained observe_snapshot tool result).
 */
function promptFields(fields: Snapshot["fields"]) {
  const { revision: _revision, simTimeS: _simTimeS, ...rest } = compactFields(fields);
  void _revision;
  void _simTimeS;
  return rest;
}

/**
 * Prompt-facing view of the economic summary: drops asOfSimTimeS and credits, since this is always embedded next
 * to the same cycle's snapshot.simTimeS and snapshot.overview.finance.credits. buildEconomics()/EconomicSummary
 * itself is unchanged (used only here, but keeping its full documented shape avoids coupling the economics module
 * to this one call site).
 */
function promptEconomy(economics: EconomicSummary | null | undefined) {
  if (!economics) return null;
  const { asOfSimTimeS: _asOfSimTimeS, credits: _credits, ...rest } = economics;
  void _asOfSimTimeS;
  void _credits;
  return rest;
}

/** Builds the structured per-cycle brief (before stringification). Exported so prompt-size instrumentation can
 * measure each section's serialized size without duplicating the assembly logic or re-stringifying the whole brief. */
export function buildBriefSections({ state, snapshot, events, progress, economics }: CycleBriefInput) {
  const { budgets, config } = state;
  const l = config.limits;
  const remaining = {
    costUsd: round(Math.max(0, l.maxCostUsd - budgets.costUsd)),
    modelCalls: Math.max(0, l.maxModelCalls - budgets.modelCalls),
    toolCalls: Math.max(0, l.maxToolCalls - budgets.toolCalls),
    advanceRequests: config.mutationsEnabled ? Math.max(0, Math.min(l.maxAdvanceRequests - budgets.advanceRequests, l.maxConsecutiveAdvances - budgets.consecutiveAdvances)) : 0,
    farmSpendCredits: config.mutationsEnabled ? l.maxFarmSpendCredits : 0,
    mutations: config.mutationsEnabled ? Math.max(0, l.maxMutations - budgets.acceptedMutations) : 0,
    inspections: config.mutationsEnabled ? Math.max(0, l.maxInspections - budgets.acceptedInspections) : 0,
    simSeconds: config.mutationsEnabled ? Math.max(0, l.maxSimSeconds - budgets.advancedSimSeconds) : 0,
    cyclesIncludingThis: Math.max(0, l.maxCycles - state.cycle + 1),
  };
  const recent = state.decisions.slice(-3).map((d) => ({ cycle: d.cycle, simTimeS: d.simTimeS, summary: d.summary, nextStep: d.plannedStep, accepted: d.actionsAccepted, advancedSeconds: d.advancedSeconds }));
  return {
    objective: config.objective,
    mode: config.mutationsEnabled ? "mutations enabled on a dedicated test game" : "OBSERVE ONLY: state-changing tools are disabled",
    cycle: state.cycle,
    remainingBudgets: remaining,
    previousPlan: state.plan,
    recentDecisions: recent,
    operationalRecord: promptOperationalRecord(progress),
    economy: promptEconomy(economics),
    planning: buildPlanningContext(state, snapshot, events, progress),
    eventsSinceLastCycle: events.map((e) => ({ id: e.eventId, simTimeS: e.simTimeS, kind: e.kind, actionId: e.actionId, summary: e.summary })),
    snapshot: { revision: snapshot.revision, simTimeS: snapshot.simTimeS, overview: snapshot.overview, fields: promptFields(snapshot.fields), actions: terseCatalog(snapshot.actions) },
  };
}

export function cycleBrief(input: CycleBriefInput): string {
  const brief = buildBriefSections(input);
  return `Decision cycle ${input.state.cycle}. Crop-option comparison and planning estimates are factual where labeled known; unknown values are not estimates. Select any action independently; no crop or action is preferred by the runtime. Work toward the objective with the evidence below, then give a short decision summary.\n${JSON.stringify(brief)}`;
}
