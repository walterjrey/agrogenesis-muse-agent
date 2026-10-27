import { z } from "zod";
import type { SimulatorClient } from "../simulator/client.js";
import { createToolRegistry, defineTool, failureFromError, fail, succeed, type RegisteredTool } from "../agent/tools.js";
import { compactCatalog, describeAction } from "./catalog.js";
import { collectSnapshot, InconsistentObservationError, type Snapshot } from "./observation.js";
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

export function createAutonomousTools(provider: SnapshotProvider, sink: PlanSink): RegisteredTool[] {
  const base = createToolRegistry();
  const reuse = (name: string): RegisteredTool => {
    const tool = base.find((t) => t.name === name);
    if (!tool) throw new Error(`Missing base tool ${name}`);
    return tool;
  };

  return [
    defineTool({
      name: "observe_snapshot",
      description: "Get a CONSISTENT snapshot: farm overview, per-field observations and a compact action catalog, all from the same game revision and simulated time. Each measurement keeps its own age/freshness/confidence; missing or stale quantities are unknown. Prefer this over separate reads; the call is cheap when the game has not changed.",
      mutating: false,
      args: z.strictObject({}),
      async run(context) {
        try {
          const snapshot = await provider.get();
          context.state.observedRevision = snapshot.revision;
          return succeed({ revision: snapshot.revision, simTimeS: snapshot.simTimeS, overview: snapshot.overview, fields: snapshot.fields, actions: compactCatalog(snapshot.actions) });
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
      description: "Record your rolling plan and an explicit decision summary for this cycle. It does not change the farm. Revise it whenever new evidence changes your mind; it is not a fixed script. Call it once near the end of each cycle, then give a one-line final answer.",
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
    reuse("get_action_status"),
    reuse("get_recent_events"),
  ];
}
