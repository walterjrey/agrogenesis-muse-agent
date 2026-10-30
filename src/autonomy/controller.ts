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
import { AUTONOMOUS_SYSTEM_PROMPT, DEFAULT_OBJECTIVE, cycleBrief } from "./prompt.js";
import { measureCycleBrief } from "./promptMetrics.js";
import { SessionLockLostError } from "./store.js";
import type { SessionBackend, SessionLease } from "./storage.js";
import { isInspectionActionType } from "./actionClassification.js";
import { buildProgress } from "./progress.js";
import { superviseOperation, type IntervalResult, type WaitResult } from "./supervisor.js";
import { createAutonomousTools, SnapshotProvider, type PlanSink } from "./tools.js";
import { DEFAULT_SESSION_LIMITS, PLANNING_POLICY_VERSION, TERMINAL_ACTION_STATUSES, type ObservationSummary, type PlanningConfig, type ScenarioManifest, type SessionLimits, type SessionState, type WaitRecord } from "./types.js";

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
}

const EMPTY_SCENARIO: ScenarioManifest = { name: null, seed: null, startSnapshotSha256: null, worldConfigSha256: null, startObservationSha256: null, startRevision: null, startSimTimeS: null, notes: [] };

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

export function newSessionState(options: NewSessionOptions): SessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: options.sessionId ?? `s-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`,
    gameId: options.gameId,
    createdAt: now,
    updatedAt: now,
    status: "paused",
    stopReason: "not_started",
    stopDetail: null,
    config: { modelId: options.modelId, mutationsEnabled: options.mutationsEnabled, objective: options.objective ?? DEFAULT_OBJECTIVE, limits: { ...DEFAULT_SESSION_LIMITS, ...options.limits }, autoWait: options.autoWait ?? true, planning: { policyVersion: PLANNING_POLICY_VERSION, horizonDays: null, ...options.planning }, scenario: { ...EMPTY_SCENARIO, ...options.scenario } },
    cycle: 0,
    plan: null,
    decisions: [],
    actions: [],
    operations: [],
    waits: [],
    progress: null,
    pendingMutation: null,
    lastRevision: null,
    lastSimTimeS: null,
    modelEventCursor: 0,
    progressCursor: 0,
    budgets: { costUsd: 0, modelCalls: 0, toolCalls: 0, acceptedMutations: 0, mutationAttempts: 0, rejectedActions: 0, acceptedInspections: 0, inspectionAttempts: 0, rejectedInspections: 0, advancedSimSeconds: 0, wallClockMs: 0, consecutiveErrors: 0, consecutiveNoProgress: 0,     consecutiveRejections: 0, advanceRequests: 0, consecutiveAdvances: 0, conflicts: 0, failedModelCalls: 0, modelRetryAttempts: 0 },
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

export class AutonomousController {
  private lock!: SessionLease;
  private state!: SessionState;
  private provider!: SnapshotProvider;
  private readonly startedAt = Date.now();
  private wallBase = 0;
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
    this.mutationsEnabled = this.state.config.mutationsEnabled && this.options.mutationsEnabled;
    this.provider = new SnapshotProvider(this.options.client, this.state.gameId, { retryDelayMs: this.options.retryDelayMs ?? 250 });
    this.wallBase = this.state.budgets.wallClockMs;
  }

  private log(message: string): void {
    this.options.onEvent?.(message);
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
    this.log(`session ${status}: ${reason}${detail ? ` (${detail})` : ""}`);
    await this.save();
    return this.state;
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
      b.advancedSimSeconds += Number(settlement.summary.grantedSeconds ?? 0);
      b.advanceRequests += 1;
      b.consecutiveAdvances += 1;
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

  /** forWait: waiting for an already-authorized operation spends no model/tool/cycle budget, so only the time, spending and conflict limits apply. */
  private budgetStop(forWait = false): { reason: string; detail: string } | null {
    const { budgets: b, config, cycle } = this.state;
    const l = config.limits;
    const wall = this.wallBase + (Date.now() - this.startedAt);
    if (!forWait && b.costUsd >= l.maxCostUsd) return { reason: "cost_budget_exhausted", detail: `$${b.costUsd.toFixed(4)} of $${l.maxCostUsd}` };
    if (!forWait && b.modelCalls >= l.maxModelCalls) return { reason: "model_call_budget_exhausted", detail: `${b.modelCalls}/${l.maxModelCalls}` };
    if (!forWait && b.toolCalls >= l.maxToolCalls) return { reason: "tool_call_budget_exhausted", detail: `${b.toolCalls}/${l.maxToolCalls}` };
    if (wall >= l.maxWallClockMs) return { reason: "wall_clock_exhausted", detail: `${Math.round(wall / 1000)}s of ${Math.round(l.maxWallClockMs / 1000)}s` };
    if (!forWait && cycle >= l.maxCycles) return { reason: "cycle_budget_exhausted", detail: `${cycle}/${l.maxCycles}` };
    if (b.conflicts >= l.maxConflicts) return { reason: "database_conflict_limit", detail: `${b.conflicts}/${l.maxConflicts} stale-revision conflicts` };
    if (this.mutationsEnabled) {
      if (b.advancedSimSeconds >= l.maxSimSeconds) return { reason: "sim_time_limit_reached", detail: `${b.advancedSimSeconds}/${l.maxSimSeconds} s` };
      if (b.advanceRequests >= l.maxAdvanceRequests) return { reason: "advance_request_budget_exhausted", detail: `${b.advanceRequests}/${l.maxAdvanceRequests}` };
      if (b.consecutiveAdvances >= l.maxConsecutiveAdvances) return { reason: "consecutive_advance_limit", detail: this.inactivityDetail() };
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
    for (const action of this.state.actions.filter((a) => !TERMINAL_ACTION_STATUSES.has(a.status))) {
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

  /** Progress = an accepted mutation, or a simulator event proving something completed/failed/delivered information. */
  private async evaluateProgress(acceptedBefore: number): Promise<{ progress: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (this.state.budgets.acceptedMutations > acceptedBefore) reasons.push("action_accepted");
    try {
      const events = await this.options.client.getEvents(this.state.gameId, this.state.progressCursor);
      this.state.progressCursor = Math.max(this.state.progressCursor, events.nextCursor);
      const kinds = new Set(events.events.map((e) => e.kind));
      for (const kind of ["action_completed", "action_failed", "observation_delivered"] as const) if (kinds.has(kind)) reasons.push(kind);
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
    const b = this.state.budgets;
    b.consecutiveAdvances = Math.max(0, b.consecutiveAdvances - Math.max(0, r.advanceRequests - 1));
    this.state.waits.push({ cycle: this.state.cycle, actionId: "checkpoint-interval", trigger: "model_tool", outcome: r.outcome, actionStatus: null, advanceRequests: r.advanceRequests, advancedSeconds: r.advancedSeconds, simTimeStartS: r.simTimeStartS, simTimeEndS: r.simTimeEndS, events: r.events, detail: r.detail });
    await this.save();
  }

  private async recordWait(wait: WaitResult, trigger: WaitRecord["trigger"]): Promise<void> {
    this.state.waits.push({ cycle: this.state.cycle, actionId: wait.actionId, trigger, outcome: wait.outcome, actionStatus: wait.actionStatus, advanceRequests: wait.advanceRequests, advancedSeconds: wait.advancedSeconds, simTimeStartS: wait.simTimeStartS, simTimeEndS: wait.simTimeEndS, events: wait.events, detail: wait.detail });
    const action = this.state.actions.find((candidate) => candidate.actionId === wait.actionId);
    if (action && wait.actionStatus !== null) action.status = wait.actionStatus;
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
          requestsLeft: Math.max(0, Math.min(l.maxAdvanceRequests - b.advanceRequests, l.maxConsecutiveAdvances - b.consecutiveAdvances)),
          simSecondsLeft: Math.max(0, l.maxSimSeconds - b.advancedSimSeconds),
          maxChunkSeconds: l.maxWaitChunkSeconds,
          maxCallSeconds: l.maxAdvanceSecondsPerCall,
          conflictsLeft: Math.max(0, l.maxConflicts - b.conflicts),
        },
        getCursor: () => s.modelEventCursor,
        setCursor: (cursor) => {
          s.modelEventCursor = Math.max(s.modelEventCursor, cursor);
        },
        onAdvanced: () => undefined,
        shouldStop: () => (this.wallBase + (Date.now() - this.startedAt) >= l.maxWallClockMs ? "wall clock budget" : this.farmSpendExceeded() ? "farm spending limit" : null),
        record: (event, data) => this.log(`${event} ${JSON.stringify(data).slice(0, 160)}`),
      },
      { actionId: target.actionId },
    );
    await this.recordWait(wait, "controller");
    this.log(`auto-wait ${wait.actionId}: ${wait.outcome} (${wait.advanceRequests} advance request(s), ${wait.advancedSeconds}s)`);
    return wait.outcome === "completed" || wait.outcome === "failed" || wait.outcome === "cancelled";
  }

  private farmSpendExceeded(): boolean {
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
        return await this.end("paused", "controller_error", error instanceof Error ? error.message.slice(0, 300) : "unknown");
      } catch {
        throw error;
      }
    } finally {
      await this.lock.release();
    }
  }

  private async loop(): Promise<SessionState> {
    const s = this.state;
    s.status = "running";
    s.stopReason = null;
    s.stopDetail = null;
    await this.save();
    let cyclesThisRun = 0;

    for (;;) {
      if (!(await this.reconcile())) return await this.end("paused", "unresolved_mutation", "The outcome of a state-changing request could not be confirmed; resume to retry the same idempotency key.");
      await this.refreshActions();
      const stop = this.budgetStop();
      if (stop) return await this.end("stopped", stop.reason, stop.detail);

      s.cycle += 1;
      cyclesThisRun += 1;
      this.log(`cycle ${s.cycle}`);
      const sink: PlanSink = { latest: null, updates: 0 };
      let result: Awaited<ReturnType<typeof runAgent>>;
      const before = { accepted: s.budgets.acceptedMutations, rejected: s.budgets.rejectedActions, advanced: s.budgets.advancedSimSeconds, cost: s.budgets.costUsd };

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
        const inFlight = s.actions.some((a) => !TERMINAL_ACTION_STATUSES.has(a.status)) || snapshot.overview.status.activeActionCount > 0;
        if (!eligible && !inFlight) return await this.end("completed", "no_eligible_actions", "The simulator offers no eligible action and no operation is in flight.");

        const l = s.config.limits;
        const b = s.budgets;
        const remainingMutations = this.mutationsEnabled ? Math.max(0, l.maxMutations - b.acceptedMutations) : 0;
        const remainingInspections = this.mutationsEnabled ? Math.max(0, l.maxInspections - b.acceptedInspections) : 0;
        const remainingSim = Math.max(0, l.maxSimSeconds - b.advancedSimSeconds);
        const deadlineMs = this.startedAt + (l.maxWallClockMs - this.wallBase);
        const tools = createAutonomousTools(this.provider, sink, this.mutationsEnabled ? {
          maxChunkSeconds: l.maxWaitChunkSeconds,
          conflictsLeft: () => Math.max(0, l.maxConflicts - s.budgets.conflicts),
          onConflict: () => undefined,
          finished: (wait) => this.recordWait(wait, "model_tool"),
          finishedInterval: (r) => this.recordInterval(r),
          intervalRequestsLeft: () => Math.max(0, l.maxAdvanceRequests - s.budgets.advanceRequests),
        } : undefined, { state: s, recentEvents: events });

        // The brief carries this exact snapshot, so observe_snapshot must not resend it until something changes.
        this.provider.delivered = { revision: snapshot.revision, simTimeS: snapshot.simTimeS };
        const briefInput = { state: s, snapshot, events, progress: buildProgress(s), economics: buildEconomics(s) };
        const briefSizeEstimate = measureCycleBrief(briefInput);
        this.log(`cycle ${s.cycle} prompt estimate ${JSON.stringify({ cycle: s.cycle, source: "estimated", charsPerTokenHeuristic: 4, totalEstimatedTokens: briefSizeEstimate.totalEstimatedTokens, systemPromptEstimatedTokens: briefSizeEstimate.systemPromptEstimatedTokens, sections: Object.fromEntries(briefSizeEstimate.sections.map((sec) => [sec.section, sec.estimatedTokens])) })}`);
        result = await runAgent({
          provider: this.options.provider,
          client: this.options.client,
          gameId: s.gameId,
          mode: this.mutationsEnabled ? "controlled_mutation" : "observe_only",
          tools,
          systemPrompt: AUTONOMOUS_SYSTEM_PROMPT,
          brief: cycleBrief(briefInput),
          cycle: s.cycle,
          runId: `${s.sessionId}-c${s.cycle}`,
          traceDirectory: this.options.traceDirectory === undefined ? (this.options.store.traceDirectory?.(s.sessionId) ?? null) : this.options.traceDirectory,
          initialState: { observedRevision: snapshot.revision, eventCursor: eventsResponse.nextCursor },
          journal: this.journal,
          deadlineMs,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          retryDelayMs: this.options.retryDelayMs ?? 400,
          ...(this.options.newMutationId ? { newMutationId: this.options.newMutationId } : {}),
          limits: {
            maxModelCalls: Math.max(1, Math.min(l.maxModelCallsPerCycle, l.maxModelCalls - b.modelCalls)),
            maxTotalToolCalls: Math.max(1, Math.min(l.maxToolCallsPerCycle, l.maxToolCalls - b.toolCalls)),
            maxToolCallsPerStep: 4,
            maxOutputTokens: l.maxOutputTokens,
            maxCostPerRequestUsd: l.maxCostPerRequestUsd,
            maxCostUsd: Math.max(0, l.maxCostUsd - b.costUsd),
            maxAdvanceSecondsPerCall: Math.min(l.maxAdvanceSecondsPerCall, remainingSim),
            maxTotalAdvanceSeconds: remainingSim,
            maxMutations: remainingMutations,
            maxAdvanceRequests: Math.max(0, Math.min(l.maxAdvanceRequests - b.advanceRequests, l.maxConsecutiveAdvances - b.consecutiveAdvances)),
            maxWaitChunkSeconds: l.maxWaitChunkSeconds,
            maxMutationAttempts: remainingMutations + Math.max(0, l.maxConsecutiveRejections - b.consecutiveRejections),
            maxInspections: remainingInspections,
            maxInspectionAttempts: remainingInspections + Math.max(0, l.maxConsecutiveRejections - b.consecutiveRejections),
          },
        });
        s.modelEventCursor = Math.max(eventsResponse.nextCursor, result.state.eventCursor);
      } catch (error) {
        if (error instanceof SessionLockLostError) throw error;
        if (isAuthFailure(error)) return await this.end("paused", "authentication_failure", "The simulator rejected the agent credentials (401/403).");
        if (error instanceof InconsistentObservationError) return await this.end("paused", "inconsistent_observation", error.message);
        s.budgets.consecutiveErrors += 1;
        this.log(`cycle error: ${error instanceof Error ? error.message : "unknown"}`);
        if (s.budgets.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) return await this.end("paused", "consecutive_errors", error instanceof Error ? error.message.slice(0, 300) : null);
        await this.save();
        continue;
      }

      const b = s.budgets;
      b.costUsd += result.totals.estimatedCostUsd;
      b.modelCalls += result.totals.modelCalls;
      b.toolCalls += result.totals.toolCalls;
      b.failedModelCalls += result.totals.failedModelCalls;
      b.modelRetryAttempts += result.totals.modelRetryAttempts;
      s.usage.inputTokens += result.totals.inputTokens;
      s.usage.outputTokens += result.totals.outputTokens;
      s.usage.cachedTokens += result.totals.cachedTokens;
      // Real provider-reported usage for this cycle (as opposed to the pre-call estimate logged above).
      this.log(`cycle ${s.cycle} usage ${JSON.stringify({ cycle: s.cycle, source: "provider", modelCalls: result.totals.modelCalls, failedModelCalls: result.totals.failedModelCalls, modelRetryAttempts: result.totals.modelRetryAttempts, inputTokens: result.totals.inputTokens, outputTokens: result.totals.outputTokens, cachedTokens: result.totals.cachedTokens, estimatedCostUsd: Math.round(result.totals.estimatedCostUsd * 1e6) / 1e6 })}`);
      if (sink.latest) s.plan = sink.latest;

      let waitedProgress = false;
      if (!s.pendingMutation) waitedProgress = await this.autoWait();
      await this.refreshActions();
      s.progress = buildProgress(s);
      const { progress: eventProgress, reasons } = await this.evaluateProgress(before.accepted);
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
      });

      const failedRun = result.stopReason === "model_error" || result.stopReason === "empty_response" || (result.stopReason === "cost_limit" && b.costUsd < s.config.limits.maxCostUsd);
      const hadUnknown = s.pendingMutation !== null;
      b.consecutiveErrors = failedRun || hadUnknown ? b.consecutiveErrors + 1 : 0;
      b.consecutiveNoProgress = progress ? 0 : b.consecutiveNoProgress + 1;
      await this.save();

      if (result.error && /HTTP (401|403)/.test(result.error)) return this.end("paused", "authentication_failure", "The model API rejected the credentials (401/403).");
      if (s.pendingMutation) continue; // reconcile first; never act on top of an unknown outcome
      if (result.stopReason === "wall_clock_limit") return this.end("stopped", "wall_clock_exhausted");
      if (sink.latest?.nextStep === "stop") return this.end("completed", "model_declared_done", sink.latest.stopReason);
      // A cycle whose model request failed produced no observation; it must not read as a finished observe-only session.
      if (!this.mutationsEnabled && (result.stopReason === "model_error" || result.stopReason === "empty_response")) return this.end("failed", "model_error", result.error ? result.error.slice(0, 300) : `The model produced no decision (${result.stopReason}).`);
      if (!this.mutationsEnabled) return this.end("completed", "observe_only_complete", "Mutations are disabled; one observation-and-planning cycle was run.");
      if (b.consecutiveErrors >= s.config.limits.maxConsecutiveErrors) {
        const modelFailure = result.stopReason === "model_error" || result.stopReason === "empty_response";
        return this.end("paused", "consecutive_errors", modelFailure && result.error ? result.error.slice(0, 300) : undefined);
      }
      if (b.consecutiveRejections >= s.config.limits.maxConsecutiveRejections) return this.end("stopped", "repeated_rejections");
      if (b.consecutiveNoProgress >= s.config.limits.maxConsecutiveNoProgress) return this.end("stopped", "no_progress", `${b.consecutiveNoProgress} consecutive cycles without progress`);
      const budget = this.budgetStop();
      if (budget) return this.end("stopped", budget.reason, budget.detail);
      if (this.options.sliceCycles !== undefined && cyclesThisRun >= this.options.sliceCycles) return this.end("paused", "slice_complete", `${cyclesThisRun} cycle(s) run in this process; resume continues the same budgets.`);
    }
  }
}
