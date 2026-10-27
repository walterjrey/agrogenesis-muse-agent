import type { MutationIntent, MutationJournal } from "../agent/tools.js";
import { failureFromError, isDefinitiveRefusal, sendIdempotent } from "../agent/tools.js";
import type { ActionRecordView } from "../contracts/execute.js";
import type { AdvanceResponse, GameEvent } from "../contracts/time.js";
import type { SimulatorClient } from "../simulator/client.js";
import { TERMINAL_ACTION_STATUSES } from "./types.js";

/** Chunk used when the simulator gives no usable completion estimate: one simulated day (the simulator's DAY_SECONDS is 60). */
export const FALLBACK_CHUNK_SECONDS = 60;
/** The simulator advances in 0.1 s fixed ticks. */
const TICK_SECONDS = 0.1;
const MAX_REPORTED_EVENTS = 8;

/** Events that return control to the model even though the awaited operation has not finished. */
const MATERIAL_EVENT_KINDS: ReadonlySet<GameEvent["kind"]> = new Set(["action_failed", "action_cancelled", "weather_alert", "mode_changed"]);

export type WaitOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "event_interrupt"
  | "other_operation_finished"
  | "wait_limit"
  | "conflict"
  | "refused"
  | "outcome_unknown"
  | "unavailable"
  | "aborted";

export interface WaitResult {
  actionId: string;
  outcome: WaitOutcome;
  actionStatus: ActionRecordView["status"] | null;
  progress: number | null;
  estimatedCompletionS: number | null;
  finishedAtS: number | null;
  outcomeSummary: string | null;
  failure: string | null;
  consumedCredits: number | null;
  advanceRequests: number;
  advancedSeconds: number;
  conflicts: number;
  simTimeStartS: number | null;
  simTimeEndS: number | null;
  /** Compact lines for the events the simulator reported during the wait (capped). */
  events: string[];
  eventCount: number;
  detail: string | null;
}

export interface WaitBudget {
  /** Advance requests this wait may still send. */
  requestsLeft: number;
  /** Simulated seconds this wait may still advance. */
  simSecondsLeft: number;
  /** Largest single advance request. */
  maxChunkSeconds: number;
  /** Hard cap per HTTP request (the run's per-call limit). */
  maxCallSeconds: number;
  /** Stale-revision conflicts this wait may absorb before returning control. */
  conflictsLeft: number;
}

export interface SupervisorDeps {
  client: SimulatorClient;
  gameId: string;
  journal?: MutationJournal;
  newMutationId: () => string;
  retryDelayMs: number;
  maxMutationRetries: number;
  budget: WaitBudget;
  getCursor(): number;
  setCursor(cursor: number): void;
  /** Called after each confirmed advance with the seconds the SERVER granted. */
  onAdvanced(grantedSeconds: number, response: AdvanceResponse): void;
  onConflict?(): void;
  /** Returns a reason when the wait must stop immediately (wall clock, budgets owned by the caller). */
  shouldStop?(): string | null;
  record?(event: string, data: Record<string, unknown>): void;
}

const roundUpToTick = (seconds: number): number => Math.max(TICK_SECONDS, Math.ceil(seconds / TICK_SECONDS - 1e-9) * TICK_SECONDS);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const describeEvent = (e: GameEvent): string => `${e.kind}${e.actionId ? ` ${e.actionId}` : ""} @${round3(e.simTimeS)}s: ${e.summary}`.slice(0, 160);

/** Shared, journaled advance step used by both supervisors; owns the counters that describe the time spent. */
class Advancer {
  requests = 0;
  advanced = 0;
  conflicts = 0;
  simStart: number | null = null;
  simNow: number | null = null;
  eventCount = 0;
  readonly eventLines: string[] = [];
  private readonly tools: { trace: { record: (event: string, data?: Record<string, unknown>) => void }; retryDelayMs: number; maxMutationRetries: number };

  constructor(private readonly deps: SupervisorDeps) {
    this.tools = { trace: { record: (event, data) => deps.record?.(event, data ?? {}) }, retryDelayMs: deps.retryDelayMs, maxMutationRetries: deps.maxMutationRetries };
  }

  /** Reads the authorized revision/time. Returns the revision, or null when the simulator is unavailable. */
  async revision(): Promise<{ revision: number; simTimeS: number } | { error: string }> {
    try {
      const overview = await this.deps.client.getFarmOverview(this.deps.gameId);
      this.simStart ??= overview.clock.simTimeS;
      this.simNow = overview.clock.simTimeS;
      return { revision: overview.revision, simTimeS: overview.clock.simTimeS };
    } catch (error) {
      return { error: failureFromError(error).code };
    }
  }

  /** One idempotent, revision-checked advance. "retry" means a stale revision was absorbed within the conflict budget. */
  async step(requested: number, stopOn: Array<"action_completion" | "new_observation" | "any_event">, expectedRevision: number, rationale: string, extra: Record<string, unknown>): Promise<{ status: "ok"; response: AdvanceResponse } | { status: "retry" } | { status: "end"; outcome: WaitOutcome; detail: string }> {
    const { deps } = this;
    const idempotencyKey = deps.newMutationId();
    const request = { requestedSeconds: requested, stopOn, cursor: deps.getCursor(), expectedRevision, idempotencyKey };
    const intent: MutationIntent = { tool: "advance_time", idempotencyKey, expectedRevision, request, rationale };
    deps.record?.("supervisor.advance", { requestedSeconds: requested, expectedRevision, idempotencyKey, ...extra });
    let response: AdvanceResponse;
    try {
      await deps.journal?.begin(intent);
      response = await sendIdempotent(this.tools, () => deps.client.advance(deps.gameId, request));
    } catch (error) {
      if (!isDefinitiveRefusal(error)) return { status: "end", outcome: "outcome_unknown", detail: "The advance may or may not have been applied; the journal keeps its idempotency key for reconciliation." };
      const failure = failureFromError(error);
      await deps.journal?.settle(intent, { status: "not_applied", revisionAfter: null, summary: { code: failure.code, httpStatus: failure.httpStatus ?? null } });
      if (failure.code === "stale_revision") {
        this.conflicts += 1;
        deps.onConflict?.();
        if (this.conflicts > deps.budget.conflictsLeft) return { status: "end", outcome: "conflict", detail: "Repeated stale revisions: another writer is changing the game." };
        return { status: "retry" };
      }
      return { status: "end", outcome: "refused", detail: failure.code };
    }
    await deps.journal?.settle(intent, {
      status: "applied",
      revisionAfter: null,
      summary: { grantedSeconds: response.grantedSeconds, stoppedBecause: response.stoppedBecause, simTimeAfterS: response.clockAfter.simTimeS, eventCount: response.events.length },
    });
    this.requests += 1;
    this.advanced += response.grantedSeconds;
    this.simNow = response.clockAfter.simTimeS;
    deps.onAdvanced(response.grantedSeconds, response);
    deps.setCursor(Math.max(deps.getCursor(), response.nextCursor));
    this.eventCount += response.events.length;
    for (const e of response.events) if (e.kind !== "observation_delivered" && this.eventLines.length < MAX_REPORTED_EVENTS) this.eventLines.push(describeEvent(e));
    return { status: "ok", response };
  }
}

/**
 * Waits, with server-authoritative time only, for ONE operation the model already authorized. It never selects a
 * farm action. Each advance is sized from the simulator's own completion estimate (grown geometrically when the
 * estimate has passed or is unknown), capped by the budgets, journaled and sent with the current revision and a
 * fresh idempotency key, and the time actually GRANTED by the simulator is what gets accounted. It returns as soon
 * as the operation reaches a terminal state, a material event appears, a budget is exhausted, a conflict persists,
 * or an outcome is unknown.
 */
export async function superviseOperation(deps: SupervisorDeps, params: { actionId: string; maxSeconds?: number }): Promise<WaitResult> {
  const { client, gameId, budget } = deps;
  const adv = new Advancer(deps);
  let chunk = Math.min(budget.maxChunkSeconds, FALLBACK_CHUNK_SECONDS);
  let view: ActionRecordView | null = null;

  const finish = (outcome: WaitOutcome, detail: string | null = null): WaitResult => ({
    actionId: params.actionId,
    outcome,
    actionStatus: view?.status ?? null,
    progress: view?.progress ?? null,
    estimatedCompletionS: view?.estimatedCompletionS ?? null,
    finishedAtS: view?.finishedAtS ?? null,
    outcomeSummary: view?.outcome?.summary ?? null,
    failure: view?.failure ? `${view.failure.code}: ${view.failure.detail}`.slice(0, 200) : null,
    consumedCredits: view?.consumed.credits ?? null,
    advanceRequests: adv.requests,
    advancedSeconds: round3(adv.advanced),
    conflicts: adv.conflicts,
    simTimeStartS: adv.simStart,
    simTimeEndS: adv.simNow,
    events: adv.eventLines,
    eventCount: adv.eventCount,
    detail,
  });

  for (;;) {
    try {
      view = (await client.getAction(gameId, params.actionId)).action;
    } catch (error) {
      return finish("unavailable", failureFromError(error).code);
    }
    if (TERMINAL_ACTION_STATUSES.has(view.status)) return finish(view.status as WaitOutcome);

    const stop = deps.shouldStop?.() ?? null;
    if (stop) return finish("aborted", stop);
    if (adv.requests >= budget.requestsLeft) return finish("wait_limit", "advance-request budget");
    const simLeft = budget.simSecondsLeft - adv.advanced;
    const waitLeft = (params.maxSeconds ?? Number.POSITIVE_INFINITY) - adv.advanced;
    if (simLeft < TICK_SECONDS) return finish("wait_limit", "simulated-time budget");
    if (waitLeft < TICK_SECONDS) return finish("wait_limit", "maxSeconds for this wait");

    const at = await adv.revision();
    if ("error" in at) return finish("unavailable", at.error);
    const simNow = at.simTimeS;

    const estimate = view.estimatedCompletionS;
    const estimateUsable = estimate !== null && estimate > simNow;
    const wanted = estimateUsable ? Math.min(estimate - simNow + 0.5, chunk) : chunk;
    const requested = round3(Math.min(roundUpToTick(wanted), budget.maxCallSeconds, simLeft, waitLeft));
    if (requested < TICK_SECONDS - 1e-9) return finish("wait_limit", "advance cap");

    const step = await adv.step(requested, ["action_completion"], at.revision, `Supervised wait for ${params.actionId}`, { actionId: params.actionId, estimatedCompletionS: estimate });
    if (step.status === "retry") continue;
    if (step.status === "end") return finish(step.outcome, step.detail);
    const response = step.response;

    if (!estimateUsable && response.stoppedBecause !== "action_completion") chunk = Math.min(chunk * 2, budget.maxChunkSeconds);

    const material = response.events.find((e) => MATERIAL_EVENT_KINDS.has(e.kind) || (e.kind === "action_completed" && e.actionId !== params.actionId));
    if (material) {
      try {
        view = (await client.getAction(gameId, params.actionId)).action;
      } catch {
        /* keep the last known status */
      }
      if (view && TERMINAL_ACTION_STATUSES.has(view.status)) return finish(view.status as WaitOutcome);
      return finish(material.kind === "action_completed" ? "other_operation_finished" : "event_interrupt", describeEvent(material));
    }
  }
}

export type IntervalOutcome = "horizon_reached" | "event_interrupt" | "wait_limit" | "conflict" | "refused" | "outcome_unknown" | "unavailable" | "aborted";

export interface IntervalResult {
  outcome: IntervalOutcome;
  requestedSeconds: number;
  advancedSeconds: number;
  advancedSimDays: number;
  checkpoints: number;
  advanceRequests: number;
  conflicts: number;
  simTimeStartS: number | null;
  simTimeEndS: number | null;
  /** Compact lines for the material events that returned control (and the first few others). */
  events: string[];
  eventCount: number;
  detail: string | null;
}

/** Events that are information, not a reason to interrupt a deliberate review interval. */
const ROUTINE_EVENT_KINDS: ReadonlySet<GameEvent["kind"]> = new Set(["observation_delivered", "action_started"]);

/**
 * Advances server time over a horizon the MODEL chose, in bounded checkpoints (for example 5 simulated days), without
 * ever selecting a farm action. After every checkpoint the simulator's events are inspected; any event that is not
 * routine (weather alert, equipment change, an operation finishing or failing, a mode change) returns control to
 * the model right away. It never jumps further than the horizon, never exceeds the run budgets, accounts the time
 * the server actually GRANTED, and is journaled, idempotent and revision-checked like every other advance.
 */
export async function superviseInterval(deps: SupervisorDeps, params: { maxSeconds: number; checkpointSeconds: number }): Promise<IntervalResult> {
  const { budget } = deps;
  const adv = new Advancer(deps);
  let checkpoints = 0;
  let interrupt: string | null = null;
  const finish = (outcome: IntervalOutcome, detail: string | null = null): IntervalResult => ({
    outcome,
    requestedSeconds: params.maxSeconds,
    advancedSeconds: round3(adv.advanced),
    advancedSimDays: round3(adv.advanced / 60),
    checkpoints,
    advanceRequests: adv.requests,
    conflicts: adv.conflicts,
    simTimeStartS: adv.simStart,
    simTimeEndS: adv.simNow,
    events: adv.eventLines,
    eventCount: adv.eventCount,
    detail: detail ?? interrupt,
  });

  for (;;) {
    const stop = deps.shouldStop?.() ?? null;
    if (stop) return finish("aborted", stop);
    const horizonLeft = params.maxSeconds - adv.advanced;
    if (horizonLeft < TICK_SECONDS) return finish("horizon_reached");
    if (adv.requests >= budget.requestsLeft) return finish("wait_limit", "advance-request budget");
    const simLeft = budget.simSecondsLeft - adv.advanced;
    if (simLeft < TICK_SECONDS) return finish("wait_limit", "simulated-time budget");

    const at = await adv.revision();
    if ("error" in at) return finish("unavailable", at.error);
    const requested = round3(Math.min(roundUpToTick(Math.min(params.checkpointSeconds, horizonLeft)), budget.maxCallSeconds, simLeft));
    if (requested < TICK_SECONDS - 1e-9) return finish("wait_limit", "advance cap");

    const step = await adv.step(requested, ["any_event"], at.revision, "Supervised review interval", { horizonSeconds: params.maxSeconds, checkpoint: checkpoints + 1 });
    if (step.status === "retry") continue;
    if (step.status === "end") return finish(step.outcome as IntervalOutcome, step.detail);
    checkpoints += 1;
    const material = step.response.events.find((e) => !ROUTINE_EVENT_KINDS.has(e.kind));
    if (material) {
      interrupt = describeEvent(material);
      return finish("event_interrupt");
    }
    // Granted less than asked without an event means the server limit was reached; do not spin on it.
    if (step.response.grantedSeconds < requested - TICK_SECONDS / 2 && step.response.stoppedBecause === "granted_limit_reached") return finish("wait_limit", "server granted less than requested");
  }
}