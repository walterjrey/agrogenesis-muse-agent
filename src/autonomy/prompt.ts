import type { Snapshot } from "./observation.js";
import { terseCatalog } from "./catalog.js";
import { compactFields } from "./compactObservation.js";
import type { EconomicSummary } from "./economics.js";
import type { ProgressRecord, SessionState } from "./types.js";
import type { GameEvent } from "../contracts/time.js";

export const DEFAULT_OBJECTIVE =
  "Maximize long-term farm viability and profitability while respecting water, money, equipment, crop cycles and uncertainty.";

export const AUTONOMOUS_SYSTEM_PROMPT = `You manage a simulated farm (AgroGenesis) over several decision cycles, only through the provided tools. A controller runs the cycles, enforces hard budgets and records your decisions. You choose what to do; nothing is scripted.

Information:
- You see only what farm management has observed. Each measurement carries value, uncertainty, age, freshness and confidence. Missing, stale or expired quantities are unknown: say so, do not assume them.
- Each cycle starts with a CONSISTENT snapshot (one game revision and simulated instant). After any change (your action, advancing time) it is stale; call observe_snapshot again before the next mutation. Never combine numbers from different revisions.
- The action catalog lists eligible action types and targets only. Use describe_action for the exact parameter schema before execute_action. Only the simulator validates actions and may reject them.

Acting:
- execute_action, advance_time, wait_for_operation and wait_for_checkpoint change the farm; call each alone. You cannot set revisions or idempotency keys. Costs are real simulated resources: avoid duplicate, repeated or speculative actions, and prefer doing nothing over an unjustified action.
- Time: one simulated day is 60 simulated seconds and the server advances in 0.1 s ticks. An operation you started takes simulated time to finish. To wait for it call wait_for_operation (one call, the runtime sizes the advances, stops when it finishes, fails or something important happens, and reports facts); do not poll with repeated advance_time/get_action_status. Crops need on the order of 100 simulated days (about 6,000 s) to mature. To let a crop grow, call wait_for_checkpoint with a horizon you choose (max 30 days): it advances in review checkpoints and returns early on weather alerts, equipment changes or operations finishing/failing; it never starts farm actions. Use advance_time only for a short, justified jump; the server grants at most what it allows and reports the granted time. Never advance just to loop.
- Crop identity and growth stage are NOT observable. The operational record keeps what you planted and when (plantedCrop, simDaysSincePlanting) from your own completed actions; harvestField becoming eligible is the simulator's own maturity signal. Inspect fields, irrigate or treat only when the observations justify it, and judge readiness from the catalog, not from the calendar.
- On stale_revision or conflict, observe again and reconsider. On outcome_unknown, stop acting this cycle and report.
- Economics: harvested grain earns nothing until you sell it with sellHarvest at the market price; unsold stock is only an estimate. The brief has an economy block (credits, stock by product, price status known/unknown, recent harvest and sale effects, fuel in depot vs machine tanks). Prices and storage limits shown as unknown are unknown; do not invent forecasts. Whether to sell, store, plant, inspect or wait is your decision, based on the objective, costs and the remaining horizon.
- Budgets are hard limits; when little remains, prefer a safe state and a clear report.

The cycle brief already contains a consistent snapshot and a factual operational record kept by the runtime (it is not a plan). Do not call observe_snapshot again until something changed. Each cycle: decide, act if justified, wait or verify, then finish with a short explicit decision summary (what you decided and why, from the observations). update_plan is optional: use it only to record a rolling plan (priorities, constraints, missing observations, next review) or nextStep "stop" when no useful, safe action remains.`;

const round = (n: number): number => Math.round(n * 100) / 100;

export interface CycleBriefInput {
  state: SessionState;
  snapshot: Snapshot;
  events: GameEvent[];
  progress: ProgressRecord;
  economics?: EconomicSummary | null;
}

export function cycleBrief({ state, snapshot, events, progress, economics }: CycleBriefInput): string {
  const { budgets, config } = state;
  const l = config.limits;
  const remaining = {
    costUsd: round(Math.max(0, l.maxCostUsd - budgets.costUsd)),
    modelCalls: Math.max(0, l.maxModelCalls - budgets.modelCalls),
    toolCalls: Math.max(0, l.maxToolCalls - budgets.toolCalls),
    advanceRequests: config.mutationsEnabled ? Math.max(0, Math.min(l.maxAdvanceRequests - budgets.advanceRequests, l.maxConsecutiveAdvances - budgets.consecutiveAdvances)) : 0,
    farmSpendCredits: config.mutationsEnabled ? l.maxFarmSpendCredits : 0,
    mutations: config.mutationsEnabled ? Math.max(0, l.maxMutations - budgets.acceptedMutations) : 0,
    simSeconds: config.mutationsEnabled ? Math.max(0, l.maxSimSeconds - budgets.advancedSimSeconds) : 0,
    cyclesIncludingThis: Math.max(0, l.maxCycles - state.cycle + 1),
  };
  const recent = state.decisions.slice(-3).map((d) => ({ cycle: d.cycle, simTimeS: d.simTimeS, summary: d.summary, nextStep: d.plannedStep, accepted: d.actionsAccepted, advancedSeconds: d.advancedSeconds }));
  const brief = {
    objective: config.objective,
    mode: config.mutationsEnabled ? "mutations enabled on a dedicated test game" : "OBSERVE ONLY: state-changing tools are disabled",
    cycle: state.cycle,
    remainingBudgets: remaining,
    previousPlan: state.plan,
    recentDecisions: recent,
    operationalRecord: progress,
    economy: economics ?? null,
    eventsSinceLastCycle: events.map((e) => ({ id: e.eventId, simTimeS: e.simTimeS, kind: e.kind, actionId: e.actionId, summary: e.summary })),
    snapshot: { revision: snapshot.revision, simTimeS: snapshot.simTimeS, overview: snapshot.overview, fields: compactFields(snapshot.fields), actions: terseCatalog(snapshot.actions) },
  };
  return `Decision cycle ${state.cycle}. Work toward the objective with the evidence below, then give a short decision summary.\n${JSON.stringify(brief)}`;
}
