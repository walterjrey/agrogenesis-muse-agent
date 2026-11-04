import { isActiveQueueStatus, pruneQueue, reconcileQueue } from "./actionQueue.js";
import { drainQueue } from "./queueRunner.js";
import { createHash, randomUUID } from "node:crypto";
import { runAgent } from "../agent/runtime.js";
import type { MutationIntent, MutationJournal, MutationSettlement } from "../agent/tools.js";
import type { ExecuteActionRequest } from "../contracts/execute.js";
import type { AdvanceRequest } from "../contracts/time.js";
import type { GameEvent } from "../contracts/time.js";
import type { ModelProvider } from "../model/meta.js";
import { SimulatorError, type SimulatorClient } from "../simulator/client.js";
import { InconsistentObservationError, summarizeSnapshot, isAuthFailure } from "./observation.js";
import { buildEconomics, ledgerEntry } from "./economics.js";
import { AUTONOMOUS_SYSTEM_PROMPT, DAILY_REVIEW_PROMPT_ADDENDUM, DEFAULT_OBJECTIVE, cycleBrief } from "./prompt.js";
import { measureCycleBrief } from "./promptMetrics.js";
import { SessionLockLostError } from "./store.js";
import type { SessionBackend, SessionLease } from "./storage.js";
import { isInspectionActionType } from "./actionClassification.js";
import { buildProgress } from "./progress.js";
import { superviseInterval, superviseOperation, type IntervalResult, type WaitResult } from "./supervisor.js";
import { reviewAtCheckpoint, refreshLedger, dueReviews } from "./riskLedger.js";
import { SchedulerConfig, absorbObservations, addTrigger, beginReview, classifyTrigger, decide, dayOf, endReview, inspectionKey, isObservationEvent, newSchedulerState, nextDayBoundary, rollDay } from "./dailyScheduler.js";
import { requiresDecision } from "./eventClassification.js";
import { createAutonomousTools, SnapshotProvider, unreadInspectionNudge, type PlanSink, type ReviewTracker } from "./tools.js";
import { DEFAULT_SESSION_LIMITS, PLANNING_POLICY_VERSION, TERMINAL_ACTION_STATUSES, transitionLifecycle, type ObservationSummary, type PlanningConfig, type ScenarioManifest, type SessionLimits, type SessionState, type SessionLifecycle, type WaitRecord } from "./types.js";

export interface NewSessionOptions {
  sessionId?: string;
  gameId: string;
  modelId: string;
  mutationsEnabled: boolean;
  objective?: string;
  limits?: Partial<SessionLimits>;
  /** Let the controller wait (server time only) for operations the model already started. Default true. */
  autoWait?: boolean;
  /** Starting-condition identity supplied by the operator (seed, scenario name, DB snapshot hash). */
  scenario?: Partial<ScenarioManifest>;
  /** Versioned planning context. Horizon is explicit and independent of the session's time-advance budget. */
  planning?: Partial<PlanningConfig>;
  autonomyMode?: "legacy" | "continuous";
  /** Daily review scheduler overrides (continuous mode). `enabled: false` restores per-cycle behaviour. */
  scheduler?: Partial<SchedulerConfig>;
}

const EMPTY_SCENARIO: ScenarioManifest = { name: null, seed: null, startSnapshotSha256: null, worldConfigSha256: null, startObservationSha256: null, startRevision: null, startSimTimeS: null, notes: [] };

/** Persistent exponential recovery delay: 5 s doubling per attempt, capped at 5 minutes. */
export function recoveryDelayMs(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, Math.min(attempt, 16) - 1));
}

export type FailureClass = "transient" | "configuration" | "authentication";

/** Classifies a model/provider error string. Only definitive 4xx client errors are deterministic; everything else may recover. */
export function classifyModelError(message: string | null | undefined): FailureClass {
  const text = message ?? "";
  if (/HTTP (401|403)/.test(text)) return "authentication";
  if (/HTTP (400|404|405|409|410|413|415|422)\b/.test(text)) return "configuration";
  return "transient";
}

/** Simulator connectivity and 5xx/timeouts are transient; anything else thrown by the controller is a deterministic fault. */
export function isTransientControllerError(error: unknown): boolean {
  if (error instanceof SimulatorError) return error.kind === "network" || error.kind === "timeout" || (error.kind === "http" && (error.status === undefined || error.status >= 500 || error.status === 429));
  const message = error instanceof Error ? error.message : "";
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed? ?out/i.test(message);
}

/** Real-time bound for one accelerated wait inside a worker slice; the next slice continues without a model call. */
const ACCELERATED_WAIT_SLICE_MS = 30_000;
const SLICE_TIME_BOUND = "slice time bound";

/** Primitive request parameters only (crop, volumeM3, kg, ...). */
function primitiveParams(request: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const params = request.params;
  if (typeof params !== "object" || params === null) return out;
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  return out;
}

/** Why the consecutive-wait guard fired: waiting for known crop growth versus plain inactivity. */
export function describeInactivity(state: SessionState): string {
  const n = state.budgets.consecutiveAdvances;
  const max = state.config.limits.maxConsecutiveAdvances;
  const planted = buildProgress(state).fields.filter((f) => f.plantedCrop !== null && f.simDaysSincePlanting !== null);
  const base = `${n}/${max} consecutive waits without an accepted farm action or inspection.`;
  if (planted.length === 0) return `${base} No crop is known to be growing, so this is inactivity: nothing in progress justified further waiting.`;
  const oldest = Math.max(...planted.map((f) => f.simDaysSincePlanting!));
  return `${base} ${planted.length} planted field(s) were growing (oldest ${oldest} sim days since planting), so this is an inactivity cap on a long wait for crop growth, not a failure; start a new session to continue monitoring.`;
}

/** Why no_progress fired: names what failed to advance over the stagnant cycles so the stop is actionable. */
export function describeNoProgress(state: SessionState, backoffSeconds?: number): string {
  const n = state.budgets.consecutiveNoProgress;
  const recent = state.decisions.slice(-n);
  const failedModel = recent.filter((d) => d.stopReason === "model_error" || d.stopReason === "empty_response").length;
  const rejected = recent.reduce((sum, d) => sum + Math.max(0, d.actionsSubmitted - d.actionsAccepted), 0);
  const waited = recent.reduce((sum, d) => sum + d.advancedSeconds, 0);
  const causes = [
    failedModel > 0 ? `${failedModel} cycle(s) ended without a usable model decision` : null,
    rejected > 0 ? `${rejected} action(s) were rejected` : null,
    waited === 0 ? "no server time was granted (simulated time did not advance)" : null,
    "no action or inspection was accepted, no operation completed or failed, no new observation or field warning arrived, and the set of eligible actions did not change",
  ].filter((c) => c !== null);
  if (backoffSeconds !== undefined) return `${n} consecutive cycles without progress: ${causes.join("; ")}. Autonomy stays enabled: waiting ${backoffSeconds}s and for the next simulation checkpoint before asking the model again; a new event, an accepted action or a change in eligible actions resets this.`;
  return `${n} consecutive cycles without progress: ${causes.join("; ")}. Continuing would spend model calls without changing the farm or the simulation clock; review the plan, then resume.`;
}

export function newSessionState(options: NewSessionOptions): SessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: options.sessionId ?? `s-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`,
    gameId: options.gameId,
    createdAt: now,
    updatedAt: now,
    status: "paused",
    lifecycle: "paused_by_user",
    stopReason: "not_started",
    stopDetail: null,
    config: { modelId: options.modelId, mutationsEnabled: options.mutationsEnabled, autonomyMode: options.autonomyMode ?? "legacy", objective: options.objective ?? DEFAULT_OBJECTIVE, limits: { ...DEFAULT_SESSION_LIMITS, ...options.limits }, autoWait: options.autoWait ?? true, planning: { policyVersion: PLANNING_POLICY_VERSION, horizonDays: null, ...options.planning }, scenario: { ...EMPTY_SCENARIO, ...options.scenario } },
    cycle: 0,
    allocationCycles: 0,
    pendingModelCycle: null,
    waitingUntilSimTimeS: null,
    recoveryAttempts: 0,
    retryAfter: null,
    plan: null,
    decisions: [],
    actions: [],
    operations: [],
    waits: [],
    progress: null,
    riskLedger: {},
    scheduler: { config: SchedulerConfig.parse(options.scheduler ?? {}), state: newSchedulerState() },
    queue: [],
    pendingMutation: null,
    lastRevision: null,
    lastSimTimeS: null,
    modelEventCursor: 0,
    progressCursor: 0,
    budgets: { costUsd: 0, modelCalls: 0, toolCalls: 0, acceptedMutations: 0, mutationAttempts: 0, rejectedActions: 0, acceptedInspections: 0, inspectionAttempts: 0, rejectedInspections: 0, advancedSimSeconds: 0, wallClockMs: 0, consecutiveErrors: 0, consecutiveNoProgress: 0,     consecutiveRejections: 0, advanceRequests: 0, consecutiveAdvances: 0, conflicts: 0, failedModelCalls: 0, modelRetryAttempts: 0, lifetimeModelCallsCharged: 0 },
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    metrics: { baseline: null, latest: null, controllerReads: 0, snapshotRefreshes: 0, snapshotCacheHits: 0, mixedRevisionDetections: 0, grainPeakKg: {}, ledger: [] },
  };
}

export interface ControllerOptions {
  store: SessionBackend;
  sessionId: string;
  provider: ModelProvider;
  client: SimulatorClient;
  /** Mutations run only if the persisted session allows them AND the caller re-confirms them for this process. */
  mutationsEnabled: boolean;
  /** Pause with `slice_complete` after this many cycles in this process (resume continues the same budgets). */
  sliceCycles?: number;
  newMutationId?: () => string;
  retryDelayMs?: number;
  /** Where per-cycle JSONL traces are written; defaults to the backend's trace directory (none for non-file backends). */
  traceDirectory?: string | null;
  onEvent?: (message: string) => void;
  /** Aborts an in-flight model request or retry backoff (e.g. worker shutdown). */
  signal?: AbortSignal;
  /** Real-time bound (ms) for one accelerated wait inside a slice. Default 30 s. */
  waitSliceMs?: number;
}

const REASONS_RESUMABLE = new Set(["paused", "running"]);

const settledExecute = (type: string, response: Awaited<ReturnType<SimulatorClient["executeAction"]>>): MutationSettlement => ({
  status: response.accepted ? "applied" : "rejected",
  revisionAfter: response.revision,
  summary: { type, accepted: response.accepted, actionId: response.action?.actionId ?? null, actionStatus: response.action?.status ?? null, finishedAtS: response.action?.finishedAtS ?? null, outcomeSummary: response.action?.outcome?.summary ?? null, measurements: response.action?.outcome?.measurements ?? {}, consumed: response.action?.consumed ?? null, errors: response.errors },
});

const settledAdvance = (response: Awaited<ReturnType<SimulatorClient["advance"]>>): MutationSettlement => ({
  status: "applied",
  revisionAfter: null,
  summary: { grantedSeconds: response.grantedSeconds, stoppedBecause: response.stoppedBecause, simTimeAfterS: response.clockAfter.simTimeS, eventCount: response.events.length },
});

const isDefinitiveRefusal = (error: unknown): boolean => error instanceof SimulatorError && error.kind === "http" && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500 && !isAuthFailure(error);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const remainingSimFor = (state: SessionState): number =>
  state.config.autonomyMode === "continuous" ? Number.MAX_SAFE_INTEGER : Math.max(0, state.config.limits.maxSimSeconds - state.budgets.advancedSimSeconds);

/** Continuous sessions have no lifetime quotas; waits are bounded per call, not per lifetime. */
const advanceRequestsLeftFor = (state: SessionState): number => {
  const { limits: l } = state.config;
  const b = state.budgets;
  if (state.config.autonomyMode === "continuous") return Math.max(0, l.maxAdvanceRequests);
  return Math.max(0, l.maxAdvanceRequests - b.advanceRequests);
};

export class AutonomousController {
  private lock!: SessionLease;
  private state!: SessionState;
  private provider!: SnapshotProvider;
  private readonly startedAt = Date.now();
  private wallBase = 0;
  /** Eligible-action signature of the previous cycle (in memory only: the first cycle after a restart sets the baseline). */
  private lastEligibility: string | null = null;
  private mutationsEnabled = false;

  constructor(private readonly options: ControllerOptions) {}

  /** Takes exclusive ownership of the session and loads it. Called once, by run(). */
  private async open(): Promise<void> {
    const { store, sessionId } = this.options;
    this.lock = await store.acquire(sessionId);
    try {
      this.state = await store.load(sessionId);
    } catch (error) {
      await this.lock.release();
      throw error;
    }
    if (!REASONS_RESUMABLE.has(this.state.status)) {
      await this.lock.release();
      throw new Error(`Session ${sessionId} is ${this.state.status} (${this.state.stopReason}) and cannot be resumed. Budgets are never raised automatically; start a new session.`);
    }
    if (this.state.config.autonomyMode === "continuous" && this.state.stopReason === "allocation_complete") {
      this.state.allocationCycles = 0;
    }
    if (this.state.lifecycle === "paused_by_user" && this.state.waitingUntilSimTimeS !== null) {
      this.setLifecycle("waiting_for_simulation");
    }
    this.mutationsEnabled = this.state.config.mutationsEnabled && this.options.mutationsEnabled;
    this.provider = new SnapshotProvider(this.options.client, this.state.gameId, { retryDelayMs: this.options.retryDelayMs ?? 250 });
    this.wallBase = this.state.budgets.wallClockMs;
  }

  private log(message: string): void {
    this.options.onEvent?.(message);
  }

  private setLifecycle(next: SessionLifecycle): void {
    try {
      this.state.lifecycle = transitionLifecycle(this.state.lifecycle, next);
    } catch {
      // A rejected transition must never wedge a session in a retry loop; the new lifecycle wins.
      this.state.lifecycle = next;
    }
  }

  private async save(): Promise<void> {
    this.state.budgets.wallClockMs = this.wallBase + (Date.now() - this.startedAt);
    this.state.metrics.controllerReads += this.provider.reads;
    this.state.metrics.snapshotRefreshes += this.provider.refreshes;
    this.state.metrics.snapshotCacheHits += this.provider.cacheHits;
    this.state.metrics.mixedRevisionDetections += this.provider.mixedRevisionDetections;
    this.provider.reads = this.provider.refreshes = this.provider.cacheHits = this.provider.mixedRevisionDetections = 0;
    await this.lock.save(this.state);
  }

  private async end(status: SessionState["status"], reason: string, detail: string | null = null): Promise<SessionState> {
    this.state.status = status;
    this.state.stopReason = reason;
    this.state.stopDetail = detail;
    if (status === "completed") this.setLifecycle("completed");
    else if (status === "failed") this.setLifecycle("failed");
    else if (reason === "waiting_for_simulation") this.setLifecycle("waiting_for_simulation");
    else if (this.isBudgetReason(reason)) this.setLifecycle("awaiting_budget");
    else if (reason === "consecutive_errors" || reason === "controller_error" || reason === "no_progress" || reason === "repeated_rejections" || reason === "simulation_wait_interrupted") this.setLifecycle("recovering");
    else if (reason === "authentication_failure" || reason === "inconsistent_observation" || reason === "recovery_attempts_exhausted" || reason === "model_configuration_error" || reason === "simulation_wait_refused") this.setLifecycle("failed");
    else if (reason === "paused_by_operator" || reason === "cancelled_by_operator") this.setLifecycle("paused_by_user");
    else if (reason === "slice_complete" || reason === "allocation_complete") this.setLifecycle("running");
    else if (status === "stopped") this.setLifecycle("failed");
    this.log(`session ${status}: ${reason}${detail ? ` (${detail})` : ""}`);
    await this.save();
    return this.state;
  }

  /** Continuous sessions answer a zero-time-advance loop with bounded, backed-off recovery slices, then an actionable failure. */
  private async zeroTimeRecovery(detail: string): Promise<SessionState> {
    this.state.budgets.consecutiveAdvances = 0;
    return this.transientRecovery("consecutive_errors", detail);
  }

  /**
   * Transient failures (provider outage, simulator connectivity, interrupted waits, zero-time loops) never end a
   * continuous session. Each one persists an exponentially growing retryAfter (5 s doubling, capped at 5 min) that the
   * worker claim query honors across restarts, so recovery is automatic, cheap and never a tight loop.
   */
  private async transientRecovery(reason: "consecutive_errors" | "simulation_wait_interrupted", detail: string | null): Promise<SessionState> {
    const s = this.state;
    s.recoveryAttempts += 1;
    s.retryAfter = new Date(Date.now() + recoveryDelayMs(s.recoveryAttempts)).toISOString();
    const note = `Automatic recovery attempt ${s.recoveryAttempts}; next retry after ${s.retryAfter}.`;
    return this.end("paused", reason, detail ? `${detail.slice(0, 300)} ${note}` : note);
  }

  /**
   * Continuous sessions never stop for a lack of mutations. Ineffective decisions are answered with an exponentially
   * backed-off real-time delay (honored by the worker claim query, so no tight loop and no model call during it) and,
   * when the farm allows it, a server-authoritative simulation checkpoint to wait for a meaningful change. Progress,
   * a new event, or a change in eligible actions resets the streak.
   */
  private async noProgressBackoff(): Promise<SessionState> {
    const s = this.state;
    const over = Math.max(0, s.budgets.consecutiveNoProgress - s.config.limits.maxConsecutiveNoProgress);
    const inFlight = s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
    if (this.mutationsEnabled && !inFlight && s.lastSimTimeS !== null) {
      // The wait itself is the backoff: simulated time advances on the server with no model call and no real-time idling.
      // Each further ineffective decision doubles the wait (up to 8x the per-call cap); any event interrupts it.
      const waitSeconds = s.config.limits.maxAdvanceSecondsPerCall * 2 ** Math.min(over, 3);
      s.waitingUntilSimTimeS = s.lastSimTimeS + waitSeconds;
      await this.save();
      return this.end("paused", "waiting_for_simulation", describeNoProgress(s));
    }
    const delaySeconds = Math.min(600, 10 * 2 ** Math.min(over, 6));
    s.retryAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
    return this.end("paused", "slice_complete", describeNoProgress(s, delaySeconds));
  }

  private isBudgetReason(reason: string): boolean {
    return new Set([
      "awaiting_budget", "cost_budget_exhausted", "model_call_budget_exhausted", "lifetime_model_call_budget_exhausted", "tool_call_budget_exhausted",
      "wall_clock_exhausted", "cycle_budget_exhausted", "sim_time_limit_reached",
      "advance_request_budget_exhausted", "mutation_budget_exhausted", "inspection_budget_exhausted",
      "farm_spend_limit_reached", "zero_time_advance_limit",
    ]).has(reason);
  }

  /** Records a settled mutation exactly once, updates counters and clears the pending record. */
  private async settle(intent: MutationIntent, settlement: MutationSettlement, via: "direct" | "reconciled"): Promise<void> {
    const s = this.state;
    const b = s.budgets;
    s.operations.push({ tool: intent.tool, idempotencyKey: intent.idempotencyKey, status: settlement.status, expectedRevision: intent.expectedRevision, revisionAfter: settlement.revisionAfter, summary: settlement.summary, cycle: s.cycle, settledAt: new Date().toISOString(), via });
    if (settlement.revisionAfter !== null) s.lastRevision = settlement.revisionAfter;
    if (intent.tool === "execute_action") {
      const inspectionOnly = isInspectionActionType(intent.request.type);
      if (settlement.status === "applied") {
        if (inspectionOnly) {
          b.acceptedInspections += 1;
          b.inspectionAttempts += 1;
        } else {
          b.acceptedMutations += 1;
          b.mutationAttempts += 1;
        }
        b.consecutiveRejections = 0;
        const actionId = settlement.summary.actionId;
        if (typeof actionId === "string") {
          const status = settlement.summary.actionStatus;
          s.actions.push({ actionId, type: String(settlement.summary.type ?? ""), status: typeof status === "string" ? (status as SessionState["actions"][number]["status"]) : "scheduled", submittedAtRevision: intent.expectedRevision,           idempotencyKey: intent.idempotencyKey, lastCheckedAt: null, target: typeof intent.request.params === "object" && intent.request.params !== null && typeof (intent.request.params as Record<string, unknown>).fieldId === "string" ? String((intent.request.params as Record<string, unknown>).fieldId) : typeof intent.request.targetId === "string" ? intent.request.targetId : null, startedAtS: null, estimatedCompletionS: null, finishedAtS: null, progress: null, consumedCredits: null, outcome: null, failure: null, params: primitiveParams(intent.request), consumedWaterM3: null, consumedSeedKg: null, consumedFuelL: null, measurements: {} });
          const tracked = s.actions[s.actions.length - 1]!;
          const sum = settlement.summary as Record<string, unknown>;
          if (typeof sum.startedAtS === "number") tracked.startedAtS = sum.startedAtS;
          if (typeof sum.estimatedCompletionS === "number") tracked.estimatedCompletionS = sum.estimatedCompletionS;
          if (typeof sum.finishedAtS === "number") tracked.finishedAtS = sum.finishedAtS;
          if (typeof sum.progress === "number") tracked.progress = sum.progress;
          if (typeof sum.outcomeSummary === "string") tracked.outcome = sum.outcomeSummary;
          if (sum.measurements && typeof sum.measurements === "object") tracked.measurements = Object.fromEntries(Object.entries(sum.measurements).filter(([, v]) => typeof v === "number")) as Record<string, number>;
          const consumed = sum.consumed as { credits?: number; waterM3?: number; seedKg?: number; fuelL?: number } | null | undefined;
          if (consumed) {
            tracked.consumedCredits = consumed.credits ?? null;
            tracked.consumedWaterM3 = consumed.waterM3 ?? null;
            tracked.consumedSeedKg = consumed.seedKg ?? null;
            tracked.consumedFuelL = consumed.fuelL ?? null;
          }
        }
                  b.consecutiveAdvances = 0;
      } else if (settlement.status === "rejected") {
        b.rejectedActions += 1;
        if (inspectionOnly) {
          b.rejectedInspections += 1;
          b.inspectionAttempts += 1;
        } else {
          b.mutationAttempts += 1;
        }
        b.consecutiveRejections += 1;
      }
    } else if (settlement.status === "applied") {
      const granted = Number(settlement.summary.grantedSeconds ?? 0);
      b.advancedSimSeconds += granted;
      b.advanceRequests += 1;
      b.consecutiveAdvances = granted > 0 ? 0 : b.consecutiveAdvances + 1;
      if (typeof settlement.summary.simTimeAfterS === "number") s.lastSimTimeS = settlement.summary.simTimeAfterS;
    }
    if (settlement.status === "not_applied" && settlement.summary.code === "stale_revision") b.conflicts += 1;
    s.pendingMutation = null;
    this.provider.invalidate();
    await this.save();
  }

  private readonly journal: MutationJournal = {
    begin: async (intent) => {
      this.state.pendingMutation = { tool: intent.tool, idempotencyKey: intent.idempotencyKey, expectedRevision: intent.expectedRevision, request: intent.request, rationale: intent.rationale, recordedAt: new Date().toISOString(), cycle: this.state.cycle };
      await this.save();
    },
    settle: async (intent, settlement) => this.settle(intent, settlement, "direct"),
  };

  /**
   * Resolves a mutation that was recorded but never confirmed by replaying the EXACT persisted request with the
   * SAME idempotency key. The simulator returns the stored result if it had committed, executes at most once if not,
   * and refuses with 4xx (e.g. stale revision) if it can no longer be applied.
   */
  private async reconcile(): Promise<boolean> {
    const pending = this.state.pendingMutation;
    if (!pending) return true;
    const intent: MutationIntent = { tool: pending.tool, idempotencyKey: pending.idempotencyKey, expectedRevision: pending.expectedRevision, request: pending.request, rationale: pending.rationale };
    this.log(`reconciling unconfirmed ${pending.tool} with its original idempotency key`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (pending.tool === "execute_action") {
          const response = await this.options.client.executeAction(this.state.gameId, pending.request as unknown as ExecuteActionRequest);
          await this.settle(intent, settledExecute(String(pending.request.type ?? ""), response), "reconciled");
        } else {
          const response = await this.options.client.advance(this.state.gameId, pending.request as unknown as AdvanceRequest);
          await this.settle(intent, settledAdvance(response), "reconciled");
        }
        return true;
      } catch (error) {
        if (isDefinitiveRefusal(error)) {
          await this.settle(intent, { status: "not_applied", revisionAfter: null, summary: { reason: error instanceof SimulatorError ? error.message : "refused" } }, "reconciled");
          return true;
        }
        await sleep((this.options.retryDelayMs ?? 250) * (attempt + 1));
      }
    }
    return false;
  }

  /** Logical model calls charged against the optional lifetime cap (reservations count, so a crash can only over-charge). */
  private lifetimeCallsUsed(): number {
    const b = this.state.budgets;
    return Math.max(b.lifetimeModelCallsCharged, b.modelCalls + b.failedModelCalls);
  }

  /** null when the session has no lifetime cap; otherwise the calls still available (never negative). */
  private lifetimeCallsLeft(): number | null {
    const cap = this.state.config.limits.maxLifetimeModelCalls;
    return cap === null || cap === undefined ? null : Math.max(0, cap - this.lifetimeCallsUsed());
  }

  /** forWait: waiting for an already-authorized operation spends no model/tool/cycle budget, so only the time, spending and conflict limits apply. */
  private budgetStop(forWait = false): { reason: string; detail: string } | null {
    const { budgets: b, config, cycle } = this.state;
    const l = config.limits;
    const wall = this.wallBase + (Date.now() - this.startedAt);
    if (!forWait && this.lifetimeCallsLeft() === 0) return { reason: "lifetime_model_call_budget_exhausted", detail: `${this.lifetimeCallsUsed()}/${l.maxLifetimeModelCalls} logical model calls over the whole session (never reset by a new cycle, poll or resume)` };
    if (config.autonomyMode === "continuous") {
      // Continuous autonomy has no lifetime execution quotas (cycles, model/tool/advance calls, worker time,
      // mutations, inspections, simulated time, cumulative farm spending): those counters are observability only.
      // The in-game economy itself (cash, costs, inventory) is validated by the server per transaction. Only the
      // optional, explicit API spending cap, conflicts and the zero-time-advance loop guard end a slice.
      if (!forWait && !l.unlimitedSpending && b.costUsd >= l.maxCostUsd) return { reason: "cost_budget_exhausted", detail: `$${b.costUsd.toFixed(4)} of $${l.maxCostUsd}` };
      if (b.conflicts >= l.maxConflicts) return { reason: "database_conflict_limit", detail: `${b.conflicts}/${l.maxConflicts} stale-revision conflicts` };
      if (this.mutationsEnabled && b.consecutiveAdvances >= l.maxConsecutiveAdvances) return { reason: "zero_time_advance_limit", detail: `${b.consecutiveAdvances} consecutive advance requests granted no simulation time.` };
      return null;
    }
    if (!forWait && b.costUsd >= l.maxCostUsd) return { reason: "cost_budget_exhausted", detail: `$${b.costUsd.toFixed(4)} of $${l.maxCostUsd}` };
    const logicalModelCalls = b.modelCalls + b.failedModelCalls;
    if (!forWait && logicalModelCalls >= l.maxModelCalls) return { reason: "model_call_budget_exhausted", detail: `${logicalModelCalls}/${l.maxModelCalls} logical calls (successful or failed)` };
    if (!forWait && b.toolCalls >= l.maxToolCalls) return { reason: "tool_call_budget_exhausted", detail: `${b.toolCalls}/${l.maxToolCalls}` };
    if (wall >= l.maxWallClockMs) return { reason: "wall_clock_exhausted", detail: `${Math.round(wall / 1000)}s of ${Math.round(l.maxWallClockMs / 1000)}s` };
    if (!forWait && cycle >= l.maxCycles) return { reason: "cycle_budget_exhausted", detail: `${cycle}/${l.maxCycles}` };
    if (b.conflicts >= l.maxConflicts) return { reason: "database_conflict_limit", detail: `${b.conflicts}/${l.maxConflicts} stale-revision conflicts` };
    if (this.mutationsEnabled) {
      if (b.advancedSimSeconds >= l.maxSimSeconds) return { reason: "sim_time_limit_reached", detail: `${b.advancedSimSeconds}/${l.maxSimSeconds} s` };
      if (b.advanceRequests >= l.maxAdvanceRequests) return { reason: "advance_request_budget_exhausted", detail: `${b.advanceRequests}/${l.maxAdvanceRequests}` };
      if (b.consecutiveAdvances >= l.maxConsecutiveAdvances) return { reason: "zero_time_advance_limit", detail: `${b.consecutiveAdvances} consecutive advance requests granted no simulation time.` };
      const spent = this.farmSpend();
      if (spent !== null && spent >= l.maxFarmSpendCredits) return { reason: "farm_spend_limit_reached", detail: `${spent} of ${l.maxFarmSpendCredits} credits` };
      const inFlight = this.state.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
      if (b.acceptedMutations >= l.maxMutations && !inFlight) return { reason: "mutation_budget_exhausted", detail: `${b.acceptedMutations}/${l.maxMutations}` };
    }
    return null;
  }

  /** Explains the consecutive-wait guard in terms of what the session was actually doing. */
  private inactivityDetail(): string {
    return describeInactivity(this.state);
  }

  /** Realized farm costs since the first observation of this session; null when finance is not authorized/observed. */
  private farmSpend(): number | null {
    const { latest, baseline } = this.state.metrics;
    return latest?.realizedCosts != null && baseline?.realizedCosts != null ? latest.realizedCosts - baseline.realizedCosts : null;
  }

  private async refreshActions(): Promise<void> {
    // A terminal status can arrive through a wait record that carries no water/seed/fuel; fetch the final record once so consumption is never left at its submit-time value.
    const finalFetchesLeft = { n: 20 };
    const due = this.state.actions.filter((a) => !TERMINAL_ACTION_STATUSES.has(a.status) || (a.lastCheckedAt === null && finalFetchesLeft.n-- > 0));
    for (const action of due) {
      try {
        const { action: view } = await this.options.client.getAction(this.state.gameId, action.actionId);
        action.status = view.status;
        action.target = view.target?.id ?? action.target;
        action.lastCheckedAt = new Date().toISOString();
        action.startedAtS = view.startedAtS ?? null;
        action.estimatedCompletionS = view.estimatedCompletionS ?? null;
        action.finishedAtS = view.finishedAtS ?? null;
        action.progress = view.progress ?? null;
        action.consumedCredits = view.consumed?.credits ?? null;
        action.consumedWaterM3 = view.consumed?.waterM3 ?? null;
        action.consumedSeedKg = view.consumed?.seedKg ?? null;
        action.consumedFuelL = view.consumed?.fuelL ?? null;
        action.outcome = view.outcome?.summary ?? null;
        action.measurements = view.outcome?.measurements ?? {};
        action.failure = view.failure ? `${view.failure.code}: ${view.failure.detail}`.slice(0, 200) : null;
      } catch {
        /* keep the last known status */
      }
    }
  }

  /**
   * Progress = something verifiably moved: an accepted mutation or inspection, server time actually granted by an
   * advance (waiting for crops is legitimate), a simulator event (completion, failure, delivered observation or a
   * redacted field-attention warning), or a change in which actions the simulator says are eligible (e.g. harvest
   * becoming available). Failed model runs earn no credit, so empty responses and blocked execution still stagnate.
   */
  private async evaluateProgress(before: { accepted: number; inspections: number; advanced: number }, failedRun: boolean, eligibilityChanged: boolean): Promise<{ progress: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (this.state.budgets.acceptedMutations > before.accepted) reasons.push("action_accepted");
    if (this.state.budgets.acceptedInspections > before.inspections) reasons.push("inspection_accepted");
    if (!failedRun && this.state.budgets.advancedSimSeconds > before.advanced) reasons.push("sim_time_advanced");
    if (eligibilityChanged) reasons.push("eligible_actions_changed");
    try {
      const cursorBefore = this.state.progressCursor;
      const events = await this.options.client.getEvents(this.state.gameId, cursorBefore);
      this.state.progressCursor = Math.max(cursorBefore, events.nextCursor);
      // Only events newer than the cursor count: a replayed or unchanged warning must not keep resetting the counter.
      const kinds = new Set(events.events.filter((e) => e.eventId > cursorBefore).map((e) => e.kind));
      for (const kind of ["action_completed", "action_failed", "observation_delivered", "field_attention"] as const) if (kinds.has(kind)) reasons.push(kind);
    } catch {
      /* no evidence available: not counted as progress */
    }
    return { progress: reasons.length > 0, reasons };
  }

  /**
   * A review interval is one waiting decision, however many server checkpoints it was split into. Every applied
   * checkpoint was counted when it settled, so only the extra ones are given back here; maxAdvanceRequests and the
   * simulated-time budget still bound the real number of server advances.
   */
  private async recordInterval(r: IntervalResult): Promise<void> {
    this.state.waits.push({ cycle: this.state.cycle, actionId: "checkpoint-interval", trigger: "model_tool", outcome: r.outcome, actionStatus: null, advanceRequests: r.advanceRequests, advancedSeconds: r.advancedSeconds, simTimeStartS: r.simTimeStartS, simTimeEndS: r.simTimeEndS, events: r.events, detail: r.detail });
    await this.save();
  }

  /** Advances one bounded server-authoritative checkpoint without a model call while waiting for the planned review. */
  private async advanceWaitingCheckpoint(): Promise<boolean> {
    const s = this.state;
    const l = s.config.limits;
    const b = s.budgets;
    const target = s.waitingUntilSimTimeS;
    if (target === null) {
      this.setLifecycle("running");
      await this.save();
      return true;
    }

    const { clock } = await this.options.client.getFarmOverview(s.gameId);
    s.lastSimTimeS = clock.simTimeS;
    if (clock.simTimeS >= target) {
      s.waitingUntilSimTimeS = null;
      this.setLifecycle("running");
      await this.save();
      return true;
    }

    const horizon = Math.min(target - clock.simTimeS, remainingSimFor(s));
    if (horizon <= 0) {
      const exhausted = this.budgetStop(true);
      await this.end("paused", exhausted?.reason ?? "sim_time_limit_reached", exhausted?.detail ?? "No simulated-time authorization remains.");
      return false;
    }
    // Accelerated, server-authoritative wait: every tick is still simulated by the server (in per-call-capped requests), so
    // pests, weather, costs and operations are fully preserved. Many checkpoints run inside ONE slice with no model call;
    // the loop stops on any simulator event, the target, a real-time slice bound, or a failure.
    const waitStartedAt = Date.now();
    let advancedAny = false;
    const result = await superviseInterval(
      {
        client: this.options.client,
        gameId: s.gameId,
        journal: this.journal,
        newMutationId: this.options.newMutationId ?? (() => randomUUID()),
        retryDelayMs: this.options.retryDelayMs ?? 400,
        maxMutationRetries: 2,
        budget: {
          requestsLeft: s.config.autonomyMode === "continuous" ? Number.MAX_SAFE_INTEGER : advanceRequestsLeftFor(s),
          simSecondsLeft: remainingSimFor(s),
          maxChunkSeconds: l.maxAdvanceSecondsPerCall,
          maxCallSeconds: l.maxAdvanceSecondsPerCall,
          conflictsLeft: Math.max(0, l.maxConflicts - b.conflicts),
        },
        getCursor: () => s.modelEventCursor,
        setCursor: (cursor) => { s.modelEventCursor = Math.max(s.modelEventCursor, cursor); },
        onAdvanced: () => { advancedAny = true; },
        checkpointReview: () => reviewAtCheckpoint(this.options.client, s.gameId, s),
        ...(this.schedulerOn() ? { wakes: (e: GameEvent) => requiresDecision(e) || e.kind === "observation_delivered" } : {}),
        shouldStop: () => {
          if (s.config.autonomyMode !== "continuous" && this.wallBase + (Date.now() - this.startedAt) >= l.maxWallClockMs) return "wall clock budget";
          if (this.farmSpendExceeded()) return "farm spending limit";
          if (this.options.signal?.aborted) return "worker stopping";
          // Always complete at least one checkpoint per slice so a slice can never spin without advancing time.
          if (advancedAny && Date.now() - waitStartedAt >= (this.options.waitSliceMs ?? ACCELERATED_WAIT_SLICE_MS)) return SLICE_TIME_BOUND;
          return null;
        },
        record: (event, data) => this.log(`${event} ${JSON.stringify(data).slice(0, 160)}`),
      },
      { maxSeconds: horizon, checkpointSeconds: Math.min(l.maxAdvanceSecondsPerCall, horizon) },
    );
    if (result.simTimeEndS !== null) s.lastSimTimeS = result.simTimeEndS;
    // Continuous sessions keep the ineffective-decision streak across supervised waits so its backoff keeps escalating.
    if (result.advancedSeconds > 0 && s.config.autonomyMode !== "continuous") s.budgets.consecutiveNoProgress = 0;
    s.waits.push({ cycle: s.cycle, actionId: "planned-review", trigger: "controller", outcome: result.outcome, actionStatus: null, advanceRequests: result.advanceRequests, advancedSeconds: result.advancedSeconds, simTimeStartS: result.simTimeStartS, simTimeEndS: result.simTimeEndS, events: result.events, detail: result.detail });
    if (s.waits.length > 200) s.waits.splice(0, s.waits.length - 200);
    await this.save();

    const reachedTarget = s.lastSimTimeS !== null && s.lastSimTimeS >= target;
    if (result.outcome === "event_interrupt" || reachedTarget) {
      s.waitingUntilSimTimeS = null;
      s.recoveryAttempts = 0;
      s.retryAfter = null;
      this.setLifecycle("running");
      await this.save();
      return true;
    }
    const budget = this.budgetStop(true);
    if (budget) {
      await this.end("paused", budget.reason, budget.detail);
      return false;
    }
    const sliceBound = result.outcome === "aborted" && result.detail === SLICE_TIME_BOUND;
    if (result.outcome === "horizon_reached" || sliceBound) {
      if (result.advancedSeconds > 0) {
        s.recoveryAttempts = 0;
        s.retryAfter = null;
      }
      this.setLifecycle("waiting_for_simulation");
      await this.end("paused", "waiting_for_simulation", `Advanced ${result.advancedSeconds}s of server time in ${result.checkpoints} checkpoint(s) toward the planned review; no model call was needed.`);
      return false;
    }
    if (result.outcome === "refused") {
      await this.end("paused", "simulation_wait_refused", `The simulator refused a time advance (${result.detail ?? "refused"}); this is deterministic and needs intervention.`);
      return false;
    }
    if (result.outcome === "aborted" && result.detail === "worker stopping") {
      await this.end("paused", "slice_complete", "The worker is shutting down; the next slice resumes the wait.");
      return false;
    }
    await this.transientRecovery("simulation_wait_interrupted", result.detail ?? result.outcome);
    return false;
  }

  private async recordWait(wait: WaitResult, trigger: WaitRecord["trigger"]): Promise<void> {
    this.state.waits.push({ cycle: this.state.cycle, actionId: wait.actionId, trigger, outcome: wait.outcome, actionStatus: wait.actionStatus, advanceRequests: wait.advanceRequests, advancedSeconds: wait.advancedSeconds, simTimeStartS: wait.simTimeStartS, simTimeEndS: wait.simTimeEndS, events: wait.events, detail: wait.detail });
    const action = this.state.actions.find((candidate) => candidate.actionId === wait.actionId);
    if (action && wait.actionStatus !== null) {
      // Terminal via a wait: mark for one final fetch, because the wait record has no water/seed/fuel consumption.
      if (TERMINAL_ACTION_STATUSES.has(wait.actionStatus) && !TERMINAL_ACTION_STATUSES.has(action.status)) action.lastCheckedAt = null;
      action.status = wait.actionStatus;
    }
    if (action && wait.progress !== null) action.progress = wait.progress;
    if (action && wait.estimatedCompletionS !== null) action.estimatedCompletionS = wait.estimatedCompletionS;
    if (action && wait.finishedAtS !== null) action.finishedAtS = wait.finishedAtS;
    if (action && wait.consumedCredits !== null) action.consumedCredits = wait.consumedCredits;
    if (action && wait.outcomeSummary !== null) action.outcome = wait.outcomeSummary;
    if (action && wait.failure !== null) action.failure = wait.failure;
    await this.save();
  }

  /**
   * Mechanical waiting for ONE already-authorized operation (server time only). It never chooses a farm action.
   * Returns true when the awaited operation reached a terminal state.
   */
  private async autoWait(): Promise<boolean> {
    const s = this.state;
    if (!this.mutationsEnabled || !s.config.autoWait) return false;
    const target = s.actions.find((a) => !TERMINAL_ACTION_STATUSES.has(a.status));
    if (!target || this.budgetStop(true)) return false;
    const l = s.config.limits;
    const b = s.budgets;
    const wait = await superviseOperation(
      {
        client: this.options.client,
        gameId: s.gameId,
        journal: this.journal,
        newMutationId: this.options.newMutationId ?? (() => randomUUID()),
        retryDelayMs: this.options.retryDelayMs ?? 400,
        maxMutationRetries: 2,
        budget: {
          requestsLeft: s.config.autonomyMode === "continuous" ? advanceRequestsLeftFor(s) : Math.max(0, Math.min(l.maxAdvanceRequests - b.advanceRequests, l.maxConsecutiveAdvances - b.consecutiveAdvances)),
          simSecondsLeft: remainingSimFor(s),
          maxChunkSeconds: l.maxWaitChunkSeconds,
          maxCallSeconds: l.maxAdvanceSecondsPerCall,
          conflictsLeft: Math.max(0, l.maxConflicts - b.conflicts),
        },
        getCursor: () => s.modelEventCursor,
        setCursor: (cursor) => {
          s.modelEventCursor = Math.max(s.modelEventCursor, cursor);
        },
        onAdvanced: () => undefined,
        shouldStop: () => (s.config.autonomyMode !== "continuous" && this.wallBase + (Date.now() - this.startedAt) >= l.maxWallClockMs ? "wall clock budget" : this.farmSpendExceeded() ? "farm spending limit" : null),
        record: (event, data) => this.log(`${event} ${JSON.stringify(data).slice(0, 160)}`),
      },
      { actionId: target.actionId },
    );
    await this.recordWait(wait, "controller");
    this.log(`auto-wait ${wait.actionId}: ${wait.outcome} (${wait.advanceRequests} advance request(s), ${wait.advancedSeconds}s)`);
    return wait.outcome === "completed" || wait.outcome === "failed" || wait.outcome === "cancelled";
  }

  /**
   * Supervises in-flight operations and submits queued operations as they become ready, with no model call. Each round
   * submits what the plan allows (one operation per field), then waits for one operation to finish. Bounded.
   * Returns true when any supervised operation reached a terminal state.
   */
  private async superviseAndDrain(): Promise<boolean> {
    const s = this.state;
    let progressed = await this.autoWait();
    if (!this.mutationsEnabled) return progressed;
    for (let round = 0; round < 8; round += 1) {
      reconcileQueue(s.queue, s.actions, s.operations, s.lastSimTimeS ?? 0);
      if (s.pendingMutation || !s.queue.some((i) => isActiveQueueStatus(i.status))) break;
      const drained = await drainQueue({
        client: this.options.client,
        gameId: s.gameId,
        state: s,
        journal: this.journal,
        newMutationId: this.options.newMutationId ?? (() => randomUUID()),
        retryDelayMs: this.options.retryDelayMs ?? 400,
        maxMutationRetries: 2,
        trace: { record: (event, data) => this.log(`${event} ${JSON.stringify(data ?? {}).slice(0, 160)}`) },
        maySubmit: () => !s.pendingMutation && this.budgetStop(true) === null && (s.config.autonomyMode === "continuous" || s.budgets.acceptedMutations < s.config.limits.maxMutations),
        onOutcomeUnknown: () => undefined,
      });
      if (drained.submitted + drained.staled + drained.failed > 0) {
        this.log(`queue: ${drained.submitted} submitted, ${drained.staled} stale, ${drained.failed} failed`);
        progressed = progressed || drained.submitted > 0;
      }
      await this.save();
      if (drained.locked) break;
      const waited = await this.autoWait();
      progressed = progressed || waited;
      if (drained.submitted === 0 && !waited) break;
    }
    reconcileQueue(s.queue, s.actions, s.operations, s.lastSimTimeS ?? 0);
    pruneQueue(s.queue);
    await this.save();
    return progressed;
  }
  private farmSpendExceeded(): boolean {
    // Cumulative farm spending is only a quota for legacy sessions; continuous sessions rely on server-side affordability checks.
    if (this.state.config.autonomyMode === "continuous") return false;
    const spent = this.farmSpend();
    return spent !== null && spent >= this.state.config.limits.maxFarmSpendCredits;
  }

  private noteSummary(summary: ObservationSummary): void {
    const metrics = this.state.metrics;
    const previous = metrics.latest;
    metrics.latest = summary;
    const entry = previous ? ledgerEntry(previous, summary, this.state.actions) : null;
    if (entry) {
      metrics.ledger.push(entry);
      if (metrics.ledger.length > 60) metrics.ledger.splice(0, metrics.ledger.length - 60);
    }
    for (const r of summary.resources) if (r.kind === "grain") metrics.grainPeakKg[r.id] = Math.max(metrics.grainPeakKg[r.id] ?? 0, r.quantity);
  }

  /** Best-effort final read so the report has the true end state; failures leave the previous (real) values. */
  private async finalize(): Promise<void> {
    try {
      await this.refreshActions();
      const snapshot = await this.provider.get();
      this.state.lastRevision = snapshot.revision;
      this.state.lastSimTimeS = snapshot.simTimeS;
      this.noteSummary(summarizeSnapshot(snapshot));
    } catch {
      /* keep last known */
    }
    await this.save();
  }

  async run(): Promise<SessionState> {
    await this.open();
    try {
      const final = await this.loop();
      await this.finalize();
      return final;
    } catch (error) {
      if (error instanceof SessionLockLostError) throw error;
      try {
        if (isTransientControllerError(error)) return await this.transientRecovery("consecutive_errors", error instanceof Error ? error.message : null);
        return await this.end("paused", "controller_error", error instanceof Error ? error.message.slice(0, 300) : "unknown");
      } catch {
        throw error;
      }
    } finally {
      await this.lock.release();
    }
  }

  /** The daily scheduler applies to continuous sessions that can act; legacy and observe-only sessions are unchanged. */
  private schedulerOn(): boolean {
    const s = this.state;
    return s.config.autonomyMode === "continuous" && this.mutationsEnabled && s.scheduler.config.enabled;
  }

  /** Picks up ledger-driven wakes that an accelerated wait already consumed, so the gate still sees them. */
  private noteInterrupt(detail: string | null, simTimeS: number | null): void {
    const sch = this.state.scheduler.state;
    const match = detail?.match(/^review_due: (.*)$/);
    if (!match?.[1] || simTimeS === null) return;
    const today = dayOf(simTimeS, this.state.scheduler.config);
    for (const part of match[1].split(", ")) {
      const [field, reason] = part.split(" ");
      if (field && reason) addTrigger(sch, { key: `ledger:${field}:${reason}:${today}`, kind: reason, critical: false, field, simTimeS, summary: `${reason.replace(/_/g, " ")} for ${field}`.slice(0, 200) });
    }
  }

  private pushTimeline(kind: "review_skipped" | "blocked", summary: string, triggers: string[] = []): void {
    const s = this.state;
    s.decisions.push({ cycle: s.cycle, at: new Date().toISOString(), simTimeS: s.lastSimTimeS, revision: s.lastRevision, summary: summary.slice(0, 600), plannedStep: null, tools: {}, actionsSubmitted: 0, actionsAccepted: 0, advancedSeconds: 0, progress: false, progressReasons: [], costUsd: 0, stopReason: kind, kind, day: s.scheduler.state.day, triggers, inspectionsDone: 0 });
    if (s.decisions.length > 300) s.decisions.splice(0, s.decisions.length - 300);
  }

  /**
   * Decides, without any model call, whether this iteration runs a bounded review or advances simulated time. Returns
   * "wait" after arranging an accelerated wait to the next day boundary (or planned review), which always lies strictly
   * in the future, so the loop cannot spin. Routine ticks, informational events and in-flight operations never review.
   */
  private async scheduleGate(): Promise<"review" | "wait"> {
    const s = this.state;
    const sch = s.scheduler.state;
    const cfg = s.scheduler.config;
    const snapshot = await this.provider.get();
    s.lastRevision = snapshot.revision;
    s.lastSimTimeS = snapshot.simTimeS;
    if (!sch.initialized) {
      sch.initialized = true;
      sch.eventCursor = s.modelEventCursor;
    }
    const feed = await this.options.client.getEvents(s.gameId, sch.eventCursor);
    sch.eventCursor = Math.max(sch.eventCursor, feed.nextCursor);
    const ctx = { actionType: (id: string) => s.actions.find((a) => a.actionId === id)?.type ?? null };
    let observed = false;
    for (const event of feed.events) {
      const trigger = classifyTrigger(event, ctx);
      if (trigger) addTrigger(sch, trigger);
      if (isObservationEvent(event, ctx)) observed = true;
    }
    refreshLedger(s, snapshot.fields);
    const changed = absorbObservations(sch, snapshot.fields);
    if (observed && changed.length > 0) {
      addTrigger(sch, { key: `obs:${changed.join(",")}:${Math.floor(snapshot.simTimeS)}`, kind: "new_observation", critical: false, field: changed[0] ?? null, simTimeS: snapshot.simTimeS, summary: `New authorized observation for ${changed.join(", ")}.` });
    } else if (observed) {
      this.log("scheduler: observation delivered with no new information; no review");
    }
    const today = dayOf(snapshot.simTimeS, cfg);
    for (const due of dueReviews(s, snapshot.simTimeS)) {
      addTrigger(sch, { key: `ledger:${due.fieldId}:${due.reason}:${today}`, kind: due.reason, critical: false, field: due.fieldId, simTimeS: snapshot.simTimeS, summary: `${due.reason.replace(/_/g, " ")} for ${due.fieldId}`.slice(0, 200) });
    }

    const arrange = async (target: number): Promise<"wait"> => {
      s.waitingUntilSimTimeS = Math.min(target, snapshot.simTimeS + Math.max(remainingSimFor(s), 0));
      sch.nextReviewSimS = s.waitingUntilSimTimeS;
      sch.status = "waiting";
      this.setLifecycle("waiting_for_simulation");
      await this.save();
      return "wait";
    };

    const inFlight = s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status)) || snapshot.overview.status.activeActionCount > 0;
    const eligible = snapshot.actions.actions.some((a) => a.eligibility.eligible);
    const idle = !eligible && !inFlight && sch.pending.length === 0 && sch.unresolvedCritical.length === 0;
    if (idle) {
      rollDay(sch, cfg, snapshot.simTimeS);
      if (sch.lastSkipDay !== today) {
        sch.lastSkipDay = today;
        this.pushTimeline("review_skipped", "Review skipped: no action is currently eligible and nothing needs a decision; simulated time advances to the next day.");
        sch.counters.skippedReviews += 1;
      }
      return arrange(nextDayBoundary(snapshot.simTimeS, cfg));
    }

    const d = decide(sch, cfg, { simTimeS: snapshot.simTimeS, plannedReviewSimS: s.plan?.nextReviewSimSeconds ?? null });
    if (d.kind === "review") {
      beginReview(sch, d, snapshot.simTimeS, cfg);
      return "review";
    }
    if (d.kind === "skip") {
      if (d.waitUntilSimS > sch.skipUntilS) {
        sch.skipUntilS = d.waitUntilSimS;
        sch.counters.skippedReviews += 1;
        sch.lastSkipDay = sch.day;
        this.pushTimeline("review_skipped", `Review skipped — no action needed: ${d.reason}`);
      }
      return arrange(d.waitUntilSimS);
    }
    if (d.blocked.length > 0) {
      const names = d.blocked.map((t) => `${t.kind}${t.field ? ` (${t.field})` : ""}`).join(", ");
      this.pushTimeline("blocked", `Event-review budget for day ${sch.day} (${cfg.eventReviewsPerDay}) is exhausted. Critical items carried to the next review, not dropped: ${names}.`, d.blocked.map((t) => t.kind));
      this.log(`scheduler: event-review budget exhausted; critical unresolved: ${names}`);
    }
    return arrange(d.waitUntilSimS);
  }

  private async loop(): Promise<SessionState> {
    const s = this.state;
    s.status = "running";
    if (s.lifecycle !== "waiting_for_simulation") this.setLifecycle("running");
    s.stopReason = null;
    s.stopDetail = null;
    await this.save();
    let cyclesThisRun = 0;

    for (;;) {
      if (!(await this.reconcile())) return await this.end("paused", "unresolved_mutation", "The outcome of a state-changing request could not be confirmed; resume to retry the same idempotency key.");
      if (s.pendingModelCycle !== null) {
        return await this.end(
          "failed",
          "model_request_outcome_unknown",
          `The worker restarted during model cycle ${s.pendingModelCycle}. The request may have been billed, so it was not replayed. Review provider usage and start a new authorized session if needed.`,
        );
      }
      const stop = this.budgetStop();
      if (stop) {
        if (stop.reason === "zero_time_advance_limit" && s.config.autonomyMode === "continuous") return await this.zeroTimeRecovery(stop.detail);
        if (stop.reason === "allocation_complete") return await this.end("paused", "allocation_complete", stop.detail);
        return await this.end(this.isBudgetReason(stop.reason) ? "paused" : "stopped", stop.reason, stop.detail);
      }
      if (s.lifecycle === "waiting_for_simulation" && s.waitingUntilSimTimeS !== null) {
        const finishedWaiting = await this.advanceWaitingCheckpoint();
        if (!finishedWaiting) return s;
        if (this.schedulerOn()) {
          const last = s.waits[s.waits.length - 1];
          if (last?.trigger === "controller" && last.outcome === "event_interrupt") this.noteInterrupt(last.detail, last.simTimeEndS);
        }
      }
      await this.refreshActions();
      // Planned operations that became ready (a new simulated day, a finished predecessor, a restart) run before any model call.
      if (!s.pendingMutation && s.queue.some((i) => isActiveQueueStatus(i.status)) && (await this.superviseAndDrain())) s.budgets.consecutiveNoProgress = 0;
      if (s.pendingMutation) continue;

      const scheduled = this.schedulerOn();
      if (scheduled && (await this.scheduleGate()) === "wait") {
        // Idle days are crossed without a model call, so no cycle or wait bound would ever end this slice on its own.
        if (Date.now() - this.startedAt >= (this.options.waitSliceMs ?? ACCELERATED_WAIT_SLICE_MS)) {
          return await this.end("paused", "waiting_for_simulation", "The worker slice time bound was reached while waiting for the next review; the next slice continues with no model call.");
        }
        continue;
      }
      const schedCfg = s.scheduler.config;
      const modelCap = scheduled ? Math.min(s.config.limits.maxModelCallsPerCycle, schedCfg.maxModelCallsPerReview) : s.config.limits.maxModelCallsPerCycle;
      const toolCap = scheduled ? Math.min(s.config.limits.maxToolCallsPerCycle, schedCfg.maxToolCallsPerReview) : s.config.limits.maxToolCallsPerCycle;
      const reviewMeta = scheduled && s.scheduler.state.current ? { kind: s.scheduler.state.current.kind, day: s.scheduler.state.current.day, triggers: s.scheduler.state.current.triggers.map((t) => t.kind) } : null;

      s.cycle += 1;
      s.allocationCycles += 1;
      cyclesThisRun += 1;
      this.log(`cycle ${s.cycle}`);
      const sink: PlanSink = { latest: null, updates: 0 };
      let result: Awaited<ReturnType<typeof runAgent>>;
      const before = { accepted: s.budgets.acceptedMutations, rejected: s.budgets.rejectedActions, advanced: s.budgets.advancedSimSeconds, cost: s.budgets.costUsd, inspections: s.budgets.acceptedInspections };
      let eligibilityChanged = false;
      let lifetimeChargedBase = 0;

      try {
        const snapshot = await this.provider.get();
        s.lastRevision = snapshot.revision;
        s.lastSimTimeS = snapshot.simTimeS;
        const summary = summarizeSnapshot(snapshot);
        s.metrics.baseline ??= summary;
        this.noteSummary(summary);
        if (s.config.scenario.startObservationSha256 === null && s.metrics.baseline === summary) {
          s.config.scenario.startObservationSha256 = createHash("sha256").update(JSON.stringify({ overview: snapshot.overview, fields: snapshot.fields, actions: snapshot.actions })).digest("hex");
          s.config.scenario.startRevision = snapshot.revision;
          s.config.scenario.startSimTimeS = snapshot.simTimeS;
        }
        const eventsResponse = await this.options.client.getEvents(s.gameId, s.modelEventCursor);
        const events: GameEvent[] = eventsResponse.events;

        const eligible = snapshot.actions.actions.some((a) => a.eligibility.eligible);
        const signature = snapshot.actions.actions.filter((a) => a.eligibility.eligible).map((a) => a.type).sort().join(",");
        eligibilityChanged = this.lastEligibility !== null && this.lastEligibility !== signature;
        this.lastEligibility = signature;
        const inFlight = s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status)) || snapshot.overview.status.activeActionCount > 0;
        if (!eligible && !inFlight && !scheduled) {
          if (s.config.autonomyMode === "continuous" && this.mutationsEnabled && remainingSimFor(this.state) > 0) {
            s.waitingUntilSimTimeS = snapshot.simTimeS + Math.min(s.config.limits.maxAdvanceSecondsPerCall * 2, remainingSimFor(this.state));
            await this.save();
            return await this.end("paused", "waiting_for_simulation", "No action is currently eligible; server time advances in accelerated checkpoints (no model call) until something changes.");
          }
          if (s.config.autonomyMode === "legacy") return await this.end("completed", "no_eligible_actions", "The simulator offers no eligible action and no operation is in flight.");
        }

        const l = s.config.limits;
        const b = s.budgets;
        const cont = s.config.autonomyMode === "continuous";
        // Continuous sessions bound each cycle (not the session's lifetime); cumulative counters are observability only.
        const perCycleActions = toolCap;
        const remainingMutations = this.mutationsEnabled ? (cont ? perCycleActions : Math.max(0, l.maxMutations - b.acceptedMutations)) : 0;
        const remainingInspections = this.mutationsEnabled ? (cont ? perCycleActions : Math.max(0, l.maxInspections - b.acceptedInspections)) : 0;
        const remainingSim = cont ? l.maxAdvanceSecondsPerCall * toolCap : Math.max(0, l.maxSimSeconds - b.advancedSimSeconds);
        const deadlineMs = cont ? Date.now() + l.maxWallClockMs : this.startedAt + (l.maxWallClockMs - this.wallBase);
        const costLeftUsd = cont && l.unlimitedSpending ? Number.MAX_SAFE_INTEGER : Math.max(0, l.maxCostUsd - b.costUsd);
        const review: ReviewTracker = { unread: new Map() };
        const tools = createAutonomousTools(this.provider, sink, this.mutationsEnabled ? {
          maxChunkSeconds: l.maxWaitChunkSeconds,
          conflictsLeft: () => Math.max(0, l.maxConflicts - s.budgets.conflicts),
          onConflict: () => undefined,
          finished: (wait) => this.recordWait(wait, "model_tool"),
          finishedInterval: (r) => this.recordInterval(r),
          intervalRequestsLeft: () => advanceRequestsLeftFor(s),
        } : undefined, { state: s, recentEvents: events }, scheduled ? { state: s.scheduler.state, config: schedCfg, simTimeS: snapshot.simTimeS, inFlight: (key: string) => s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status) && inspectionKey(a.type, a.params) === key) } : undefined, review);

        // The brief carries this exact snapshot, so observe_snapshot must not resend it until something changes.
        this.provider.delivered = { revision: snapshot.revision, simTimeS: snapshot.simTimeS };
        refreshLedger(s, snapshot.fields);
        const briefInput = { state: s, snapshot, events, progress: buildProgress(s), economics: buildEconomics(s) };
        const briefSizeEstimate = measureCycleBrief(briefInput);
        this.log(`cycle ${s.cycle} prompt estimate ${JSON.stringify({ cycle: s.cycle, source: "estimated", charsPerTokenHeuristic: 4, totalEstimatedTokens: briefSizeEstimate.totalEstimatedTokens, systemPromptEstimatedTokens: briefSizeEstimate.systemPromptEstimatedTokens, sections: Object.fromEntries(briefSizeEstimate.sections.map((sec) => [sec.section, sec.estimatedTokens])) })}`);
        const cycleModelCalls = cont ? modelCap : Math.max(1, Math.min(modelCap, l.maxModelCalls - b.modelCalls - b.failedModelCalls));
        // The lifetime cap (if any) bounds this cycle's calls and is charged and persisted before the first request is sent.
        const lifetimeLeft = this.lifetimeCallsLeft();
        const maxCallsThisCycle = lifetimeLeft === null ? cycleModelCalls : Math.min(cycleModelCalls, lifetimeLeft);
        if (lifetimeLeft !== null) {
          lifetimeChargedBase = this.lifetimeCallsUsed();
          b.lifetimeModelCallsCharged = lifetimeChargedBase + maxCallsThisCycle;
        }
        s.pendingModelCycle = s.cycle;
        await this.save();
        result = await runAgent({
          provider: this.options.provider,
          client: this.options.client,
          gameId: s.gameId,
          mode: this.mutationsEnabled ? "controlled_mutation" : "observe_only",
          tools,
          systemPrompt: scheduled ? AUTONOMOUS_SYSTEM_PROMPT + DAILY_REVIEW_PROMPT_ADDENDUM : AUTONOMOUS_SYSTEM_PROMPT,
          brief: cycleBrief(briefInput),
          cycle: s.cycle,
          runId: `${s.sessionId}-c${s.cycle}`,
          traceDirectory: this.options.traceDirectory === undefined ? (this.options.store.traceDirectory?.(s.sessionId) ?? null) : this.options.traceDirectory,
          initialState: { observedRevision: snapshot.revision, eventCursor: eventsResponse.nextCursor },
          journal: this.journal,
          beforeFinal: () => unreadInspectionNudge(review),
          deadlineMs,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          retryDelayMs: this.options.retryDelayMs ?? 400,
          ...(this.options.newMutationId ? { newMutationId: this.options.newMutationId } : {}),
          limits: {
            maxModelCalls: maxCallsThisCycle,
            maxTotalToolCalls: cont ? toolCap : Math.max(1, Math.min(toolCap, l.maxToolCalls - b.toolCalls)),
            maxToolCallsPerStep: 4,
            maxOutputTokens: l.maxOutputTokens,
            maxCostPerRequestUsd: l.maxCostPerRequestUsd,
            maxCostUsd: costLeftUsd,
            maxAdvanceSecondsPerCall: Math.min(l.maxAdvanceSecondsPerCall, remainingSim),
            maxTotalAdvanceSeconds: remainingSim,
            maxMutations: remainingMutations,
            maxAdvanceRequests: cont ? Math.max(0, Math.min(perCycleActions, l.maxConsecutiveAdvances - b.consecutiveAdvances)) : Math.max(0, Math.min(l.maxAdvanceRequests - b.advanceRequests, l.maxConsecutiveAdvances - b.consecutiveAdvances)),
            maxWaitChunkSeconds: l.maxWaitChunkSeconds,
            maxMutationAttempts: remainingMutations + Math.max(0, l.maxConsecutiveRejections - b.consecutiveRejections),
            maxInspections: remainingInspections,
            maxInspectionAttempts: remainingInspections + Math.max(0, l.maxConsecutiveRejections - b.consecutiveRejections),
          },
        });
        s.modelEventCursor = Math.max(eventsResponse.nextCursor, result.state.eventCursor);
      } catch (error) {
        if (error instanceof SessionLockLostError) throw error;
        if (s.pendingModelCycle !== null) {
          return await this.end("failed", "model_request_outcome_unknown", `The worker lost the outcome of model cycle ${s.pendingModelCycle}; it will not replay a potentially billed request.`);
        }
        if (isAuthFailure(error)) return await this.end("paused", "authentication_failure", "The simulator rejected the agent credentials (401/403).");
        if (error instanceof InconsistentObservationError) return await this.end("paused", "inconsistent_observation", error.message);
        s.budgets.consecutiveErrors += 1;
        this.log(`cycle error: ${error instanceof Error ? error.message : "unknown"}`);
        if (!isTransientControllerError(error) && s.budgets.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) {
          return await this.end("paused", "controller_error", `${error instanceof Error ? error.message.slice(0, 300) : "unknown"} (deterministic controller fault; intervention required)`);
        }
        if (s.budgets.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) return await this.transientRecovery("consecutive_errors", error instanceof Error ? error.message : null);
        await this.save();
        continue;
      }

      const b = s.budgets;
      b.costUsd += result.totals.estimatedCostUsd;
      b.modelCalls += result.totals.modelCalls;
      b.toolCalls += result.totals.toolCalls;
      b.failedModelCalls += result.totals.failedModelCalls;
      // Replace the cycle's worst-case reservation with what was actually used.
      if (s.config.limits.maxLifetimeModelCalls !== null) b.lifetimeModelCallsCharged = lifetimeChargedBase + result.totals.modelCalls + result.totals.failedModelCalls;
      b.modelRetryAttempts += result.totals.modelRetryAttempts;
      s.usage.inputTokens += result.totals.inputTokens;
      s.usage.outputTokens += result.totals.outputTokens;
      s.usage.cachedTokens += result.totals.cachedTokens;
      s.pendingModelCycle = null;
      await this.save();
      // Real provider-reported usage for this cycle (as opposed to the pre-call estimate logged above).
      this.log(`cycle ${s.cycle} usage ${JSON.stringify({ cycle: s.cycle, source: "provider", modelCalls: result.totals.modelCalls, failedModelCalls: result.totals.failedModelCalls, modelRetryAttempts: result.totals.modelRetryAttempts, inputTokens: result.totals.inputTokens, outputTokens: result.totals.outputTokens, cachedTokens: result.totals.cachedTokens, estimatedCostUsd: Math.round(result.totals.estimatedCostUsd * 1e6) / 1e6 })}`);
      if (sink.latest) s.plan = sink.latest;

      let waitedProgress = false;
      if (!s.pendingMutation) waitedProgress = await this.superviseAndDrain();
      await this.refreshActions();
      s.progress = buildProgress(s);
      const spendRefused = result.stopReason === "cost_limit" && result.totals.modelCalls === 0 && result.totals.failedModelCalls === 0;
      const failedRun = result.stopReason === "model_error" || result.stopReason === "empty_response";
      const { progress: eventProgress, reasons } = await this.evaluateProgress(before, failedRun, eligibilityChanged);
      const progress = eventProgress || waitedProgress;
      if (waitedProgress && !eventProgress) reasons.push("supervised_operation_finished");
      const toolCounts: Record<string, number> = {};
      for (const entry of result.trace.entries) if (entry.event === "tool.execute") toolCounts[String(entry.name)] = (toolCounts[String(entry.name)] ?? 0) + 1;
      const summaryText = sink.latest?.summary ?? (result.finalSummary ? `(model final text, no plan recorded) ${result.finalSummary}`.slice(0, 600) : `(no decision summary produced; run stopped: ${result.stopReason})`);
      s.decisions.push({
        cycle: s.cycle,
        at: new Date().toISOString(),
        simTimeS: s.lastSimTimeS,
        revision: s.lastRevision,
        summary: summaryText,
        plannedStep: sink.latest?.nextStep ?? null,
        tools: toolCounts,
        actionsSubmitted: b.acceptedMutations - before.accepted + (b.rejectedActions - before.rejected),
        actionsAccepted: b.acceptedMutations - before.accepted,
        advancedSeconds: b.advancedSimSeconds - before.advanced,
        progress,
        progressReasons: reasons,
        costUsd: Math.round((b.costUsd - before.cost) * 1e6) / 1e6,
        stopReason: result.stopReason,
        kind: reviewMeta?.kind ?? "cycle",
        day: reviewMeta?.day ?? null,
        triggers: reviewMeta?.triggers ?? [],
        inspectionsDone: b.acceptedInspections - before.inspections,
      });
      if (scheduled) endReview(s.scheduler.state, nextDayBoundary(s.lastSimTimeS ?? 0, schedCfg));

      const hadUnknown = s.pendingMutation !== null;
      b.consecutiveErrors = failedRun || hadUnknown ? b.consecutiveErrors + 1 : 0;
      if (!failedRun && !hadUnknown && b.consecutiveAdvances === 0 && b.consecutiveRejections === 0) {
        s.recoveryAttempts = 0;
        s.retryAfter = null;
      }
      b.consecutiveNoProgress = progress ? 0 : b.consecutiveNoProgress + 1;
      await this.save();

      if (result.error && /HTTP (401|403)/.test(result.error)) return this.end("paused", "authentication_failure", "The model API rejected the credentials (401/403).");
      if (spendRefused) {
        // The pre-flight guard refused to send a request whose worst-case cost could breach a spending limit. No request was
        // made, so this is neither a provider failure nor retryable: retrying cannot succeed until the cap changes.
        const capped = !(s.config.limits.unlimitedSpending);
        const remaining = Math.max(0, s.config.limits.maxCostUsd - b.costUsd);
        if (capped) return this.end("paused", "cost_budget_exhausted", `The optional API spending cap leaves $${remaining.toFixed(4)}, below the worst-case cost of the next model request (up to $${s.config.limits.maxCostPerRequestUsd.toFixed(4)} per request). No request was sent; raise the cap explicitly to continue.`);
        return this.end("paused", "model_configuration_error", `The per-request model cost limit refused the next request (limit $${s.config.limits.maxCostPerRequestUsd.toFixed(4)}); check MODEL_MAX_COST_PER_REQUEST_USD / MODEL_MAX_SESSION_COST_USD. No request was sent.`);
      }
      if (failedRun && classifyModelError(result.error) === "configuration" && b.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) {
        return this.end("paused", "model_configuration_error", `${result.error?.slice(0, 300) ?? "The model rejected the request"} (deterministic; intervention required)`);
      }
      if (s.pendingMutation) continue; // reconcile first; never act on top of an unknown outcome
      if (result.stopReason === "wall_clock_limit") {
        if (s.config.autonomyMode === "continuous") return this.end("paused", "slice_complete", "The per-cycle time bound was reached; the next slice continues the same session.");
        return this.end("paused", "wall_clock_exhausted", "The authorized cumulative wall-clock budget is exhausted; explicitly authorize more time to continue.");
      }
      if (sink.latest?.nextStep === "stop") return this.end("completed", "model_declared_done", sink.latest.stopReason);
      // A cycle whose model request failed produced no observation; it must not read as a finished observe-only session.
      if (!this.mutationsEnabled && (result.stopReason === "model_error" || result.stopReason === "empty_response")) return this.end("failed", "model_error", result.error ? result.error.slice(0, 300) : `The model produced no decision (${result.stopReason}).`);
      if (!this.mutationsEnabled) return this.end("completed", "observe_only_complete", "Mutations are disabled; one observation-and-planning cycle was run.");
      if (b.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) {
        const modelFailure = result.stopReason === "model_error" || result.stopReason === "empty_response";
        return this.transientRecovery("consecutive_errors", modelFailure && result.error ? result.error : null);
      }
      if (b.consecutiveRejections >= s.config.limits.maxConsecutiveRejections) {
        if (s.config.autonomyMode !== "continuous") return this.end("stopped", "repeated_rejections");
        // Domain rejections (unaffordable, unavailable, unmet preconditions) are ordinary agricultural feedback, not
        // technical failures: they never consume recoveryAttempts and can never end the session. The model sees each
        // structured rejection and re-observes; the rejection-only cycles make no progress, so the no-progress backoff
        // below paces further model calls. Infrastructure failures use the separate bounded-recovery path above.
        b.consecutiveRejections = 0;
      }
      if (s.config.autonomyMode !== "continuous" && b.consecutiveNoProgress >= s.config.limits.maxConsecutiveNoProgress) return this.end("stopped", "no_progress", describeNoProgress(s));
      if (
        !scheduled &&
        s.config.autonomyMode === "continuous" &&
        this.mutationsEnabled &&
        !s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status)) &&
        s.plan?.nextReviewSimSeconds !== null &&
        s.plan?.nextReviewSimSeconds !== undefined &&
        s.lastSimTimeS !== null &&
        s.plan.nextReviewSimSeconds > s.lastSimTimeS
      ) {
        s.waitingUntilSimTimeS = Math.min(s.plan.nextReviewSimSeconds, s.lastSimTimeS + remainingSimFor(s));
        if (s.waitingUntilSimTimeS > s.lastSimTimeS) {
          // A deliberate, plan-justified wait is the intended decision cadence, not an ineffective decision.
          b.consecutiveNoProgress = 0;
          await this.save();
          return this.end("paused", "waiting_for_simulation", "The next review is scheduled at the planned simulation checkpoint; no model calls are made before then unless a material event interrupts it.");
        }
      }
      // A completed daily/event review that chose to do nothing is a valid decision; the scheduler paces model calls, so the ineffective-decision backoff must not stack on top of it.
      if (this.schedulerOn()) b.consecutiveNoProgress = 0;
      if (s.config.autonomyMode === "continuous" && b.consecutiveNoProgress >= s.config.limits.maxConsecutiveNoProgress) return this.noProgressBackoff();
      const budget = this.budgetStop();
      if (budget) {
        if (budget.reason === "zero_time_advance_limit" && s.config.autonomyMode === "continuous") return this.zeroTimeRecovery(budget.detail);
        if (budget.reason === "allocation_complete") return this.end("paused", "allocation_complete", budget.detail);
        return this.end(this.isBudgetReason(budget.reason) ? "paused" : "stopped", budget.reason, budget.detail);
      }
      if (this.options.sliceCycles !== undefined && cyclesThisRun >= this.options.sliceCycles) return this.end("paused", "slice_complete", `${cyclesThisRun} cycle(s) run in this process; resume continues the same budgets.`);
    }
  }
}
