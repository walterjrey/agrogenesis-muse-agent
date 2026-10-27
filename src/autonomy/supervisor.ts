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
  const tools = { trace: { record: (event: string, data?: Record<string, unknown>) => deps.record?.(event, data ?? {}) }, retryDelayMs: deps.retryDelayMs, maxMutationRetries: deps.maxMutationRetries };
  const eventLines: string[] = [];
  let eventCount = 0;
  let requests = 0;
  let advanced = 0;
  let conflicts = 0;
  let simStart: number | null = null;
  let simNow: number | null = null;
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
    advanceRequests: requests,
    advancedSeconds: round3(advanced),
    conflicts,
    simTimeStartS: simStart,
    simTimeEndS: simNow,
    events: eventLines,
    eventCount,
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
    if (requests >= budget.requestsLeft) return finish("wait_limit", "advance-request budget");
    const simLeft = budget.simSecondsLeft - advanced;
    const waitLeft = (params.maxSeconds ?? Number.POSITIVE_INFINITY) - advanced;
    if (simLeft < TICK_SECONDS) return finish("wait_limit", "simulated-time budget");
    if (waitLeft < TICK_SECONDS) return finish("wait_limit", "maxSeconds for this wait");

    let overview;
    try {
      overview = await client.getFarmOverview(gameId);
    } catch (error) {
      return finish("unavailable", failureFromError(error).code);
    }
    simStart ??= overview.clock.simTimeS;
    simNow = overview.clock.simTimeS;

    const estimate = view.estimatedCompletionS;
    const estimateUsable = estimate !== null && estimate > simNow;
    const wanted = estimateUsable ? Math.min(estimate - simNow + 0.5, chunk) : chunk;
    const requested = round3(Math.min(roundUpToTick(wanted), budget.maxCallSeconds, simLeft, waitLeft));
    if (requested < TICK_SECONDS - 1e-9) return finish("wait_limit", "advance cap");

    const idempotencyKey = deps.newMutationId();
    const request = { requestedSeconds: requested, stopOn: ["action_completion"] as Array<"action_completion">, cursor: deps.getCursor(), expectedRevision: overview.revision, idempotencyKey };
    const intent: MutationIntent = { tool: "advance_time", idempotencyKey, expectedRevision: overview.revision, request, rationale: `Supervised wait for ${params.actionId}` };
    deps.record?.("supervisor.advance", { actionId: params.actionId, requestedSeconds: requested, expectedRevision: overview.revision, idempotencyKey, estimatedCompletionS: estimate });
    let response: AdvanceResponse;
    try {
      await deps.journal?.begin(intent);
      response = await sendIdempotent(tools, () => client.advance(gameId, request));
    } catch (error) {
      if (!isDefinitiveRefusal(error)) return finish("outcome_unknown", "The advance may or may not have been applied; the journal keeps its idempotency key for reconciliation.");
      const failure = failureFromError(error);
      await deps.journal?.settle(intent, { status: "not_applied", revisionAfter: null, summary: { code: failure.code, httpStatus: failure.httpStatus ?? null } });
      if (failure.code === "stale_revision") {
        conflicts += 1;
        deps.onConflict?.();
        if (conflicts > budget.conflictsLeft) return finish("conflict", "Repeated stale revisions: another writer is changing the game.");
        continue;
      }
      return finish("refused", failure.code);
    }
    await deps.journal?.settle(intent, {
      status: "applied",
      revisionAfter: null,
      summary: { grantedSeconds: response.grantedSeconds, stoppedBecause: response.stoppedBecause, simTimeAfterS: response.clockAfter.simTimeS, eventCount: response.events.length },
    });
    requests += 1;
    advanced += response.grantedSeconds;
    simNow = response.clockAfter.simTimeS;
    deps.onAdvanced(response.grantedSeconds, response);
    deps.setCursor(Math.max(deps.getCursor(), response.nextCursor));
    eventCount += response.events.length;
    for (const e of response.events) if (e.kind !== "observation_delivered" && eventLines.length < MAX_REPORTED_EVENTS) eventLines.push(describeEvent(e));

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
