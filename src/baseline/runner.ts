import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionRecordView, AdvanceResponse, ExecuteActionResponse } from "../contracts/index.js";
import { SimulatorError } from "../simulator/client.js";
import type { BaselineApi } from "./paced.js";
import { observationFingerprint } from "../benchmark/fingerprint.js";
import { compareOutcome, outcomeSnapshot, type OutcomeComparison, type OutcomeSnapshot } from "../benchmark/outcome.js";
import { attributeProduction, type ProductionAttribution } from "../benchmark/attribution.js";
import { DAY_S, decide, learn, newMemory, type BaselineConfig, type BaselineMemory, type Decision } from "./policy.js";

export interface BaselineLimits {
  maxSteps: number;
  maxAdvanceRequests: number;
  maxConflicts: number;
  maxConsecutiveErrors: number;
  maxConsecutiveNoProgress: number;
  maxWallClockMs: number;
}

export const DEFAULT_BASELINE_LIMITS: BaselineLimits = {
  maxSteps: 3000,
  maxAdvanceRequests: 1500,
  maxConflicts: 25,
  maxConsecutiveErrors: 5,
  maxConsecutiveNoProgress: 3,
  maxWallClockMs: 30 * 60_000,
};

export interface DecisionRecord {
  step: number;
  simTimeS: number;
  revision: number;
  rule: string;
  reason: string;
  holds: string[];
  type: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
  result: string | null;
}

interface TrackedAction {
  actionId: string;
  type: string;
  params: Record<string, unknown>;
  status: string;
  startedAtS: number | null;
  finishedAtS: number | null;
  outcomeSummary: string | null;
  measurements: Record<string, number>;
  creditsConsumed: number;
}

type PendingRequest =
  | { kind: "execute"; body: { type: string; params: Record<string, unknown>; idempotencyKey: string; expectedRevision: number; dryRun: false }; decisionIndex: number; cooldownKey: string }
  | { kind: "advance"; body: { requestedSeconds: number; stopOn: Array<"action_completion" | "any_event">; cursor: number; idempotencyKey: string; expectedRevision: number }; decisionIndex: number };

export interface BaselineState {
  version: 1;
  runId: string;
  strategy: "deterministic_baseline_v1";
  gameId: string;
  config: BaselineConfig;
  limits: BaselineLimits;
  scenario: { name: string | null; seed: number | null; initialStateFingerprint: string | null };
  startObservationSha256: string | null;
  startOutcome: OutcomeSnapshot | null;
  memory: BaselineMemory;
  decisions: DecisionRecord[];
  actions: TrackedAction[];
  pending: PendingRequest | null;
  cursor: number;
  counters: { steps: number; executeRequests: number; dryRunRequests: number; advanceRequests: number; grantedSeconds: number; conflicts: number; rejections: number; consecutiveErrors: number; consecutiveNoProgress: number };
  status: "running" | "stopped";
  stopReason: string | null;
  startedAtMs: number;
  wallClockMs: number;
  finalOutcome: OutcomeSnapshot | null;
  comparison: OutcomeComparison | null;
  attribution: ProductionAttribution | null;
}

export function newBaselineState(input: { runId?: string; gameId: string; config: BaselineConfig; limits?: Partial<BaselineLimits>; scenario?: Partial<BaselineState["scenario"]> }): BaselineState {
  return {
    version: 1,
    runId: input.runId ?? `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    strategy: "deterministic_baseline_v1",
    gameId: input.gameId,
    config: input.config,
    limits: { ...DEFAULT_BASELINE_LIMITS, ...input.limits },
    scenario: { name: null, seed: null, initialStateFingerprint: null, ...input.scenario },
    startObservationSha256: null,
    startOutcome: null,
    memory: newMemory(),
    decisions: [],
    actions: [],
    pending: null,
    cursor: 0,
    counters: { steps: 0, executeRequests: 0, dryRunRequests: 0, advanceRequests: 0, grantedSeconds: 0, conflicts: 0, rejections: 0, consecutiveErrors: 0, consecutiveNoProgress: 0 },
    status: "running",
    stopReason: null,
    startedAtMs: Date.now(),
    wallClockMs: 0,
    finalOutcome: null,
    comparison: null,
    attribution: null,
  };
}

export class BaselineStore {
  constructor(private readonly dir: string) {}
  private file(runId: string) {
    return join(this.dir, runId, "state.json");
  }
  exists(runId: string) {
    return existsSync(this.file(runId));
  }
  load(runId: string): BaselineState {
    return JSON.parse(readFileSync(this.file(runId), "utf8")) as BaselineState;
  }
  /** Atomic write so a crash cannot leave a half-written state. */
  save(state: BaselineState) {
    const file = this.file(state.runId);
    mkdirSync(join(this.dir, state.runId), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  }
}

const summarize = (a: ActionRecordView): Pick<TrackedAction, "status" | "startedAtS" | "finishedAtS" | "outcomeSummary" | "measurements" | "creditsConsumed"> => ({
  status: a.status,
  startedAtS: a.startedAtS,
  finishedAtS: a.finishedAtS,
  outcomeSummary: a.outcome?.summary ?? null,
  measurements: a.outcome?.measurements ?? {},
  creditsConsumed: a.consumed.credits,
});

const FINAL = new Set(["completed", "failed", "cancelled", "rejected"]);

/** Runs the deterministic baseline through the same authorized agent API as Muse. Resumable and idempotent. */
export class BaselineRunner {
  constructor(private readonly client: BaselineApi, private readonly store: BaselineStore, private readonly log: (m: string) => void = () => {}) {}

  async run(state: BaselineState): Promise<BaselineState> {
    const wallStart = Date.now();
    const baseWall = state.wallClockMs;
    const stop = (reason: string) => {
      state.status = "stopped";
      state.stopReason = reason;
    };
    state.status = "running";
    state.stopReason = null;
    state.counters.consecutiveErrors = 0; // transient: a resumed process starts with a clean slate
    state.counters.consecutiveNoProgress = 0;
    try {
      while (state.status === "running") {
        state.wallClockMs = baseWall + (Date.now() - wallStart);
        const limit = this.limitReached(state);
        if (limit) {
          stop(limit);
          break;
        }
        await this.step(state, stop);
        this.store.save(state);
      }
    } finally {
      state.wallClockMs = baseWall + (Date.now() - wallStart);
      this.store.save(state);
    }
    await this.finalize(state);
    this.store.save(state);
    return state;
  }

  private limitReached(s: BaselineState): string | null {
    if (s.counters.steps >= s.limits.maxSteps) return "step_limit";
    if (s.counters.advanceRequests >= s.limits.maxAdvanceRequests) return "advance_request_limit";
    if (s.counters.conflicts >= s.limits.maxConflicts) return "conflict_limit";
    if (s.counters.consecutiveErrors >= s.limits.maxConsecutiveErrors) return "consecutive_error_limit";
    if (s.counters.consecutiveNoProgress >= s.limits.maxConsecutiveNoProgress) return "no_progress";
    if (s.wallClockMs >= s.limits.maxWallClockMs) return "wall_clock_limit";
    return null;
  }

  private async step(s: BaselineState, stop: (reason: string) => void) {
    // A request that may or may not have reached the server is re-sent with its ORIGINAL body and key, so the
    // server's durable idempotency record guarantees it is applied at most once.
    if (s.pending) {
      await this.send(s, s.pending, stop);
      return;
    }
    const got = await this.guard(s, () => Promise.all([this.client.getFarmOverview(s.gameId), this.client.getFieldObservations(s.gameId), this.client.getAvailableActions(s.gameId)]));
    if (!got) return;
    const [overview, fields, actions] = got;
    if (s.startOutcome === null) {
      s.startOutcome = outcomeSnapshot(overview);
      s.startObservationSha256 = observationFingerprint({ overview, fields, actions }).combinedSha256;
    }
    s.memory.nowS = overview.clock.simTimeS;
    await this.reconcile(s);
    const decision = decide({ overview, actions }, s.memory, s.config);
    s.counters.steps += 1;
    const index = s.decisions.length;
    s.decisions.push(this.record(s, overview.clock.simTimeS, overview.revision, decision));
    this.log(`step ${s.counters.steps} day ${overview.clock.simDay} rev ${overview.revision}: ${decision.rule} ${decision.kind === "execute" ? `${decision.type} ${JSON.stringify(decision.params)}` : decision.kind === "advance" ? `advance ${decision.seconds}s` : "stop"}`);

    if (decision.kind === "stop") {
      stop(decision.rule === "R0_horizon" ? "horizon_reached" : decision.reason);
      return;
    }
    if (decision.kind === "execute") {
      if (decision.preflight && !(await this.preflight(s, decision, overview.revision, index))) return;
      s.pending = { kind: "execute", body: { type: decision.type, params: decision.params, idempotencyKey: randomUUID(), expectedRevision: overview.revision, dryRun: false }, decisionIndex: index, cooldownKey: decision.cooldownKey };
    } else {
      s.pending = { kind: "advance", body: { requestedSeconds: decision.seconds, stopOn: decision.stopOn, cursor: s.cursor, idempotencyKey: randomUUID(), expectedRevision: overview.revision }, decisionIndex: index };
    }
    s.decisions[index]!.idempotencyKey = s.pending.body.idempotencyKey;
    this.store.save(s); // durable intent BEFORE the request leaves the process
    await this.send(s, s.pending, stop);
  }

  private record(s: BaselineState, simTimeS: number, revision: number, d: Decision): DecisionRecord {
    return {
      step: s.counters.steps,
      simTimeS,
      revision,
      rule: d.rule,
      reason: d.reason,
      holds: d.holds,
      type: d.kind === "execute" ? d.type : d.kind,
      params: d.kind === "execute" ? d.params : d.kind === "advance" ? { seconds: d.seconds, stopOn: d.stopOn } : {},
      idempotencyKey: null,
      result: null,
    };
  }

  /** A dry run commits nothing; it only checks that a crop choice is acceptable before the real request. */
  private async preflight(s: BaselineState, d: Extract<Decision, { kind: "execute" }>, revision: number, index: number): Promise<boolean> {
    const response = await this.guard(s, () => this.client.executeAction(s.gameId, { type: d.type, params: d.params, expectedRevision: revision, dryRun: true }));
    if (!response) return false;
    s.counters.dryRunRequests += 1;
    if (response.accepted) return true;
    s.counters.rejections += 1;
    s.memory.cooldowns[d.cooldownKey] = s.memory.nowS + s.config.rejectionCooldownS;
    s.decisions[index]!.result = `dry_run_rejected: ${response.errors.map((e) => e.code).join(",")}`;
    return false;
  }

  private async send(s: BaselineState, pending: PendingRequest, stop: (reason: string) => void) {
    const record = s.decisions[pending.decisionIndex]!;
    try {
      if (pending.kind === "execute") {
        s.counters.executeRequests += 1;
        const response = await this.client.executeAction(s.gameId, pending.body);
        this.afterExecute(s, pending, response, record);
      } else {
        s.counters.advanceRequests += 1;
        const response = await this.client.advance(s.gameId, pending.body);
        this.afterAdvance(s, response, record);
      }
      s.pending = null;
      s.counters.consecutiveErrors = 0;
    } catch (error) {
      if (error instanceof SimulatorError && error.kind === "http" && error.status === 409) {
        s.counters.conflicts += 1;
        record.result = "conflict_409";
        s.pending = null; // stale revision: nothing was applied; re-observe and decide again
        return;
      }
      if (error instanceof SimulatorError && error.kind === "http" && error.status !== undefined && error.status < 500 && error.status !== 429) {
        record.result = `http_${error.status}`;
        s.pending = null;
        stop(`http_${error.status}: ${error.message}`);
        return;
      }
      // network / timeout / 5xx: the outcome is unknown, so keep `pending` (same body, same key) for the retry.
      s.counters.consecutiveErrors += 1;
      record.result = `uncertain: ${error instanceof Error ? error.message : String(error)}`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * s.counters.consecutiveErrors)));
    }
  }

  private afterExecute(s: BaselineState, pending: Extract<PendingRequest, { kind: "execute" }>, response: ExecuteActionResponse, record: DecisionRecord) {
    if (!response.accepted || !response.action) {
      s.counters.rejections += 1;
      record.result = `rejected: ${response.errors.map((e) => e.code).join(",")}`;
      s.memory.cooldowns[pending.cooldownKey] = s.memory.nowS + s.config.rejectionCooldownS;
      return;
    }
    record.result = `${response.action.status}: ${response.action.actionId}`;
    const tracked: TrackedAction = { actionId: response.action.actionId, type: pending.body.type, params: pending.body.params, ...summarize(response.action) };
    s.actions.push(tracked);
    if (FINAL.has(tracked.status)) learn(s.memory, tracked);
  }

  private afterAdvance(s: BaselineState, response: AdvanceResponse, record: DecisionRecord) {
    s.cursor = response.nextCursor;
    s.counters.grantedSeconds += response.grantedSeconds;
    s.counters.consecutiveNoProgress = response.grantedSeconds > 0 ? 0 : s.counters.consecutiveNoProgress + 1;
    s.memory.nowS = response.clockAfter.simTimeS;
    record.result = `granted ${response.grantedSeconds}s of ${response.requestedSeconds}s (${response.stoppedBecause})`;
  }

  /** Asynchronous actions finish on the simulation clock; learn from them only once the server says they are final. */
  private async reconcile(s: BaselineState) {
    for (const action of s.actions) {
      if (FINAL.has(action.status)) continue;
      const fresh = await this.client.getAction(s.gameId, action.actionId);
      Object.assign(action, summarize(fresh.action));
      if (FINAL.has(action.status)) learn(s.memory, action);
    }
  }

  private async guard<T>(s: BaselineState, fn: () => Promise<T>): Promise<T | null> {
    try {
      const value = await fn();
      s.counters.consecutiveErrors = 0;
      return value;
    } catch (error) {
      s.counters.consecutiveErrors += 1;
      this.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * s.counters.consecutiveErrors)));
      return null;
    }
  }

  private async finalize(s: BaselineState) {
    try {
      s.finalOutcome = outcomeSnapshot(await this.client.getFarmOverview(s.gameId));
      if (s.startOutcome) s.comparison = compareOutcome(s.startOutcome, s.finalOutcome);
      s.attribution = attributeProduction(s.actions, s.finalOutcome.marketPricesPerKg);
    } catch {
      s.stopReason = `${s.stopReason ?? "stopped"} (final observation failed)`;
    }
  }
}

export const horizonSeconds = (config: BaselineConfig) => config.horizonDays * DAY_S;
