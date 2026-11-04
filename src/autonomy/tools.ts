import { z } from "zod";
import type { SimulatorClient } from "../simulator/client.js";
import { createToolRegistry, defineTool, failureFromError, fail, succeed, type RegisteredTool } from "../agent/tools.js";
import { compactCatalog, describeAction, terseCatalog } from "./catalog.js";
import { isInspectionActionType } from "./actionClassification.js";
import { compactFields } from "./compactObservation.js";
import { collectSnapshot, InconsistentObservationError, type Snapshot } from "./observation.js";
import { adaptReviewWindow, buildCropEconomics } from "./planning.js";
import { superviseInterval, superviseOperation, type IntervalResult, type WaitResult } from "./supervisor.js";
import { reviewAtCheckpoint } from "./riskLedger.js";
import { duplicateInspection, inspectionKey, recordInspection, type SchedulerConfig, type SchedulerState } from "./dailyScheduler.js";
import { fieldFreshness, inspectionRefusal } from "./freshness.js";

/** Fields whose reading lapses within this many simulated seconds join an inspection batch (one simulated day). */
const INSPECTION_BATCH_LOOKAHEAD_S = 60;
import { QueueKind, queueBrief } from "./actionQueue.js";
import { drainQueue, planAndStore } from "./queueRunner.js";
import type { GameEvent } from "../contracts/time.js";
import type { Plan, SessionState } from "./types.js";

/**
 * Hands out consistent snapshots. When the overview revision and simulated time have not changed since the last
 * accepted snapshot the cached parts are reused (the game is not changing, so re-reading is pure cost).
 */
export class SnapshotProvider {
  private cached: Snapshot | null = null;
  reads = 0;
  refreshes = 0;
  cacheHits = 0;
  mixedRevisionDetections = 0;
  /** Revision and simulated time of the snapshot most recently shown to the model, so an identical one is not re-sent. */
  delivered: { revision: number; simTimeS: number } | null = null;

  constructor(private readonly client: SimulatorClient, private readonly gameId: string, private readonly options: { retryDelayMs?: number } = {}) {}

  invalidate(): void {
    this.cached = null;
  }

  seed(snapshot: Snapshot): void {
    this.cached = snapshot;
  }

  async get(): Promise<Snapshot> {
    const overview = await this.client.getFarmOverview(this.gameId);
    this.reads += 1;
    if (this.cached && this.cached.revision === overview.revision && this.cached.simTimeS === overview.clock.simTimeS) {
      this.cacheHits += 1;
      return this.cached;
    }
    try {
      const snapshot = await collectSnapshot(this.client, this.gameId, { firstOverview: overview, ...(this.options.retryDelayMs !== undefined ? { retryDelayMs: this.options.retryDelayMs } : {}) });
      this.reads += snapshot.rounds * 3 - 1;
      this.mixedRevisionDetections += snapshot.mixedRevisionsDetected;
      this.refreshes += 1;
      this.cached = snapshot;
      return snapshot;
    } catch (error) {
      if (error instanceof InconsistentObservationError) this.mixedRevisionDetections += 1;
      this.cached = null;
      throw error;
    }
  }
}

export interface WaitHooks {
  maxChunkSeconds: number;
  conflictsLeft(): number;
  /**
   * Server advances a review interval may still send. When omitted it is limited like any other advance. The
   * consecutive-wait guard counts a whole interval once, so it does not shrink this number.
   */
  intervalRequestsLeft?(): number;
  onConflict(): void;
  finished(result: WaitResult): void | Promise<void>;
  finishedInterval(result: IntervalResult): void | Promise<void>;
}

export interface PlanSink {
  latest: Plan | null;
  updates: number;
}

/**
 * Inspections the model started in this run whose reading it has not received yet. An inspection is asynchronous (a few
 * simulated seconds), so ending the review right after starting one would pay for evidence nobody evaluates.
 */
export interface ReviewTracker {
  unread: Map<string, { fieldId: string; sinceS: number }>;
}

export function unreadInspectionNudge(review: ReviewTracker): string | null {
  if (review.unread.size === 0) return null;
  const [actionId, { fieldId }] = review.unread.entries().next().value as [string, { fieldId: string }];
  return `You started an inspection (${actionId}, ${fieldId}) but have not read its result, so the review is not finished. Call wait_for_operation with that actionId: its result carries the new reading. Then evaluate it: if the readings justify irrigation and/or pest treatment call plan_field_actions once with every justified request; if nothing is justified, say so. Do not describe_action again; the readings of every inspection you started arrive together with this wait.`;
}

/** Attaches the new reading to the wait result of an inspection the model has not read yet, so it can evaluate it at once. */
async function deliveredReading(
  provider: SnapshotProvider,
  context: Parameters<RegisteredTool["run"]>[0],
  review: ReviewTracker | undefined,
  result: WaitResult,
): Promise<Record<string, unknown>> {
  const pending = review?.unread.get(result.actionId);
  if (!review || !pending || result.outcome !== "completed") return {};
  try {
    const startedFields = new Set([...review.unread.values()].map((u) => u.fieldId));
    const snapshot = await provider.get();
    settleReads(review, snapshot.fields.fields);
    // Inspections started together settle together: deliver every field that is now read, not only the awaited one.
    const stillUnread = new Set([...review.unread.values()].map((u) => u.fieldId));
    const delivered = new Set([...startedFields].filter((id) => !stillUnread.has(id)));
    delivered.add(pending.fieldId);
    const compact = compactFields({ ...snapshot.fields, fields: snapshot.fields.fields.filter((f) => delivered.has(f.fieldId)) });
    context.state.observedRevision = snapshot.revision;
    review.unread.delete(result.actionId);
    return {
      inspectionReading: compact,
      next: "Evaluate these readings now. If they justify irrigation and/or pest treatment, call plan_field_actions once with every justified request for all fields (one inspection can justify several operations). If nothing is justified, state that no intervention is needed.",
    };
  } catch {
    return {};
  }
}

type SnapshotFields = Snapshot["fields"]["fields"];

/** Drops unread inspections whose field now carries a reading taken at or after the inspection started. */
function settleReads(review: ReviewTracker | undefined, fields: SnapshotFields): void {
  if (!review) return;
  for (const [actionId, { fieldId, sinceS }] of review.unread) {
    const field = fields.find((f) => f.fieldId === fieldId);
    const times = ["soilMoisture", "pestPressure"].map((q) => field?.measurements[q]?.observedAtSimTimeS);
    if (times.some((t) => typeof t === "number" && t >= sinceS)) review.unread.delete(actionId);
  }
}

const inconsistent = (error: unknown) =>
  error instanceof InconsistentObservationError
    ? fail("inconsistent_observation", "The simulator state changed between reads and no consistent snapshot could be obtained. Do not act on mixed data; try again later or report the uncertainty.", { observed: error.observed })
    : { ok: false as const, error: failureFromError(error) };

const PlanArgs = z.strictObject({
  summary: z.string().min(1).max(600).describe("Your explicit decision summary: what you decided this cycle and why, from the observations (not hidden reasoning)."),
  objective: z.string().max(300).optional().describe("The management objective you are currently pursuing."),
  priorities: z.array(z.string().max(200)).max(6).default([]).describe("Current priorities, most important first."),
  constraints: z.array(z.string().max(200)).max(6).default([]).describe("Known constraints (money, water, equipment, crop cycles)."),
  missingObservations: z.array(z.string().max(200)).max(6).default([]).describe("Important quantities you do not know."),
  pendingOperations: z.array(z.string().max(200)).max(6).default([]).describe("Operations you are waiting on."),
  nextReviewSimSeconds: z.number().nonnegative().optional().describe("Simulated clock time (seconds) at which you want to review again."),
  nextStep: z.enum(["continue", "wait_for_actions", "stop"]).describe("continue: keep managing; wait_for_actions: pending operations need time; stop: nothing useful remains to do."),
  stopReason: z.string().max(300).optional().describe("Required when nextStep is stop."),
});

export interface SchedulerToolHooks {
  state: SchedulerState;
  config: SchedulerConfig;
  /** Simulated time of this review; the model cannot advance time while the scheduler owns the clock. */
  simTimeS: number;
  /** True when an identical inspection is still in flight. */
  inFlight(key: string): boolean;
}

/**
 * Daily-review mode: the deterministic engine owns simulated time, so the model gets no time tools, and an inspection
 * identical to a recent one (with no new evidence) is refused locally, before it can reach the simulator or cost anything.
 */
function guardedExecuteAction(base: RegisteredTool, hooks: SchedulerToolHooks): RegisteredTool {
  return {
    ...base,
    async run(context, args) {
      const input = args as { type: string; params: Record<string, unknown> };
      if (!isInspectionActionType(input.type)) return base.run(context, args);
      const key = inspectionKey(input.type, input.params ?? {});
      const reason = duplicateInspection(hooks.state, hooks.config, key, hooks.simTimeS, hooks.inFlight(key));
      if (reason) {
        hooks.state.counters.duplicateInspectionsAvoided += 1;
        context.trace.record("scheduler.duplicate_inspection_refused", { type: input.type, key });
        return fail("duplicate_inspection", reason, { nothingSubmitted: true });
      }
      const outcome = await base.run(context, args);
      const data = outcome.ok ? (outcome.data as { accepted?: boolean } | null) : null;
      if (data?.accepted) recordInspection(hooks.state, key, hooks.simTimeS);
      return outcome;
    },
  };
}

export function createAutonomousTools(
  provider: SnapshotProvider,
  sink: PlanSink,
  wait?: WaitHooks,
  planning?: { state: SessionState; recentEvents: GameEvent[] },
  scheduler?: SchedulerToolHooks,
  review?: ReviewTracker,
): RegisteredTool[] {
  const tools = buildAutonomousTools(provider, sink, wait, planning, review);
  if (!scheduler) return tools;
  const TIME_TOOLS = new Set(["advance_time", "wait_for_operation", "wait_for_checkpoint"]);
  return tools.filter((t) => !TIME_TOOLS.has(t.name)).map((t) => (t.name === "execute_action" ? guardedExecuteAction(t, scheduler) : t));
}

function buildAutonomousTools(
  provider: SnapshotProvider,
  sink: PlanSink,
  wait?: WaitHooks,
  planning?: { state: SessionState; recentEvents: GameEvent[] },
  review?: ReviewTracker,
): RegisteredTool[] {
  const base = createToolRegistry();
  const reuse = (name: string): RegisteredTool => {
    const tool = base.find((t) => t.name === name);
    if (!tool) throw new Error(`Missing base tool ${name}`);
    return tool;
  };

  return [
    defineTool({
      name: "observe_snapshot",
      description: "Get a CONSISTENT snapshot: farm overview, per-field observations and a digest of eligible actions, all from the same game revision and simulated time. Each measurement keeps its own age/freshness/confidence; missing or stale quantities are unknown. Prefer this over separate reads; an unchanged game returns a short 'unchanged' marker instead of repeating the data.",
      mutating: false,
      args: z.strictObject({}),
      async run(context) {
        try {
          const snapshot = await provider.get();
          context.state.observedRevision = snapshot.revision;
          if (provider.delivered && provider.delivered.revision === snapshot.revision && provider.delivered.simTimeS === snapshot.simTimeS) {
            return succeed({ unchanged: true, revision: snapshot.revision, simTimeS: snapshot.simTimeS, note: "The game has not changed since the snapshot you already have (same revision and simulated time); it is not repeated." });
          }
          provider.delivered = { revision: snapshot.revision, simTimeS: snapshot.simTimeS };
          settleReads(review, snapshot.fields.fields);
          return succeed({ revision: snapshot.revision, simTimeS: snapshot.simTimeS, overview: snapshot.overview, fields: compactFields(snapshot.fields), actions: terseCatalog(snapshot.actions) });
        } catch (error) {
          return inconsistent(error);
        }
      },
    }),
    defineTool({
      name: "list_available_actions",
      description: "Compact catalog of the simulator's actions at the current revision: each action type once, with category, one-line summary, parameter hints (* = required), estimated cost/duration, and which targets are eligible or why not. Use describe_action for the full parameter schema of one type.",
      mutating: false,
      args: z.strictObject({
        category: z.enum(["agriculture", "machinery", "robotics", "livestock", "water", "economy"]).optional(),
        eligibleOnly: z.boolean().default(true).describe("Only action types with at least one eligible target."),
      }),
      async run(context, args) {
        try {
          const snapshot = await provider.get();
          context.state.observedRevision = snapshot.revision;
          const catalog = compactCatalog(snapshot.actions);
          const actions = catalog.actions.filter((a) => (args.category ? a.category === args.category : true) && (args.eligibleOnly ? a.eligibleTargets.length > 0 : true));
          return succeed({ ...catalog, actions });
        } catch (error) {
          return inconsistent(error);
        }
      },
    }),
    defineTool({
      name: "describe_action",
      description: "Full simulator detail for ONE action type: JSON Schema of `params`, preconditions, constraints, required equipment, and per-target eligibility with issue details. Call before execute_action when you need exact parameters.",
      mutating: false,
      args: z.strictObject({ type: z.string().min(1).max(64) }),
      async run(context, args) {
        try {
          const snapshot = await provider.get();
          context.state.observedRevision = snapshot.revision;
          const detail = describeAction(snapshot.actions, args.type);
          return detail ? succeed(detail) : fail("unknown_action_type", `The simulator offers no action type "${args.type}".`);
        } catch (error) {
          return inconsistent(error);
        }
      },
    }),
    defineTool({
      name: "compare_crop_options",
      description: "Read-only crop comparison from the current authorized snapshot: configured sale quotes, observed seed/grain stock, currently plantable fields, and simulator-published planting previews. Expected yield, crop-specific duration, seed rate, water requirement and profitability are explicitly unknown unless published by the simulator API.",
      mutating: false,
      args: z.strictObject({}),
      async run(context) {
        try {
          const snapshot = await provider.get();
          context.state.observedRevision = snapshot.revision;
          return succeed(buildCropEconomics(snapshot));
        } catch (error) {
          return inconsistent(error);
        }
      },
    }),
    defineTool({
      name: "update_plan",
      description: "OPTIONAL: record your own rolling plan and decision summary so it carries into later cycles. It does not change the farm. The runtime separately keeps a factual operational record, so only record a plan when it adds something. Revise it whenever new evidence changes your mind.",
      mutating: false,
      args: PlanArgs,
      async run(_context, args) {
        if (args.nextStep === "stop" && !args.stopReason) return fail("invalid_arguments", "stopReason is required when nextStep is stop.");
        sink.latest = {
          summary: args.summary,
          objective: args.objective ?? null,
          priorities: args.priorities,
          constraints: args.constraints,
          missingObservations: args.missingObservations,
          pendingOperations: args.pendingOperations,
          nextReviewSimSeconds: args.nextReviewSimSeconds ?? null,
          nextStep: args.nextStep,
          stopReason: args.stopReason ?? null,
        };
        sink.updates += 1;
        return succeed({ recorded: true });
      },
    }),
    guardedExecute(reuse("execute_action"), provider, planning?.state, review),
    ...(planning ? [planFieldActionsTool(provider, planning.state, review)] : []),
    reuse("advance_time"),
    ...(wait
      ? [
          defineTool({
            name: "wait_for_operation",
            description:
              "Wait (the server advances simulated time) until ONE operation you already started finishes, fails or needs your attention. The runtime sizes each advance from the simulator's own estimate, accounts only the time the server actually granted, stops on completion, failure, weather alerts or when another operation finishes, and returns a concise factual result. It never starts a farm action. Use this instead of repeated advance_time and get_action_status calls. Call it alone.",
            mutating: true,
            args: z.strictObject({
              actionId: z.string().min(1).max(100).describe("actionId returned by execute_action."),
              maxSeconds: z.number().positive().max(86_400).optional().describe("Optional cap on simulated seconds to wait (one simulated day is 60 s)."),
              rationale: z.string().min(1).max(500).optional(),
            }),
            async run(context, args) {
              if (context.state.mutationLocked) return fail("mutation_locked", "A previous state-changing request has an unconfirmed outcome; no further time advancement is allowed in this run.");
              const limits = context.policy.limits;
              const result = await superviseOperation(
                {
                  client: context.client,
                  gameId: context.gameId,
                  ...(context.journal ? { journal: context.journal } : {}),
                  newMutationId: context.newMutationId,
                  retryDelayMs: context.retryDelayMs,
                  maxMutationRetries: context.maxMutationRetries,
                  budget: {
                    requestsLeft: Math.max(0, limits.maxAdvanceRequests - context.policy.advanceRequests),
                    simSecondsLeft: Math.max(0, limits.maxTotalAdvanceSeconds - context.policy.advancedSimSeconds),
                    maxChunkSeconds: Math.min(wait.maxChunkSeconds, limits.maxAdvanceSecondsPerCall),
                    maxCallSeconds: limits.maxAdvanceSecondsPerCall,
                    conflictsLeft: wait.conflictsLeft(),
                  },
                  getCursor: () => context.state.eventCursor,
                  setCursor: (cursor) => {
                    context.state.eventCursor = cursor;
                  },
                  onAdvanced: (granted) => {
                    context.policy.advancedSimSeconds += granted;
                    context.policy.advanceRequests += 1;
                  },
                  onConflict: wait.onConflict,
                  record: (event, data) => context.trace.record(event, data),
                },
                { actionId: args.actionId, ...(args.maxSeconds !== undefined ? { maxSeconds: args.maxSeconds } : {}) },
              );
              context.state.observedRevision = null;
              provider.invalidate();
              await wait.finished(result);
              context.trace.record("supervisor.result", { ...result });
              if (result.outcome === "outcome_unknown") {
                context.state.mutationLocked = true;
                return fail("outcome_unknown", "A time advance may or may not have been applied. Further state-changing calls are blocked for this run; the controller will reconcile it with the original idempotency key.");
              }
              return succeed({ note: "Time advanced on the server. Earlier observations are stale; observe again before acting.", ...result, ...(await deliveredReading(provider, context, review, result)) });
            },
          }),
        ]
      : []),
    ...(wait
      ? [
          defineTool({
            name: "wait_for_checkpoint",
            description:
              "Let simulated time pass in bounded review checkpoints (default 5 simulated days each) up to a horizon YOU choose (max 30 days), for example while a planted crop grows. It never starts a farm action and never uses the server maximum. After every checkpoint the runtime looks at the simulator events and returns to you early on any weather alert, equipment change, operation finishing or failing, or mode change; otherwise it stops at your horizon. Observe again afterwards: nothing is inferred about crop state. Call it alone.",
            mutating: true,
            args: z.strictObject({
              maxDays: z.number().positive().max(30).describe("Horizon in simulated days (one day = 60 s)."),
              checkpointDays: z.number().min(0.5).max(10).optional().describe("Review checkpoint size in simulated days (default 5)."),
              rationale: z.string().min(1).max(500).optional(),
            }),
            async run(context, args) {
              if (context.state.mutationLocked) return fail("mutation_locked", "A previous state-changing request has an unconfirmed outcome; no further time advancement is allowed in this run.");
              const limits = context.policy.limits;
              const currentSnapshot = planning ? await provider.get() : null;
              const reviewSchedule = planning && currentSnapshot
                ? adaptReviewWindow(planning.state, currentSnapshot, planning.recentEvents, args.maxDays, args.checkpointDays)
                : null;
              if (reviewSchedule) context.trace.record("planning.review_schedule", { ...reviewSchedule });
              const result = await superviseInterval(
                {
                  client: context.client,
                  gameId: context.gameId,
                  ...(context.journal ? { journal: context.journal } : {}),
                  newMutationId: context.newMutationId,
                  retryDelayMs: context.retryDelayMs,
                  maxMutationRetries: context.maxMutationRetries,
                  budget: {
                    requestsLeft: wait.intervalRequestsLeft ? wait.intervalRequestsLeft() : Math.max(0, limits.maxAdvanceRequests - context.policy.advanceRequests),
                    simSecondsLeft: Math.max(0, limits.maxTotalAdvanceSeconds - context.policy.advancedSimSeconds),
                    maxChunkSeconds: Math.min(wait.maxChunkSeconds, limits.maxAdvanceSecondsPerCall),
                    maxCallSeconds: limits.maxAdvanceSecondsPerCall,
                    conflictsLeft: wait.conflictsLeft(),
                  },
                  getCursor: () => context.state.eventCursor,
                  setCursor: (cursor) => {
                    context.state.eventCursor = cursor;
                  },
                  onAdvanced: (granted) => {
                    context.policy.advancedSimSeconds += granted;
                    context.policy.advanceRequests += 1;
                  },
                  onConflict: wait.onConflict,
                  ...(planning ? { checkpointReview: () => reviewAtCheckpoint(context.client, context.gameId, planning.state) } : {}),
                  record: (event, data) => context.trace.record(event, data),
                },
                {
                  maxSeconds: (reviewSchedule?.effectiveMaxDays ?? args.maxDays) * 60,
                  checkpointSeconds: (reviewSchedule?.effectiveCheckpointDays ?? args.checkpointDays ?? 5) * 60,
                },
              );
              context.state.observedRevision = null;
              provider.invalidate();
              await wait.finishedInterval(result);
              context.trace.record("supervisor.interval_result", { ...result });
              if (result.outcome === "outcome_unknown") {
                context.state.mutationLocked = true;
                return fail("outcome_unknown", "A time advance may or may not have been applied. Further state-changing calls are blocked for this run; the controller will reconcile it with the original idempotency key.");
              }
              return succeed({
                ...result,
                ...(reviewSchedule ? { reviewSchedule } : {}),
                note: "Time advanced on the server. Earlier observations are stale; observe again before acting.",
              });
            },
          }),
        ]
      : []),
    reuse("get_action_status"),
    reuse("get_recent_events"),
  ];
}


/**
 * execute_action with a freshness guard for inspections: a field whose newest authorized reading is still valid (nothing
 * changed since: no intervention, no new warning, within its validity window) is not inspected again, because every
 * inspection costs credits. Missing or expired soil/pest readings, aged readings and invalidated ones are always allowed.
 */
function guardedExecute(base: RegisteredTool, provider: SnapshotProvider, state: SessionState | undefined, review: ReviewTracker | undefined): RegisteredTool {
  if (!state) return base;
  return {
    ...base,
    async run(context, args) {
      const outcome = await guardedInspect(context, args);
      if (outcome) return outcome;
      const result = await base.run(context, args);
      if (review && result.ok && isInspectionActionType(args.type) && typeof args.params === "object" && args.params !== null) {
        const data = result.data as { accepted?: boolean; action?: { actionId?: string } | null };
        const fieldId = (args.params as Record<string, unknown>).fieldId;
        if (data.accepted && data.action?.actionId && typeof fieldId === "string") {
          let sinceS = 0;
          try {
            sinceS = (await provider.get()).simTimeS;
          } catch {
            /* the reading is matched against 0 then: any existing reading clears it, which only skips a reminder */
          }
          review.unread.set(data.action.actionId, { fieldId, sinceS });
          if (args.type === "inspectField") await inspectOthersDue(context, args, fieldId);
        }
      }
      return result;
    },
  };

  /**
   * Readings expire per field, so fields drift apart and each review would otherwise re-inspect just one. When the model
   * inspects a field, the other fields whose reading is expired or lapses within a simulated day are inspected in the same
   * turn (same freshness rules and cost), so the next round is one review instead of several.
   */
  async function inspectOthersDue(context: Parameters<RegisteredTool["run"]>[0], args: Record<string, unknown>, firstFieldId: string): Promise<void> {
    if (!state || !review) return;
    let snapshot: Awaited<ReturnType<SnapshotProvider["get"]>>;
    try {
      snapshot = await provider.get();
    } catch {
      return;
    }
    for (const field of snapshot.fields.fields) {
      if (field.fieldId === firstFieldId) continue;
      if ([...review.unread.values()].some((u) => u.fieldId === field.fieldId)) continue;
      const freshness = fieldFreshness(state, field.fieldId, snapshot.simTimeS);
      const lapsesSoon = freshness.verdict === "reusable" && freshness.reuseUntilS !== null && freshness.reuseUntilS - snapshot.simTimeS <= INSPECTION_BATCH_LOOKAHEAD_S;
      const params = { ...(args.params as Record<string, unknown>), fieldId: field.fieldId };
      const next = { ...args, params };
      if (!lapsesSoon && (await guardedInspect(context, next))) continue;
      const started = await base.run(context, next);
      const data = started.ok ? (started.data as { accepted?: boolean; action?: { actionId?: string } | null }) : null;
      if (data?.accepted && data.action?.actionId) review.unread.set(data.action.actionId, { fieldId: field.fieldId, sinceS: snapshot.simTimeS });
    }
  }

  async function guardedInspect(context: Parameters<RegisteredTool["run"]>[0], args: Record<string, unknown>) {
    if (!state) return null;
      if (args.type === "inspectField" && typeof args.params === "object" && args.params !== null) {
        const fieldId = (args.params as Record<string, unknown>).fieldId;
        if (typeof fieldId === "string") {
          try {
            const snapshot = await provider.get();
            const field = snapshot.fields.fields.find((f) => f.fieldId === fieldId);
            const needed = ["soilMoisture", "pestPressure"].every((q) => {
              const m = field?.measurements[q];
              return m && m.freshness !== "expired" && m.freshness !== "never_observed";
            });
            if (needed) {
              const refusal = inspectionRefusal(fieldFreshness(state, fieldId, snapshot.simTimeS), snapshot.simTimeS);
              if (refusal) {
                context.trace.record("inspection.refused", { fieldId, code: refusal.code });
                return fail(refusal.code, refusal.message, { fieldId });
              }
            }
          } catch {
            /* an unreadable snapshot never blocks the simulator's own validation */
          }
        }
      }
      return null;
  }
}

const FieldRequest = z.strictObject({
  fieldId: z.string().min(1).max(100),
  kind: QueueKind.describe("irrigate: water the field up to near field capacity; pest_treatment: one pest-management treatment."),
  priority: z.number().int().min(1).max(5).default(3).describe("1 = most urgent."),
  reason: z.string().min(1).max(300).describe("Why, from the observations (e.g. moisture and pest readings and their age)."),
  targetMoisture: z.number().min(0).max(1).optional().describe("Irrigation only: target soil moisture fraction. Default and maximum: just under the field-capacity moisture."),
  source: z.enum(["reservoir", "creek"]).optional().describe("Irrigation water source (default reservoir)."),
  earliestInDays: z.number().min(0).max(5).optional().describe("Start no earlier than this many simulated days from now."),
});

/**
 * Plans every justified operation of an observation round at once. The model decides WHAT is justified; the runtime computes
 * quantities from the authorized soil capacity and observed moisture, validates each item with the simulator's dry run
 * (authoritative eligibility and cost), applies the cost policy, and submits the ready items through the idempotent journal.
 */
function planFieldActionsTool(provider: SnapshotProvider, state: SessionState, review?: ReviewTracker): RegisteredTool {
  return defineTool({
    name: "plan_field_actions",
    description: "Queue ALL the irrigation and pest-treatment operations your current readings justify, for one or several fields, in one call. You give the field, the kind and your reason; the runtime computes the irrigation volume (target moisture minus observed moisture, times the field soil capacity; split into as many simulator operations as needed, never padded), refuses treatments below the pest threshold or not backed by a newer observation than the last treatment, checks each item with the simulator dry run and its cost, then submits the ready ones without further inspections. Queued items persist across simulated days and restarts. Returns what was queued, reused and rejected (with reasons). Call it alone.",
    mutating: true,
    args: z.strictObject({ requests: z.array(FieldRequest).min(1).max(8) }),
    async run(context, args) {
      if (context.state.mutationLocked) return fail("mutation_locked", "A previous state-changing request has an unconfirmed outcome; no further actions are allowed in this run.");
      if (!context.journal) return fail("journal_unavailable", "Queued execution needs the session journal.");
      const journal = context.journal;
      try {
        const snapshot = await provider.get();
        context.state.observedRevision = snapshot.revision;
        const credits = snapshot.overview.finance.authorized ? snapshot.overview.finance.credits : null;
        const plan = await planAndStore({ client: context.client, gameId: context.gameId, state }, snapshot.fields, snapshot.simTimeS, credits, args.requests as never);
        context.trace.record("queue.plan", { queued: plan.queued.map((i) => i.id), rejected: plan.rejected.map((r) => `${r.fieldId}:${r.code}`) });
        const limits = context.policy.limits;
        const drained = await drainQueue({
          client: context.client,
          gameId: context.gameId,
          state,
          journal,
          newMutationId: context.newMutationId,
          retryDelayMs: context.retryDelayMs,
          maxMutationRetries: context.maxMutationRetries,
          trace: context.trace,
          maySubmit: () => !context.state.mutationLocked && context.policy.acceptedMutations < limits.maxMutations && context.policy.mutationAttempts < limits.maxMutationAttempts,
          onOutcomeUnknown: () => {
            context.state.mutationLocked = true;
          },
          onAccepted: () => {
            context.policy.acceptedMutations += 1;
            context.policy.mutationAttempts += 1;
          },
        });
        context.state.observedRevision = null;
        provider.invalidate();
        review?.unread.clear();
        if (drained.locked) return fail("outcome_unknown", "A queued request may or may not have been applied. Further state-changing calls are blocked for this run; the controller will reconcile it with the original idempotency key.");
        return succeed({
          queued: queueBrief(plan.queued, snapshot.simTimeS) ?? [],
          alreadyQueued: plan.reused.map((i) => i.id),
          rejected: plan.rejected,
          submittedNow: drained.submitted,
          note: "Items not yet submitted (later parts of an irrigation, delayed or blocked by a running operation) run automatically as their predecessors finish. Do not re-plan them and do not inspect a field only to confirm them.",
        });
      } catch (error) {
        return inconsistent(error);
      }
    },
  });
}