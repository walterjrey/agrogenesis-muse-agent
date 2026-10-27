import type { Snapshot } from "./observation.js";
import { compactCatalog } from "./catalog.js";
import type { SessionState } from "./types.js";
import { TERMINAL_ACTION_STATUSES } from "./types.js";
import type { GameEvent } from "../contracts/time.js";

export const DEFAULT_OBJECTIVE =
  "Maximize long-term farm viability and profitability while respecting water, money, equipment, crop cycles and uncertainty.";

export const AUTONOMOUS_SYSTEM_PROMPT = `You manage a simulated farm (AgroGenesis) over several decision cycles, only through the provided tools. A controller runs the cycles, enforces hard budgets and records your decisions. You choose what to do; nothing is scripted.

Information:
- You see only what farm management has observed. Each measurement carries value, uncertainty, age, freshness and confidence. Missing, stale or expired quantities are unknown: say so, do not assume them.
- Each cycle starts with a CONSISTENT snapshot (one game revision and simulated instant). After any change (your action, advancing time) it is stale; call observe_snapshot again before the next mutation. Never combine numbers from different revisions.
- The action catalog is compact. Use describe_action for the exact parameter schema before execute_action. Only the simulator validates actions and may reject them.

Acting:
- execute_action and advance_time change the farm; call each alone. You cannot set revisions or idempotency keys. Costs are real simulated resources: avoid duplicate, repeated or speculative actions, and prefer doing nothing over an unjustified action.
- Verify outcomes with get_action_status. Advance simulated time only in small steps when you are waiting for an operation or new information. Do not advance time just to loop.
- On stale_revision or conflict, observe again and reconsider. On outcome_unknown, stop acting this cycle and report.
- Budgets are hard limits; when little remains, prefer a safe state and a clear report.

The cycle brief already contains a consistent snapshot of the current state: do not call observe_snapshot again until something has changed (your action completed, time advanced). Each cycle: decide, act if justified, verify, then you MUST call update_plan exactly once with an explicit decision summary and a rolling plan (priorities, constraints, missing observations, pending operations, next review time, nextStep); a cycle without update_plan is recorded as having no plan. Set nextStep "stop" only when no useful, safe action remains. Finish with a one-line answer.`;

const round = (n: number): number => Math.round(n * 100) / 100;

export interface CycleBriefInput {
  state: SessionState;
  snapshot: Snapshot;
  events: GameEvent[];
}

export function cycleBrief({ state, snapshot, events }: CycleBriefInput): string {
  const { budgets, config } = state;
  const l = config.limits;
  const remaining = {
    costUsd: round(Math.max(0, l.maxCostUsd - budgets.costUsd)),
    modelCalls: Math.max(0, l.maxModelCalls - budgets.modelCalls),
    toolCalls: Math.max(0, l.maxToolCalls - budgets.toolCalls),
    mutations: config.mutationsEnabled ? Math.max(0, l.maxMutations - budgets.acceptedMutations) : 0,
    simSeconds: config.mutationsEnabled ? Math.max(0, l.maxSimSeconds - budgets.advancedSimSeconds) : 0,
    cyclesIncludingThis: Math.max(0, l.maxCycles - state.cycle + 1),
  };
  const open = state.actions.filter((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
  const recent = state.decisions.slice(-3).map((d) => ({ cycle: d.cycle, simTimeS: d.simTimeS, summary: d.summary, nextStep: d.plannedStep, accepted: d.actionsAccepted, advancedSeconds: d.advancedSeconds }));
  const brief = {
    objective: config.objective,
    mode: config.mutationsEnabled ? "mutations enabled on a dedicated test game" : "OBSERVE ONLY: state-changing tools are disabled",
    cycle: state.cycle,
    remainingBudgets: remaining,
    previousPlan: state.plan,
    recentDecisions: recent,
    actionsInFlight: open.map((a) => ({ actionId: a.actionId, type: a.type, status: a.status })),
    eventsSinceLastCycle: events.map((e) => ({ id: e.eventId, simTimeS: e.simTimeS, kind: e.kind, actionId: e.actionId, summary: e.summary })),
    snapshot: { revision: snapshot.revision, simTimeS: snapshot.simTimeS, overview: snapshot.overview, fields: snapshot.fields, actions: compactCatalog(snapshot.actions) },
  };
  return `Decision cycle ${state.cycle}. Work toward the objective with the evidence below, then record your plan.\n${JSON.stringify(brief)}`;
}
