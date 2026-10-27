import { z } from "zod";
import type { SimulatorClient } from "../simulator/client.js";
import { createToolRegistry, defineTool, failureFromError, fail, succeed, type RegisteredTool } from "../agent/tools.js";
import { compactCatalog, describeAction, terseCatalog } from "./catalog.js";
import { compactFields } from "./compactObservation.js";
import { collectSnapshot, InconsistentObservationError, type Snapshot } from "./observation.js";
import { superviseInterval, superviseOperation, type IntervalResult, type WaitResult } from "./supervisor.js";
import type { Plan } from "./types.js";

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
  onConflict(): void;
  finished(result: WaitResult): void;
  finishedInterval(result: IntervalResult): void;
}

export interface PlanSink {
  latest: Plan | null;
  updates: number;
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

export function createAutonomousTools(provider: SnapshotProvider, sink: PlanSink, wait?: WaitHooks): RegisteredTool[] {
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
    reuse("execute_action"),
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
              wait.finished(result);
              context.trace.record("supervisor.result", { ...result });
              if (result.outcome === "outcome_unknown") {
                context.state.mutationLocked = true;
                return fail("outcome_unknown", "A time advance may or may not have been applied. Further state-changing calls are blocked for this run; the controller will reconcile it with the original idempotency key.");
              }
              return succeed({ ...result, note: "Time advanced on the server. Earlier observations are stale; observe again before acting." });
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
              const result = await superviseInterval(
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
                { maxSeconds: args.maxDays * 60, checkpointSeconds: (args.checkpointDays ?? 5) * 60 },
              );
              context.state.observedRevision = null;
              provider.invalidate();
              wait.finishedInterval(result);
              context.trace.record("supervisor.interval_result", { ...result });
              if (result.outcome === "outcome_unknown") {
                context.state.mutationLocked = true;
                return fail("outcome_unknown", "A time advance may or may not have been applied. Further state-changing calls are blocked for this run; the controller will reconcile it with the original idempotency key.");
              }
              return succeed({ ...result, note: "Time advanced on the server. Earlier observations are stale; observe again before acting." });
            },
          }),
        ]
      : []),
    reuse("get_action_status"),
    reuse("get_recent_events"),
  ];
}
