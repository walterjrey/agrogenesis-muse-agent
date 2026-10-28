import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutonomousController, newSessionState } from "../../src/autonomy/controller.js";
import { compactCatalog, describeAction } from "../../src/autonomy/catalog.js";
import { collectSnapshot, InconsistentObservationError, summarizeSnapshot } from "../../src/autonomy/observation.js";
import { buildReport } from "../../src/autonomy/report.js";
import { SessionLockLostError, SessionLockedError, SessionStore } from "../../src/autonomy/store.js";
import type { SessionLimits, SessionState } from "../../src/autonomy/types.js";
import type { AvailableActions } from "../../src/contracts/actions.js";
import { ModelApiError } from "../../src/model/meta.js";
import { availableActions, clock, executeAccepted, fieldObservations, GAME_ID, overview } from "../fixtures.js";
import { countingIds, fakeSimulator, scriptedModel, type FakeSim, type ScriptedStep } from "../agent/harness.js";

/**
 * Everything here is MOCKED: a scripted model (it makes no decisions) and a fake HTTP simulator with revision checks
 * and idempotent replay. These tests verify controller mechanics and fault handling. They are NOT live validation
 * of Meta Muse or of the real simulator/PostgreSQL; see docs/AUTONOMOUS_AGENT.md for what was verified live.
 */

let sim: FakeSim | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await sim?.close();
  sim = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INSPECT: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "inspectField", params: { fieldId: "field-1" }, rationale: "Moisture is stale." } }] };
const ADVANCE = (seconds = 600): ScriptedStep => ({ calls: [{ name: "advance_time", args: { requestedSeconds: seconds, stopOn: ["action_completion"] } }] });
const PLAN = (nextStep: "continue" | "wait_for_actions" | "stop", summary = `plan ${nextStep}`): ScriptedStep => ({
  calls: [{ name: "update_plan", args: { summary, nextStep, priorities: ["verify moisture"], ...(nextStep === "stop" ? { stopReason: "nothing useful left" } : {}) } }],
});
const TEXT: ScriptedStep = { content: "ok" };

function setup(limits: Partial<SessionLimits> = {}, mutationsEnabled = true, planning: { horizonDays?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-"));
  dirs.push(dir);
  const store = new SessionStore(dir, 5_000);
  const state = newSessionState({ sessionId: "t1", gameId: GAME_ID, modelId: "muse-spark-1.3", mutationsEnabled, limits, planning, autoWait: false });
  const lock = store.acquire("t1");
  lock.save(state);
  lock.release();
  return { dir, store, state };
}

// One generator for the whole file: real keys are random UUIDs, so a restarted process never reuses a key.
const uniqueIds = countingIds();
const controller = (store: SessionStore, s: FakeSim, model: ReturnType<typeof scriptedModel>, extra: Partial<ConstructorParameters<typeof AutonomousController>[0]> = {}) =>
  new AutonomousController({ store, sessionId: "t1", provider: model, client: s.client, mutationsEnabled: true, newMutationId: uniqueIds, retryDelayMs: 1, traceDirectory: null, ...extra });

const completedEvents = (req: { url: string }) =>
  req.url.includes("/events")
    ? { status: 200, body: { gameId: GAME_ID, clock, events: [{ eventId: 1, simTimeS: clock.simTimeS, kind: "action_completed", actionId: "act-1", summary: "done", data: {} }], nextCursor: 1 } }
    : undefined;

describe("MOCKED autonomy: multi-cycle control and persistence", () => {
  it("runs several decision cycles, persists them and keeps accurate decision and cost logs", async () => {
    sim = await fakeSimulator((req) => completedEvents(req));
    const model = scriptedModel([INSPECT, PLAN("continue", "Inspect first."), TEXT, ADVANCE(600), PLAN("continue", "Waited for the inspection."), TEXT, PLAN("stop", "Nothing useful remains."), TEXT]);
    const { store } = setup({ maxCycles: 5 });
    const final = await controller(store, sim, model).run();

    expect(final).toMatchObject({ status: "completed", stopReason: "model_declared_done", cycle: 3 });
    expect(final.decisions.map((d) => d.summary)).toEqual(["Inspect first.", "Waited for the inspection.", "Nothing useful remains."]);
    expect(final.decisions[0]).toMatchObject({ actionsAccepted: 1, tools: { execute_action: 1, update_plan: 1 }, progress: true });
    expect(final.decisions[1]).toMatchObject({ advancedSeconds: 600, tools: { advance_time: 1, update_plan: 1 } });
    expect(sim.posts.map((p) => p.path)).toEqual(["/actions", "/clock/advance"]);
    expect(final.operations.map((o) => [o.tool, o.status])).toEqual([["execute_action", "applied"], ["advance_time", "applied"]]);
    expect(final.actions).toEqual([expect.objectContaining({ actionId: "act-1", type: "inspectField" })]);

    // Costs and tokens come from the scripted per-call figures (0.001 USD, 100 in / 20 out) and must add up exactly.
    expect(final.budgets.modelCalls).toBe(model.requests.length);
    expect(final.budgets.costUsd).toBeCloseTo(model.requests.length * 0.001, 9);
    expect(final.decisions.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(final.budgets.costUsd, 9);
    expect(final.usage).toMatchObject({ inputTokens: model.requests.length * 100, outputTokens: model.requests.length * 20 });
    expect(final.budgets.advancedSimSeconds).toBe(600);
    expect(buildReport(final)).toMatchObject({ actions: { submitted: 1, accepted: 1, rejected: 0 }, time: { advancedSimSeconds: 600 }, farm: { credits: { first: 12_000, delta: 0 } } });
    expect({ ...store.load("t1"), updatedAt: "" }).toEqual({ ...final, updatedAt: "" });
  });

  it("does not force update_plan: a cycle without a plan keeps the model's own text, labeled, and invents no plan", async () => {
    sim = await fakeSimulator();
    const { store } = setup();
    const final = await controller(store, sim, scriptedModel([TEXT])).run();
    expect(final.plan).toBeNull();
    expect(final.decisions[0]!.summary).toContain("no plan recorded");
  });

  it("never persists credentials", async () => {
    sim = await fakeSimulator();
    const { store, dir } = setup();
    await controller(store, sim, scriptedModel([INSPECT, PLAN("stop"), TEXT])).run();
    const text = readFileSync(join(dir, "t1", "state.json"), "utf8");
    expect(text).not.toContain("test-agent-token-SECRET");
    expect(text.toLowerCase()).not.toContain("bearer");
  });

  it("resumes after a process restart without repeating completed actions or charging twice", async () => {
    sim = await fakeSimulator();
    const { dir, store } = setup({ maxCycles: 6 }, true, { horizonDays: 200 });
    const first = await controller(store, sim, scriptedModel([INSPECT, PLAN("continue"), TEXT]), { sliceCycles: 1 }).run();
    expect(first).toMatchObject({ status: "paused", stopReason: "slice_complete", cycle: 1 });
    expect(sim.state.accepted).toBe(1);

    // New process: fresh store object and controller over the same directory.
    const restarted = new SessionStore(dir, 5_000);
    const model = scriptedModel([ADVANCE(300), PLAN("stop"), TEXT]);
    const final = await controller(restarted, sim, model).run();
        expect(final).toMatchObject({ status: "completed", cycle: 2, stopReason: "model_declared_done" });
    expect(sim.state.accepted).toBe(1);
    expect(sim.posts.filter((p) => p.path === "/actions")).toHaveLength(1);
    expect(final.budgets.acceptedMutations).toBe(1);
    expect(final.budgets.modelCalls).toBe(6);
    expect(final.config.planning).toEqual({ policyVersion: "phase5c-v1", horizonDays: 200 });
    // The resumed cycle was shown the earlier plan and decision, and told the action is in flight.
    const brief = String(model.requests[0]!.messages.at(-1)!.content);
    expect(brief).toContain("plan continue");
    expect(brief).toContain("act-1");
    expect(brief).toContain('"configuredHorizonDays":200');
  });

  it("refuses to resume a stopped session", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxModelCalls: 3 });
    const stopped = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT])).run();
    expect(stopped.status).toBe("stopped");
    await expect(controller(store, sim, scriptedModel([TEXT])).run()).rejects.toThrow(/cannot be resumed/);
  });
});

describe("MOCKED autonomy: single session owner", () => {
  it("refuses a second controller while the first owns the session, and allows it afterwards", async () => {
    sim = await fakeSimulator();
    const { store } = setup();
    const held = store.acquire("t1");
    await expect(controller(store, sim, scriptedModel([TEXT])).run()).rejects.toBeInstanceOf(SessionLockedError);
    held.release();
    const final = await controller(store, sim, scriptedModel([PLAN("stop"), TEXT])).run();
    expect(final.status).toBe("completed");
    expect(store.acquire("t1")).toBeDefined();
  });

  it("takes over a lock whose owner process is gone and rejects saves from a displaced owner", () => {
    const { dir, store } = setup();
    writeFileSync(join(dir, "t1", "lock.json"), JSON.stringify({ ownerId: "dead", pid: 2_147_483_000, host: hostname(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    const lock = store.acquire("t1");
    writeFileSync(join(dir, "t1", "lock.json"), JSON.stringify({ ownerId: "someone-else", pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    expect(() => lock.save(store.load("t1"))).toThrow(SessionLockLostError);
  });
});

describe("MOCKED autonomy: consistent observations", () => {
  it("detects a mixed-revision read, discards it and retries until the parts agree", async () => {
    let fieldReads = 0;
    sim = await fakeSimulator((req) => (req.url.endsWith("/fields") && ++fieldReads === 1 ? { status: 200, body: { ...fieldObservations, revision: 9 } } : undefined));
    const snapshot = await collectSnapshot(sim.client, GAME_ID, { retryDelayMs: 1 });
    expect(snapshot).toMatchObject({ revision: 4, rounds: 2, mixedRevisionsDetected: 1 });
    expect(snapshot.fields.revision).toBe(snapshot.overview.revision);
  });

  it("reports uncertainty instead of merging when no consistent snapshot can be read, and pauses without asking the model", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/fields") ? { status: 200, body: { ...fieldObservations, revision: 9 } } : undefined));
    await expect(collectSnapshot(sim.client, GAME_ID, { retryDelayMs: 1 })).rejects.toBeInstanceOf(InconsistentObservationError);
    const { store } = setup();
    const model = scriptedModel([TEXT]);
    const final = await controller(store, sim, model, { retryDelayMs: 1 }).run();
    expect(final).toMatchObject({ status: "paused", stopReason: "inconsistent_observation" });
    expect(model.requests).toHaveLength(0);
    expect(sim.posts).toHaveLength(0);
  });

  it("keeps measurement freshness separate from snapshot consistency and does not fabricate unavailable finance", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/overview") ? { status: 200, body: { ...overview, finance: { authorized: false } } } : undefined));
    const snapshot = await collectSnapshot(sim.client, GAME_ID);
    const summary = summarizeSnapshot(snapshot);
    expect(summary).toMatchObject({ credits: null, realizedRevenue: null, realizedCosts: null });
    expect(summary.fields[0]).toMatchObject({ fieldId: "field-1", knownCrop: "corn" });
    expect(snapshot.fields.fields[0]!.knownCrop).toMatchObject({ freshness: "stale", ageS: 72_800 });
    const model = scriptedModel([PLAN("stop"), TEXT]);
    const { store } = setup({}, false);
    await controller(store, sim, model).run();
    expect(String(model.requests[0]!.messages.at(-1)!.content)).toContain('"freshness":"stale"');
  });

  it("serves the second read from cache when the game has not changed", async () => {
    sim = await fakeSimulator();
    const { store } = setup({}, false);
    const model = scriptedModel([{ calls: [{ name: "observe_snapshot" }, { name: "observe_snapshot" }] }, PLAN("stop"), TEXT]);
    const final = await controller(store, sim, model).run();
    expect(final.metrics.snapshotCacheHits).toBeGreaterThanOrEqual(2);
    const fieldReads = sim.server.requests.filter((r) => r.url.endsWith("/fields")).length;
    expect(fieldReads).toBe(final.metrics.snapshotRefreshes);
  });
});

describe("MOCKED autonomy: budgets and loop prevention", () => {
  const cases: Array<[string, Partial<SessionLimits>, ScriptedStep[], string]> = [
    ["model calls", { maxModelCalls: 3 }, [PLAN("continue"), TEXT], "model_call_budget_exhausted"],
    ["cost", { maxCostUsd: 0.002 }, [PLAN("continue"), TEXT], "cost_budget_exhausted"],
    ["tool calls", { maxToolCalls: 2 }, [INSPECT, PLAN("continue"), TEXT], "tool_call_budget_exhausted"],
    ["cycles", { maxCycles: 2, maxConsecutiveNoProgress: 9 }, [PLAN("continue"), TEXT], "cycle_budget_exhausted"],
    ["wall clock", { maxWallClockMs: 1 }, [PLAN("continue"), TEXT], "wall_clock_exhausted"],
    ["simulated time", { maxSimSeconds: 600, maxMutations: 5 }, [ADVANCE(600), PLAN("continue"), TEXT], "sim_time_limit_reached"],
  ];
  it.each(cases)("stops safely when the %s budget is reached and does not resume past it", async (_name, limits, steps, reason) => {
    sim = await fakeSimulator();
    const { store } = setup(limits);
    const final = await controller(store, sim, scriptedModel(steps), { retryDelayMs: 1 }).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: reason });
    await expect(controller(store, sim, scriptedModel([TEXT])).run()).rejects.toThrow(/cannot be resumed/);
  });

  it("stops on the mutation budget once the action has finished", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/actions/act-1") ? { status: 200, body: { gameId: GAME_ID, action: { ...executeAccepted.action, status: "completed", progress: 1, finishedAtS: 1 } } } : completedEvents(req)));
    const { store } = setup({ maxMutations: 1 });
    const final = await controller(store, sim, scriptedModel([INSPECT, PLAN("continue"), TEXT])).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: "mutation_budget_exhausted", budgets: { acceptedMutations: 1 } });
    expect(sim.state.accepted).toBe(1);
  });

  it("never executes more mutations than budgeted even if the model keeps asking", async () => {
    sim = await fakeSimulator((req) => completedEvents(req));
    const { store } = setup({ maxMutations: 1, maxCycles: 4 });
    const final = await controller(store, sim, scriptedModel([INSPECT, INSPECT, PLAN("continue"), TEXT])).run();
    expect(sim.state.accepted).toBe(1);
    expect(final.budgets.acceptedMutations).toBe(1);
  });

  it("stops an observe/plan loop that makes no progress", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 8 });
    const final = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT])).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: "no_progress", cycle: 3 });
    expect(final.decisions.every((d) => !d.progress)).toBe(true);
  });

  it("stops after repeated rejected actions", async () => {
    const rejected = { gameId: GAME_ID, revision: 4, accepted: false, dryRun: false, action: null, errors: [{ code: "insufficient_credits", detail: "Not enough credits." }], asynchronous: false };
    sim = await fakeSimulator((req) => (req.method === "POST" ? { status: 422, body: rejected } : undefined));
    const { store } = setup({ maxConsecutiveRejections: 3, maxCycles: 8 });
    const final = await controller(store, sim, scriptedModel([INSPECT, PLAN("continue"), TEXT, INSPECT, PLAN("continue"), TEXT, INSPECT, PLAN("continue"), TEXT])).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: "repeated_rejections", budgets: { rejectedActions: 3, acceptedMutations: 0 } });
  });

  it("completes when the simulator offers no eligible action and nothing is running", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/actions") ? { status: 200, body: { ...availableActions, actions: availableActions.actions.map((a) => ({ ...a, eligibility: { eligible: false, issues: [{ code: "no_equipment", detail: "x" }] } })) } } : undefined));
    const { store } = setup();
    const model = scriptedModel([TEXT]);
    const final = await controller(store, sim, model).run();
    expect(final).toMatchObject({ status: "completed", stopReason: "no_eligible_actions" });
    expect(model.requests).toHaveLength(0);
  });

  it("is observe-only by default: one cycle, mutation tools unavailable and never executed", async () => {
    sim = await fakeSimulator();
    const { store } = setup({}, false);
    const model = scriptedModel([INSPECT, PLAN("continue"), TEXT]);
    const final = await controller(store, sim, model, { mutationsEnabled: false }).run();
    expect(final).toMatchObject({ status: "completed", stopReason: "observe_only_complete" });
    expect(model.requests[0]!.tools!.map((t) => ("function" in t ? t.function.name : ""))).not.toContain("execute_action");
    expect(sim.posts).toHaveLength(0);
  });

  it("does not report an observe-only session as complete when the model call failed", async () => {
    sim = await fakeSimulator();
    const { store } = setup({}, false);
    const model = scriptedModel([{ throws: new ModelApiError("Model API error (HTTP 404 model_not_found) after 4 attempts.", "bad_request", 404, { code: "model_not_found" }) }]);
    const final = await controller(store, sim, model, { mutationsEnabled: false }).run();
    expect(final).toMatchObject({ status: "failed", stopReason: "model_error" });
    expect(final.stopDetail).toMatch(/HTTP 404 model_not_found/);
    expect(final.budgets.modelCalls).toBe(0);
    expect(final.decisions.at(-1)).toMatchObject({ stopReason: "model_error" });
  });

  it("does not enable mutations on resume unless the caller confirms again", async () => {
    sim = await fakeSimulator();
    const { store } = setup();
    const model = scriptedModel([PLAN("continue"), TEXT]);
    await controller(store, sim, model, { mutationsEnabled: false }).run();
    expect(model.requests[0]!.tools!.map((t) => ("function" in t ? t.function.name : ""))).not.toContain("advance_time");
  });
});

describe("MOCKED autonomy: failures", () => {
  it("pauses (resumable) after consecutive failed model calls and records no fabricated decision", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveErrors: 3 });
    const model = scriptedModel([{ throws: new ModelApiError("Model API error (HTTP 503).", "server", 503) }]);
    const final = await controller(store, sim, model).run();
    expect(final).toMatchObject({ status: "paused", stopReason: "consecutive_errors", cycle: 3 });
    expect(final.decisions.every((d) => d.summary.startsWith("(no decision summary produced"))).toBe(true);
    expect(final.budgets.costUsd).toBe(0);
    expect(store.acquire("t1")).toBeDefined();
  });

  it("pauses on a model authentication failure", async () => {
    sim = await fakeSimulator();
    const { store } = setup();
    const final = await controller(store, sim, scriptedModel([{ throws: new ModelApiError("Model API error (HTTP 401).", "auth", 401) }])).run();
    expect(final).toMatchObject({ status: "paused", stopReason: "authentication_failure", cycle: 1 });
  });

  it("pauses on a simulator authentication failure before asking the model anything", async () => {
    sim = await fakeSimulator((req) => (req.method === "GET" ? { status: 401, body: { error: "expired", code: "unauthenticated" } } : undefined));
    const { store } = setup();
    const model = scriptedModel([TEXT]);
    const final = await controller(store, sim, model).run();
    expect(final).toMatchObject({ status: "paused", stopReason: "authentication_failure" });
    expect(model.requests).toHaveLength(0);
  });

  it("returns a structured conflict on a stale revision, lets the model re-observe, and then succeeds once", async () => {
    let conflicted = false;
    sim = await fakeSimulator((req) => (req.method === "POST" && !conflicted ? ((conflicted = true), { status: 409, body: { error: "stale", code: "stale_revision", currentRevision: 4 } }) : undefined));
    const { store } = setup();
    const model = scriptedModel([INSPECT, { calls: [{ name: "observe_snapshot" }] }, INSPECT, PLAN("continue"), TEXT]);
    const final = await controller(store, sim, model, { sliceCycles: 1 }).run();
    const firstResult = JSON.parse(String((model.requests[1]!.messages.at(-1) as { content: string }).content)) as { error: { code: string } };
    expect(firstResult.error.code).toBe("stale_revision");
    expect(final.operations.map((o) => o.status)).toEqual(["not_applied", "applied"]);
    expect(final.budgets).toMatchObject({ acceptedMutations: 1, rejectedActions: 0 });
    expect(sim.state.accepted).toBe(1);
  });

  it("rejects invalid tool arguments without touching the simulator", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxCycles: 1 });
    const model = scriptedModel([{ calls: [{ name: "execute_action", rawArguments: '{"type":7}' }] }, { calls: [{ name: "update_plan", args: { summary: "x", nextStep: "stop" } }] }, TEXT]);
    await controller(store, sim, model).run();
    const bodies = [1, 2].map((i) => JSON.parse(String((model.requests[i]!.messages.at(-1) as { content: string }).content)) as { error: { code: string } });
    expect(bodies.map((b) => b.error.code)).toEqual(["invalid_arguments", "invalid_arguments"]);
    expect(sim.posts).toHaveLength(0);
  });
});

describe("MOCKED autonomy: crash and timeout recovery for mutations", () => {
  const pendingFor = (key: string, expectedRevision: number) => ({
    tool: "execute_action" as const,
    idempotencyKey: key,
    expectedRevision,
    request: { type: "inspectField", params: { fieldId: "field-1" }, expectedRevision, dryRun: false, idempotencyKey: key },
    rationale: "recorded before sending",
    recordedAt: new Date().toISOString(),
    cycle: 1,
  });
  const KEY = "00000000-0000-4000-8000-0000000000aa";
  const seedPending = (store: SessionStore, state: SessionState, expectedRevision = 4) => {
    const lock = store.acquire("t1");
    lock.save({ ...state, cycle: 1, status: "paused", pendingMutation: pendingFor(KEY, expectedRevision) });
    lock.release();
  };

  it("replays the exact payload with the same key after a crash that followed the simulator commit: one action, one charge", async () => {
    sim = await fakeSimulator();
    const { store, state } = setup();
    seedPending(store, state);
    // The simulator had committed the request before the process died.
    await sim.client.executeAction(GAME_ID, pendingFor(KEY, 4).request as never);
    expect(sim.state.accepted).toBe(1);

    const final = await controller(store, sim, scriptedModel([PLAN("stop"), TEXT])).run();
    expect(sim.state.accepted).toBe(1);
    expect(sim.state.replays).toBe(1);
    const posts = sim.posts.filter((p) => p.path === "/actions");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(final.pendingMutation).toBeNull();
    expect(final.operations).toEqual([expect.objectContaining({ idempotencyKey: KEY, status: "applied", via: "reconciled" })]);
    expect(final.budgets.acceptedMutations).toBe(1);
    expect(final.actions).toHaveLength(1);
  });

  it("executes a recorded-but-never-sent request exactly once with its original key", async () => {
    sim = await fakeSimulator();
    const { store, state } = setup();
    seedPending(store, state);
    const final = await controller(store, sim, scriptedModel([PLAN("stop"), TEXT])).run();
    expect(sim.state.accepted).toBe(1);
    expect(sim.posts[0]!.body.idempotencyKey).toBe(KEY);
    expect(final.operations[0]).toMatchObject({ status: "applied", via: "reconciled" });
  });

  it("treats a stale-revision refusal during reconciliation as not applied and never re-executes it", async () => {
    sim = await fakeSimulator();
    sim.state.revision = 9;
    const { store, state } = setup();
    seedPending(store, state, 4);
    const final = await controller(store, sim, scriptedModel([PLAN("stop"), TEXT])).run();
    expect(sim.state.accepted).toBe(0);
    expect(final.pendingMutation).toBeNull();
    expect(final.operations[0]).toMatchObject({ status: "not_applied", via: "reconciled" });
    expect(final.budgets.acceptedMutations).toBe(0);
  });

  it("recovers from a lost response inside a cycle by retrying the same key (no double charge)", async () => {
    sim = await fakeSimulator(undefined, 150, 1);
    const { store } = setup();
    const final = await controller(store, sim, scriptedModel([INSPECT, PLAN("stop"), TEXT])).run();
    const posts = sim.posts.filter((p) => p.path === "/actions");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.idempotencyKey).toBe(posts[0]!.body.idempotencyKey);
    expect(sim.state.accepted).toBe(1);
    expect(sim.state.replays).toBe(1);
    expect(final).toMatchObject({ status: "completed", budgets: { acceptedMutations: 1 } });
    expect(final.pendingMutation).toBeNull();
  });

  it("pauses with an unresolved mutation, keeps the key and payload, and does not ask the model to act again", async () => {
    sim = await fakeSimulator((req) => (req.method === "POST" ? { status: 503, body: { error: "down", code: "unavailable" } } : undefined));
    const { store } = setup();
    const model = scriptedModel([INSPECT, PLAN("continue"), TEXT]);
    const final = await controller(store, sim, model, { sliceCycles: 5 }).run();
    expect(final).toMatchObject({ status: "paused", stopReason: "unresolved_mutation" });
    expect(final.pendingMutation).toMatchObject({ tool: "execute_action", idempotencyKey: expect.any(String) });
    const keys = new Set(sim.posts.map((p) => p.body.idempotencyKey));
    expect(keys.size).toBe(1);
    const modelCallsAtPause = model.requests.length;
    expect(final.cycle).toBe(1);
    expect(modelCallsAtPause).toBe(3);

    // Later the simulator recovers: resume reconciles with the same key before anything else.
    await sim.close();
    sim = await fakeSimulator();
    const lock = store.acquire("t1");
    lock.release();
    const resumed = await controller(store, sim, scriptedModel([PLAN("stop"), TEXT])).run();
    expect(sim.posts[0]!.body.idempotencyKey).toBe(final.pendingMutation!.idempotencyKey);
    expect(resumed.pendingMutation).toBeNull();
    expect(sim.state.accepted).toBe(1);
  });
});

describe("MOCKED autonomy: compact action catalog", () => {
  const manyActions = () => {
    const base = availableActions.actions[0]!;
    const types = ["inspectField", "irrigateField", "plantCrop", "harvestField", "fertilizeField", "treatPests"];
    const actions = types.flatMap((type, t) =>
      Array.from({ length: 5 }, (_v, i) => ({
        ...base,
        type,
        label: `Label ${type}`,
        description: `${type} does something useful on a field. It has a long explanation that the model rarely needs again each cycle. `.repeat(3),
        target: { kind: "field", id: `field-${i + 1}`, label: `Field ${i + 1}` },
        parametersSchema: { type: "object", properties: { fieldId: { type: "string" }, volumeM3: { type: "number", exclusiveMinimum: 0, maximum: 1000 } }, required: ["fieldId"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
        preconditions: ["Field must exist.", "Equipment must be idle.", "Enough credits."],
        eligibility: t === 2 && i === 0 ? { eligible: false, issues: [{ code: "insufficient_credits", detail: "Not enough credits for this." }] } : { eligible: true, issues: [] },
      })),
    );
    return { ...availableActions, actions } as unknown as AvailableActions;
  };

  it("is much smaller than the raw catalog yet keeps types, eligibility, reasons and parameter hints", () => {
    const raw = manyActions();
    const compact = compactCatalog(raw);
    const rawSize = JSON.stringify(raw).length;
    const compactSize = JSON.stringify(compact).length;
    expect(compactSize).toBeLessThan(rawSize * 0.5);
    expect(compact.actions.map((a) => a.type)).toEqual(["inspectField", "irrigateField", "plantCrop", "harvestField", "fertilizeField", "treatPests"]);
    const plant = compact.actions.find((a) => a.type === "plantCrop")!;
    expect(plant.eligibleTargets).toHaveLength(4);
    expect(plant.ineligibleTargets).toEqual([{ target: "field-1", why: "insufficient_credits" }]);
    expect(plant.params).toEqual(["fieldId*:string", "volumeM3:number(>0,<=1000)"]);
    expect(compact.eligibleOptions).toBe(29);
  });

  it("returns the simulator's exact schema and eligibility details on demand without inventing actions", () => {
    const raw = manyActions();
    const detail = describeAction(raw, "irrigateField")!;
    expect(detail.parameterSchemas).toHaveLength(1);
    expect(detail.parameterSchemas[0]!.schema).toMatchObject({ required: ["fieldId"], additionalProperties: false });
    expect(detail.parameterSchemas[0]!.schema).not.toHaveProperty("$schema");
    expect(detail.preconditions).toHaveLength(3);
    expect(detail.targets).toHaveLength(5);
    expect(describeAction(raw, "teleportCow")).toBeNull();
  });
});
