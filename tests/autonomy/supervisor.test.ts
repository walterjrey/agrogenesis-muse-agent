import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutonomousController, newSessionState } from "../../src/autonomy/controller.js";
import { digestCatalog, compactCatalog } from "../../src/autonomy/catalog.js";
import { buildProgress } from "../../src/autonomy/progress.js";
import { superviseOperation, type SupervisorDeps } from "../../src/autonomy/supervisor.js";
import { SessionStore } from "../../src/autonomy/store.js";
import type { SessionLimits } from "../../src/autonomy/types.js";
import { compactHistory } from "../../src/agent/history.js";
import type { AvailableActions } from "../../src/contracts/actions.js";
import { availableActions, GAME_ID } from "../fixtures.js";
import { countingIds, scriptedModel, type ScriptedStep } from "../agent/harness.js";
import { timedSim, type TimedSim, type TimedSimOptions } from "./timedSim.js";

/**
 * Everything here is MOCKED: a scripted model (it makes no decisions) and a time-aware fake HTTP simulator
 * (tests/autonomy/timedSim.ts). They verify supervisor/controller mechanics and fault handling. They are NOT live
 * validation of Meta Muse, of the real simulator, or of its agricultural mechanics.
 */

let sim: TimedSim | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await sim?.close();
  sim = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ids = countingIds();
const catalog = availableActions as unknown as AvailableActions;

async function start(options: TimedSimOptions = {}, timeoutMs = 2000) {
  sim = await timedSim(options, timeoutMs);
  const created = await sim.client.executeAction(GAME_ID, { type: "prepareSoil", params: { fieldId: "field-1" }, idempotencyKey: ids(), expectedRevision: sim.state.revision });
  return { sim, actionId: created.action!.actionId };
}

function deps(s: TimedSim, over: Partial<SupervisorDeps> = {}) {
  let cursor = 0;
  const advanced: number[] = [];
  const base: SupervisorDeps = {
    client: s.client,
    gameId: GAME_ID,
    newMutationId: ids,
    retryDelayMs: 1,
    maxMutationRetries: 2,
    budget: { requestsLeft: 50, simSecondsLeft: 100_000, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 3 },
    getCursor: () => cursor,
    setCursor: (c) => { cursor = c; },
    onAdvanced: (granted) => { advanced.push(granted); },
  };
  return { deps: { ...base, ...over }, advanced };
}

describe("MOCKED supervisor: time units and granted time", () => {
  it("treats one simulated day as 60 s and accounts only the time the server actually granted", async () => {
    const { sim: s, actionId } = await start({ durationS: 600, maxGrantS: 20 });
    const { deps: d, advanced } = deps(s, { budget: { requestsLeft: 3, simSecondsLeft: 1000, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 3 } });
    const result = await superviseOperation(d, { actionId });
    expect(s.state.advances.map((a) => a.granted)).toEqual([20, 20, 20]);
    expect(advanced).toEqual([20, 20, 20]);
    expect(result).toMatchObject({ outcome: "wait_limit", advancedSeconds: 60, advanceRequests: 3, simTimeStartS: 0, simTimeEndS: 60 });
    expect(Math.floor((result.simTimeEndS ?? 0) / 60)).toBe(1);
  });
});

describe("MOCKED supervisor: operation completion", () => {
  it("completes a short operation in ONE advance sized from the simulator's estimate", async () => {
    const { sim: s, actionId } = await start({ durationS: 11, estimateS: 11 });
    const { deps: d } = deps(s);
    const result = await superviseOperation(d, { actionId });
    expect(s.advancePosts).toHaveLength(1);
    expect(s.advancePosts[0]).toMatchObject({ stopOn: ["action_completion"], expectedRevision: 5 });
    expect(Number(s.advancePosts[0]!.requestedSeconds)).toBeLessThanOrEqual(12);
    expect(result).toMatchObject({ outcome: "completed", actionStatus: "completed", advanceRequests: 1, consumedCredits: 9.12, finishedAtS: 11 });
  });

  it("handles an estimate that is already in the past by growing the advance geometrically, not in 0.1 s steps", async () => {
    const { sim: s, actionId } = await start({ durationS: 700, estimateS: 1 });
    const { deps: d } = deps(s, { budget: { requestsLeft: 50, simSecondsLeft: 100_000, maxChunkSeconds: 3600, maxCallSeconds: 3600, conflictsLeft: 3 } });
    const result = await superviseOperation(d, { actionId });
    expect(result.outcome).toBe("completed");
    expect(s.state.advances.length).toBeLessThanOrEqual(6);
    expect(s.state.advances.map((a) => a.requested)).toEqual([...s.state.advances.map((a) => a.requested)].sort((a, b) => a - b));
  });

  it("waits through a long operation with a bounded number of requests when no estimate exists", async () => {
    const { sim: s, actionId } = await start({ durationS: 3 * 60 * 60, estimateS: null });
    const { deps: d } = deps(s, { budget: { requestsLeft: 50, simSecondsLeft: 100_000, maxChunkSeconds: 3600, maxCallSeconds: 3600, conflictsLeft: 3 } });
    const result = await superviseOperation(d, { actionId });
    expect(result.outcome).toBe("completed");
    expect(result.advanceRequests).toBeLessThanOrEqual(8);
    expect(result.advancedSeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(result.advancedSeconds).toBeLessThan(3 * 60 * 60 + 0.5);
  });
});

describe("MOCKED supervisor: events and limits", () => {
  it("returns control to the model on a failure event and reports the simulator's failure", async () => {
    const { sim: s, actionId } = await start({ durationS: 300, estimateS: null, failAtS: 20 });
    const result = await superviseOperation(deps(s).deps, { actionId });
    expect(result).toMatchObject({ outcome: "failed", actionStatus: "failed", failure: "equipment_fault: The machine broke down." });
    expect(result.events.some((e) => e.startsWith("action_failed"))).toBe(true);
  });

  it("returns control on a weather alert even though the awaited operation is still running", async () => {
    const { sim: s, actionId } = await start({ durationS: 600, estimateS: null, weatherAtS: 30 });
    const result = await superviseOperation(deps(s).deps, { actionId });
    expect(result).toMatchObject({ outcome: "event_interrupt", actionStatus: "running" });
    expect(result.events.join("\n")).toContain("weather_alert");
    expect(s.state.simTimeS).toBeLessThan(600);
  });

  it("stops at the advance-request budget and at the simulated-time budget without a hidden extra request", async () => {
    const a = await start({ durationS: 100_000, estimateS: null });
    const r1 = await superviseOperation(deps(a.sim, { budget: { requestsLeft: 2, simSecondsLeft: 100_000, maxChunkSeconds: 60, maxCallSeconds: 3600, conflictsLeft: 3 } }).deps, { actionId: a.actionId });
    expect(r1).toMatchObject({ outcome: "wait_limit", advanceRequests: 2 });
    expect(a.sim.advancePosts).toHaveLength(2);
    await a.sim.close();

    const b = await start({ durationS: 100_000, estimateS: null });
    const r2 = await superviseOperation(deps(b.sim, { budget: { requestsLeft: 50, simSecondsLeft: 90, maxChunkSeconds: 60, maxCallSeconds: 3600, conflictsLeft: 3 } }).deps, { actionId: b.actionId });
    expect(r2.outcome).toBe("wait_limit");
    expect(r2.advancedSeconds).toBeLessThanOrEqual(90);
  });

  it("honours the per-wait maxSeconds", async () => {
    const { sim: s, actionId } = await start({ durationS: 100_000, estimateS: null });
    const result = await superviseOperation(deps(s).deps, { actionId, maxSeconds: 45 });
    expect(result.outcome).toBe("wait_limit");
    expect(result.advancedSeconds).toBeLessThanOrEqual(45);
  });
});

describe("MOCKED supervisor: conflicts and uncertain outcomes", () => {
  it("refreshes the revision after a 409 and continues; the conflict is counted and nothing is advanced twice", async () => {
    const { sim: s, actionId } = await start({ durationS: 30, estimateS: 30, staleOnce: 1 });
    let conflicts = 0;
    const result = await superviseOperation(deps(s, { onConflict: () => { conflicts += 1; } }).deps, { actionId });
    expect(result.outcome).toBe("completed");
    expect(result.conflicts).toBe(1);
    expect(conflicts).toBe(1);
    expect(s.state.advances).toHaveLength(1);
    expect(new Set(s.advancePosts.map((p) => p.idempotencyKey)).size).toBe(s.advancePosts.length);
  });

  it("gives up with a conflict result when stale revisions persist beyond the conflict budget", async () => {
    const { sim: s, actionId } = await start({ durationS: 30, estimateS: 30, staleOnce: 10 });
    const result = await superviseOperation(deps(s, { budget: { requestsLeft: 50, simSecondsLeft: 100_000, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 2 } }).deps, { actionId });
    expect(result.outcome).toBe("conflict");
    expect(s.state.advances).toHaveLength(0);
  });

  it("reports outcome_unknown after a lost response and leaves the journal entry for reconciliation with the same key", async () => {
    const { sim: s, actionId } = await start({ durationS: 30, estimateS: 30, loseResponses: 1 }, 150);
    const begun: Array<{ key: string; request: Record<string, unknown> }> = [];
    const settled: string[] = [];
    const journal = { begin: async (i: { idempotencyKey: string; request: Record<string, unknown> }) => { begun.push({ key: i.idempotencyKey, request: i.request }); }, settle: async (i: { idempotencyKey: string }) => { settled.push(i.idempotencyKey); } };
    const result = await superviseOperation(deps(s, { journal: journal as never, maxMutationRetries: 0 }).deps, { actionId });
    expect(result.outcome).toBe("outcome_unknown");
    expect(begun).toHaveLength(1);
    expect(settled).toEqual([]);
    const before = s.state.simTimeS;
    // Replaying the persisted request with the SAME key returns the stored result and does not advance again.
    const replay = await s.client.advance(GAME_ID, begun[0]!.request as never);
    expect(replay.grantedSeconds).toBeGreaterThan(0);
    expect(s.state.simTimeS).toBe(before);
    expect(s.state.replays).toBe(1);
    expect(s.state.advances).toHaveLength(1);
  });
});

// ---------- controller-level (mocked model + timed simulator) ----------

const EXECUTE: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "prepareSoil", params: { fieldId: "field-1" }, rationale: "Soil must be prepared before sowing." } }] };
const TEXT = (content: string): ScriptedStep => ({ content });
const WAIT = (actionId = "act-1"): ScriptedStep => ({ calls: [{ name: "wait_for_operation", args: { actionId, rationale: "Operation in flight." } }] });

function sessionSetup(limits: Partial<SessionLimits> = {}, autoWait = true) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  dirs.push(dir);
  const store = new SessionStore(dir, 5_000);
  const state = newSessionState({ sessionId: "w1", gameId: GAME_ID, modelId: "muse-spark-1.3", mutationsEnabled: true, limits, autoWait });
  const lock = store.acquire("w1");
  lock.save(state);
  lock.release();
  return { dir, store };
}
const ctl = (store: SessionStore, s: TimedSim, model: ReturnType<typeof scriptedModel>, extra: Partial<ConstructorParameters<typeof AutonomousController>[0]> = {}) =>
  new AutonomousController({ store, sessionId: "w1", provider: model, client: s.client, mutationsEnabled: true, newMutationId: ids, retryDelayMs: 1, traceDirectory: null, ...extra });

describe("MOCKED controller: supervised waiting", () => {
  it("waits mechanically for an authorized operation without spending model calls, then hands the result back to the model", async () => {
    sim = await timedSim({ durationS: 11, estimateS: 11 });
    const { store } = sessionSetup({ maxCycles: 3 });
    // Cycle 1 starts the operation; the controller waits. Cycle 2 the model sees the completed operation and stops.
    const model = scriptedModel([EXECUTE, TEXT("Started prepareSoil."), { calls: [{ name: "update_plan", args: { summary: "Seen the completed soil preparation; nothing else is justified now.", nextStep: "stop", stopReason: "done" } }] }, TEXT("ok")]);
    const final = await ctl(store, sim, model).run();
    expect(final).toMatchObject({ status: "completed", stopReason: "model_declared_done", cycle: 2 });
    expect(final.actions[0]).toMatchObject({ actionId: "act-1", status: "completed", consumedCredits: 9.12, outcome: "prepareSoil done" });
    expect(final.waits).toEqual([expect.objectContaining({ trigger: "controller", outcome: "completed", actionId: "act-1", advanceRequests: 1 })]);
    expect(final.budgets).toMatchObject({ advanceRequests: 1, acceptedMutations: 1 });
    // The waiting itself used no model request: 2 cycles, 4 model calls scripted, waiting added none.
    expect(model.requests.length).toBe(4);
    expect(sim.state.advances).toHaveLength(1);
    expect(final.decisions[0]).toMatchObject({ progress: true });
    expect(final.progress?.completedOperations[0]).toMatchObject({ actionId: "act-1", status: "completed", outcome: "prepareSoil done" });
    expect(final.progress?.nextRequiredDecision).toContain("review the result of prepareSoil act-1");
  });

  it("does not choose farm actions on its own: only advance requests follow the model's single action", async () => {
    sim = await timedSim({ durationS: 30, estimateS: 30 });
    const { store } = sessionSetup({ maxCycles: 1 });
    await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(sim.actionPosts).toHaveLength(1);
    expect(sim.advancePosts.length).toBeGreaterThan(0);
  });

  it("offers wait_for_operation to the model as a tool that consumes the same budgets", async () => {
    sim = await timedSim({ durationS: 11, estimateS: 11 });
    const { store } = sessionSetup({ maxCycles: 1 }, false);
    const model = scriptedModel([EXECUTE, WAIT(), TEXT("Waited.")]);
    const final = await ctl(store, sim, model).run();
    expect(final.waits).toEqual([expect.objectContaining({ trigger: "model_tool", outcome: "completed" })]);
    expect(final.budgets.advanceRequests).toBe(1);
    expect(final.budgets.advancedSimSeconds).toBeGreaterThan(0);
  });

  it("stops with a specific reason when the advance-request budget is exhausted", async () => {
    sim = await timedSim({ durationS: 100_000, estimateS: null });
    const { store } = sessionSetup({ maxAdvanceRequests: 2, maxWaitChunkSeconds: 60, maxCycles: 5 });
    const final = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: "advance_request_budget_exhausted" });
    expect(sim.state.advances).toHaveLength(2);
  });

  it("stops at the simulated-time budget and does not replay completed advances on resume", async () => {
    sim = await timedSim({ durationS: 100_000, estimateS: null });
    const { store } = sessionSetup({ maxSimSeconds: 120, maxWaitChunkSeconds: 60, maxCycles: 5 });
    const first = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(first.stopReason).toBe("sim_time_limit_reached");
    const advancesAfterFirst = sim.state.advances.length;
    const simTime = sim.state.simTimeS;
    expect(first.budgets.advancedSimSeconds).toBe(simTime);
    // A stopped session cannot be resumed (budgets are never raised automatically): nothing is replayed.
    await expect(ctl(store, sim, scriptedModel([TEXT("x")])).run()).rejects.toThrow(/cannot be resumed/);
    expect(sim.state.advances).toHaveLength(advancesAfterFirst);
    expect(sim.state.simTimeS).toBe(simTime);
  });

  it("stops after too many consecutive advances without a new action", async () => {
    sim = await timedSim({ durationS: 100_000, estimateS: null });
    const { store } = sessionSetup({ maxConsecutiveAdvances: 3, maxWaitChunkSeconds: 60, maxCycles: 5 });
    const final = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(final.stopReason).toBe("consecutive_advance_limit");
    expect(final.stopDetail).toMatch(/3\/3 consecutive waits without an accepted farm action or inspection/);
    expect(sim.state.advances).toHaveLength(3);
  });

  it("counts one review interval as one waiting decision, however many checkpoints it used", async () => {
    sim = await timedSim({ durationS: 30, estimateS: 30 });
    const { store } = sessionSetup({ maxConsecutiveAdvances: 2, maxCycles: 2 });
    const interval: ScriptedStep = { calls: [{ name: "wait_for_checkpoint", args: { maxDays: 8, checkpointDays: 2, rationale: "Let time pass." } }] };
    const final = await ctl(store, sim, scriptedModel([interval, TEXT("Waited."), TEXT("Nothing justified.")])).run();
    expect(sim.state.advances.length).toBeGreaterThan(2);
    expect(final.budgets.advanceRequests).toBe(sim.state.advances.length);
    expect(final.budgets.consecutiveAdvances).toBe(1);
    expect(final.stopReason).not.toBe("consecutive_advance_limit");
  });

  it("cannot bypass the consecutive-wait limit by repeating wait_for_checkpoint across cycles", async () => {
    sim = await timedSim({ durationS: 30, estimateS: 30 });
    const { store } = sessionSetup({ maxConsecutiveAdvances: 2, maxCycles: 8 });
    const interval: ScriptedStep = { calls: [{ name: "wait_for_checkpoint", args: { maxDays: 4, checkpointDays: 2, rationale: "Let time pass." } }] };
    const final = await ctl(store, sim, scriptedModel([interval, TEXT("Waited."), interval, TEXT("Waited."), interval, TEXT("Waited."), interval, TEXT("Waited.")])).run();
    expect(final.stopReason).toBe("consecutive_advance_limit");
    expect(final.budgets.consecutiveAdvances).toBe(2);
    expect(final.waits.filter((w) => w.actionId === "checkpoint-interval")).toHaveLength(2);
  });

  it("stops on persistent database conflicts", async () => {
    sim = await timedSim({ durationS: 30, estimateS: 30, staleOnce: 100 });
    const { store } = sessionSetup({ maxConflicts: 2, maxCycles: 5 });
    const final = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(final.stopReason).toBe("database_conflict_limit");
    expect(final.budgets.conflicts).toBeGreaterThanOrEqual(2);
    expect(sim.state.advances).toHaveLength(0);
  });

  it("after a lost response, pauses with the pending advance and resumes by replaying the SAME key without advancing twice", async () => {
    sim = await timedSim({ durationS: 30, estimateS: 30, loseResponses: 100 }, 150);
    const { store } = sessionSetup({ maxCycles: 4 });
    const first = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")]), { sliceCycles: 1 }).run();
    expect(first.status).toBe("paused");
    expect(first.pendingMutation).toMatchObject({ tool: "advance_time" });
    const key = first.pendingMutation!.idempotencyKey;
    expect(sim.state.advances).toHaveLength(1); // the simulator committed it once

    sim.setLose(0);
    const second = await ctl(store, sim, scriptedModel([{ calls: [{ name: "update_plan", args: { summary: "Operation finished.", nextStep: "stop", stopReason: "done" } }] }, TEXT("ok")])).run();
    expect(second.pendingMutation).toBeNull();
    expect(second.operations.find((o) => o.idempotencyKey === key)).toMatchObject({ status: "applied", via: "reconciled" });
    expect(sim.state.advances).toHaveLength(1); // not advanced a second time
    expect(sim.state.replays).toBeGreaterThanOrEqual(1);
    expect(sim.actionPosts).toHaveLength(1);
    expect(sim.state.credits).toBe(2500 - 25 - 9.12);
  });
});

describe("MOCKED progress record", () => {
  it("is derived from simulator data only and never invents a plan", async () => {
    sim = await timedSim({ durationS: 11, estimateS: 11 });
    const { store } = sessionSetup({ maxCycles: 1 });
    const final = await ctl(store, sim, scriptedModel([EXECUTE, TEXT("Started.")])).run();
    expect(final.plan).toBeNull();
    const p = buildProgress(final);
    expect(p.pendingOperations).toEqual([]);
    expect(p.completedOperations).toEqual([expect.objectContaining({ actionId: "act-1", type: "prepareSoil", target: "field-1", status: "completed", finishedAtS: 11 })]);
    expect(p.expenses.actionConsumedCredits).toBe(9.12);
    expect(p.expenses.creditsDelta).toBe(-34.12);
    expect(JSON.stringify(p)).not.toMatch(/\bplan(s|ning)?\b/i);
  });
});

describe("MOCKED context compression", () => {
  it("the digest catalog is much smaller than the compact catalog and keeps every eligible option and the simulator's estimate", () => {
    const compact = JSON.stringify(compactCatalog(catalog));
    const digest = digestCatalog(catalog);
    expect(JSON.stringify(digest).length).toBeLessThan(compact.length * 0.8);
    const eligible = availableActions.actions.filter((a) => a.eligibility.eligible).length;
    expect(digest.eligibleOptions).toBe(eligible);
    for (const a of digest.actions) expect(a.options.every((o) => o.estimate.length > 0 && o.targets.length > 0)).toBe(true);
    expect(digest.revision).toBe(availableActions.revision);
  });

  it("replaces only superseded observation results with revision/time stubs and keeps the latest, errors and mutations intact", () => {
    const big = (revision: number) => JSON.stringify({ ok: true, data: { revision, simTimeS: revision * 10, filler: "x".repeat(2000) } });
    const messages = [
      { role: "system", content: "s" },
      { role: "user", content: "brief" },
      { role: "tool", tool_call_id: "a", content: big(4) },
      { role: "tool", tool_call_id: "b", content: JSON.stringify({ ok: false, error: { code: "stale_revision", message: "conflict" } }) },
      { role: "tool", tool_call_id: "c", content: big(5) },
      { role: "tool", tool_call_id: "d", content: big(6) },
    ] as never[];
    const calls = new Map([
      ["a", { name: "observe_snapshot", arguments: "{}" }],
      ["b", { name: "observe_snapshot", arguments: "{}" }],
      ["c", { name: "execute_action", arguments: "{}" }],
      ["d", { name: "observe_snapshot", arguments: "{}" }],
    ]);
    const out = compactHistory(messages, calls) as unknown as Array<{ content: string }>;
    expect(JSON.parse(out[2]!.content)).toMatchObject({ superseded: true, revision: 4, simTimeS: 40 });
    expect(out[3]!.content).toContain("stale_revision");
    expect(out[4]!.content).toBe((messages[4] as unknown as { content: string }).content);
    expect(out[5]!.content).toBe((messages[5] as unknown as { content: string }).content);
    expect((messages[2] as unknown as { content: string }).content.length).toBeGreaterThan(2000);
  });
});

describe("MOCKED determinism", () => {
  it("the same script against the same simulator settings yields the same advances and final state", async () => {
    const runs: Array<{ advances: number[]; simTimeS: number; credits: number }> = [];
    for (let i = 0; i < 2; i += 1) {
      const s = await timedSim({ durationS: 700, estimateS: 1 });
      const { store } = sessionSetup({ maxCycles: 1, maxWaitChunkSeconds: 600 });
      await ctl(store, s, scriptedModel([EXECUTE, TEXT("Started.")])).run();
      runs.push({ advances: s.state.advances.map((a) => a.requested), simTimeS: s.state.simTimeS, credits: s.state.credits });
      await s.close();
    }
    expect(runs[0]).toEqual(runs[1]);
  });
});
