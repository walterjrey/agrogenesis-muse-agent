import type { MutationIntent, MutationJournal, MutationSettlement } from "../agent/tools.js";
import { failureFromError, isDefinitiveRefusal, sendIdempotent } from "../agent/tools.js";
import type { ExecuteActionResponse } from "../contracts/execute.js";
import type { SimulatorClient } from "../simulator/client.js";
import { isActiveQueueStatus, reconcileQueue, runnableItems, supersede, type PlanRequest, type PlanContext, type QueueItem, type QueuePolicy, planFieldActions, type PreviewResult, type Rejection } from "./actionQueue.js";
import type { SessionState } from "./types.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "rejected"]);

export interface QueueRunnerDeps {
  client: SimulatorClient;
  gameId: string;
  state: SessionState;
  journal: MutationJournal;
  newMutationId: () => string;
  retryDelayMs: number;
  maxMutationRetries: number;
  trace: { record(event: string, data?: Record<string, unknown>): unknown };
  /** Budget gate evaluated before every submission (mutation budget, spending cap, lock). */
  maySubmit: () => boolean;
  /** Called when a submission's outcome could not be confirmed; the persisted intent is reconciled with the same key. */
  onOutcomeUnknown: () => void;
  /** Called after an accepted submission so the caller can update its own counters and caches. */
  onAccepted?: () => void;
  policy?: Partial<QueuePolicy>;
}

export interface DrainResult {
  submitted: number;
  staled: number;
  failed: number;
  locked: boolean;
}

const settlementOf = (type: string, response: ExecuteActionResponse): MutationSettlement => ({
  status: response.accepted ? "applied" : "rejected",
  revisionAfter: response.revision,
  summary: {
    type,
    accepted: response.accepted,
    actionId: response.action?.actionId ?? null,
    actionStatus: response.action?.status ?? null,
    startedAtS: response.action?.startedAtS ?? null,
    estimatedCompletionS: response.action?.estimatedCompletionS ?? null,
    finishedAtS: response.action?.finishedAtS ?? null,
    progress: response.action?.progress ?? null,
    outcomeSummary: response.action?.outcome?.summary ?? null,
    measurements: response.action?.outcome?.measurements ?? {},
    consumed: response.action?.consumed ?? null,
    errors: response.errors,
  },
});

/** Authoritative dry run: validity and cost come from the simulator itself, never from an estimate made here. */
export function simulatorPreview(client: SimulatorClient, gameId: string): PlanContext["preview"] {
  return async (type, params): Promise<PreviewResult> => {
    const response = await client.executeAction(gameId, { type, params, dryRun: true });
    return {
      ok: response.accepted,
      credits: response.estimate?.credits ?? null,
      durationS: response.estimate?.durationS ?? null,
      errors: response.errors.map((e) => ({ code: e.code, ...(e.detail ? { detail: e.detail } : {}) })),
    };
  };
}

export async function planAndStore(deps: Pick<QueueRunnerDeps, "client" | "gameId" | "state" | "policy">, fieldsAt: Parameters<typeof planFieldActions>[0]["fields"], nowS: number, credits: number | null, requests: PlanRequest[]): Promise<{ queued: QueueItem[]; reused: QueueItem[]; rejected: Rejection[] }> {
  const { state } = deps;
  const result = await planFieldActions(
    { fields: fieldsAt, nowS, credits, queue: state.queue, riskLedger: state.riskLedger, actions: state.actions, preview: simulatorPreview(deps.client, deps.gameId), ...(deps.policy ? { policy: deps.policy } : {}) },
    requests,
  );
  state.queue.push(...result.queued);
  return result;
}

/**
 * Submits what the plan allows right now: ready items on fields without a running operation, one per field. No model call is
 * involved. Every submission goes through the session's mutation journal (intent saved before sending, the same idempotency
 * key replayed after a crash), so an item can never execute twice.
 */
export async function drainQueue(deps: QueueRunnerDeps): Promise<DrainResult> {
  const { state, client, gameId } = deps;
  const out: DrainResult = { submitted: 0, staled: 0, failed: 0, locked: false };
  if (state.pendingMutation) return out;
  if (!state.queue.some((i) => isActiveQueueStatus(i.status))) return out;

  const overview = await client.getFarmOverview(gameId);
  const nowS = overview.clock.simTimeS;
  reconcileQueue(state.queue, state.actions, state.operations, nowS);
  const fields = await client.getFieldObservations(gameId, { soil: true });
  const busy = new Set<string>();
  for (const f of fields.fields) if (f.activeOperationActionId) busy.add(f.fieldId);
  for (const a of state.actions) if (a.target && !TERMINAL.has(a.status)) busy.add(a.target);
  for (const i of state.queue) if (i.status === "running") busy.add(i.fieldId);

  const { run, staled } = runnableItems(state.queue, { fields, nowS, riskLedger: state.riskLedger, actions: state.actions, busyFields: busy, ...(deps.policy ? { policy: deps.policy } : {}) });
  for (const { item, why } of staled) {
    supersede(item, `stale: ${why}`, nowS);
    out.staled += 1;
    deps.trace.record("queue.stale", { id: item.id, fieldId: item.fieldId, why });
  }
  reconcileQueue(state.queue, state.actions, state.operations, nowS);

  for (const item of run) {
    if (!deps.maySubmit()) break;
    const outcome = await submit(deps, item);
    if (outcome === "submitted") out.submitted += 1;
    else if (outcome === "failed") out.failed += 1;
    else if (outcome === "unknown") {
      out.locked = true;
      break;
    }
  }
  return out;
}

async function submit(deps: QueueRunnerDeps, item: QueueItem): Promise<"submitted" | "failed" | "retry" | "unknown"> {
  const { state, client, gameId } = deps;
  // The revision is read right before sending: earlier submissions in the same drain changed it.
  const overview = await client.getFarmOverview(gameId);
  const idempotencyKey = deps.newMutationId();
  const request = { type: item.request.type, params: item.request.params, expectedRevision: overview.revision, dryRun: false, idempotencyKey };
  const intent: MutationIntent = { tool: "execute_action", idempotencyKey, expectedRevision: overview.revision, request, rationale: `queued ${item.kind}: ${item.reason}`.slice(0, 500) };
  // Persisted with the intent by journal.begin: a restart replays this exact request instead of creating a new one.
  item.status = "running";
  item.idempotencyKey = idempotencyKey;
  item.updatedAtS = overview.clock.simTimeS;
  deps.trace.record("queue.submit", { id: item.id, fieldId: item.fieldId, kind: item.kind, type: item.request.type, params: item.request.params, idempotencyKey });
  try {
    await deps.journal.begin(intent);
    const response = await sendIdempotent(deps, () => client.executeAction(gameId, request));
    await deps.journal.settle(intent, settlementOf(item.request.type, response));
    if (!response.accepted) {
      item.status = "failed";
      item.note = `rejected: ${response.errors.map((e) => e.code).join(", ")}`.slice(0, 200);
      return "failed";
    }
    deps.onAccepted?.();
    reconcileQueue(state.queue, state.actions, state.operations, overview.clock.simTimeS);
    return "submitted";
  } catch (error) {
    if (!isDefinitiveRefusal(error)) {
      // Unknown outcome: the intent stays pending and is replayed with the same key by the controller's reconcile.
      deps.onOutcomeUnknown();
      deps.trace.record("queue.outcome_unknown", { id: item.id });
      return "unknown";
    }
    const failure = failureFromError(error);
    await deps.journal.settle(intent, { status: "not_applied", revisionAfter: null, summary: { code: failure.code, httpStatus: failure.httpStatus ?? null } });
    if (failure.code === "stale_revision" || failure.httpStatus === 401 || failure.httpStatus === 403) {
      // Nothing was applied; the item simply waits for the next drain with a fresh revision and a new key.
      item.status = "queued";
      item.idempotencyKey = null;
      return "retry";
    }
    item.status = "failed";
    item.note = `refused: ${failure.code}`.slice(0, 200);
    return "failed";
  }
}
