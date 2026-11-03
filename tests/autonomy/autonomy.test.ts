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
import { SpendLimitError } from "../../src/model/spendGuard.js";
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

// Generic "accepted mutating action" stand-in for budget/crash-recovery mechanics tests (the fake simulator always
// returns a canned "accepted" response regardless of the submitted type, so any real mutating type works here).
const INSPECT: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "irrigateField", params: { fieldId: "field-1" }, rationale: "Moisture is stale." } }] };
const ADVANCE = (seconds = 600): ScriptedStep => ({ calls: [{ name: "advance_time", args: { requestedSeconds: seconds, stopOn: ["action_completion"] } }] });
const PLAN = (nextStep: "continue" | "wait_for_actions" | "stop", summary = `plan ${nextStep}`): ScriptedStep => ({
  calls: [{ name: "update_plan", args: { summary, nextStep, priorities: ["verify moisture"], ...(nextStep === "stop" ? { stopReason: "nothing useful left" } : {}) } }],
});
const TEXT: ScriptedStep = { content: "ok" };

function setup(limits: Partial<SessionLimits> = {}, mutationsEnabled = true, planning: { horizonDays?: number | null } = {}, autonomyMode: "legacy" | "continuous" = "legacy") {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-"));
  dirs.push(dir);
  const store = new SessionStore(dir, 5_000);
  // These tests pin the per-cycle continuous semantics; the daily scheduler has its own suite (dailyScheduler.test.ts).
  const state = newSessionState({ sessionId: "t1", gameId: GAME_ID, modelId: "muse-spark-1.3", mutationsEnabled, limits, planning, autoWait: false, autonomyMode, scheduler: { enabled: false } });
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
    expect(final.actions).toEqual([expect.objectContaining({ actionId: "act-1", type: "irrigateField" })]);

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

  it("refuses to resume a legacy session stopped by a non-budget safety guard", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 1 });
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
    sim = await fakeSimulator((req) => (/\/fields(\?|$)/.test(req.url) && ++fieldReads === 1 ? { status: 200, body: { ...fieldObservations, revision: 9 } } : undefined));
    const snapshot = await collectSnapshot(sim.client, GAME_ID, { retryDelayMs: 1 });
    expect(snapshot).toMatchObject({ revision: 4, rounds: 2, mixedRevisionsDetected: 1 });
    expect(snapshot.fields.revision).toBe(snapshot.overview.revision);
  });

  it("reports uncertainty instead of merging when no consistent snapshot can be read, and pauses without asking the model", async () => {
    sim = await fakeSimulator((req) => (/\/fields(\?|$)/.test(req.url) ? { status: 200, body: { ...fieldObservations, revision: 9 } } : undefined));
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
    const fieldReads = sim.server.requests.filter((r) => /\/fields(\?|$)/.test(r.url)).length;
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
    expect(final).toMatchObject({ status: "paused", lifecycle: "awaiting_budget", stopReason: reason });
    const next = await controller(store, sim, scriptedModel([TEXT])).run();
    expect(next).toMatchObject({ lifecycle: "awaiting_budget", stopReason: reason });
  });

  it("counts failed logical model calls against authorization without charging retries as extra logical calls", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxModelCalls: 1, maxConsecutiveErrors: 10 });
    const model = scriptedModel([{ throws: new ModelApiError("Model API error (HTTP 503).", "server", 503) }]);
    const final = await controller(store, sim, model).run();
    expect(final).toMatchObject({ lifecycle: "awaiting_budget", stopReason: "model_call_budget_exhausted", budgets: { modelCalls: 0, failedModelCalls: 1 } });
    expect(model.requests).toHaveLength(1);
    expect(final.stopDetail).toContain("1/1 logical calls");
  });

  it("stops on the mutation budget once the action has finished", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/actions/act-1") ? { status: 200, body: { gameId: GAME_ID, action: { ...executeAccepted.action, status: "completed", progress: 1, finishedAtS: 1 } } } : completedEvents(req)));
    const { store } = setup({ maxMutations: 1 });
    const final = await controller(store, sim, scriptedModel([INSPECT, PLAN("continue"), TEXT])).run();
    expect(final).toMatchObject({ status: "paused", lifecycle: "awaiting_budget", stopReason: "mutation_budget_exhausted", budgets: { acceptedMutations: 1 } });
    expect(sim.state.accepted).toBe(1);
  });

  it("never executes more mutations than budgeted even if the model keeps asking", async () => {
    sim = await fakeSimulator((req) => completedEvents(req));
    const { store } = setup({ maxMutations: 1, maxCycles: 4 });
    const final = await controller(store, sim, scriptedModel([INSPECT, INSPECT, PLAN("continue"), TEXT])).run();
    expect(sim.state.accepted).toBe(1);
    expect(final.budgets.acceptedMutations).toBe(1);
  });

  it("enforces the inspection budget independently: an observation-only action does not spend the farm-mutation budget", async () => {
    sim = await fakeSimulator((req) => completedEvents(req));
    const SURVEY: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "inspectField", params: { fieldId: "field-1" }, rationale: "Stale moisture reading before deciding." } }] };
    const { store } = setup({ maxMutations: 1, maxInspections: 1, maxCycles: 4 });
    const final = await controller(store, sim, scriptedModel([SURVEY, PLAN("continue", "Inspected."), TEXT, INSPECT, PLAN("stop", "Irrigated after inspecting."), TEXT])).run();
    // The inspection (cycle 1) left the full mutation budget available for the real farm action (cycle 2).
    expect(final.budgets).toMatchObject({ acceptedInspections: 1, inspectionAttempts: 1, acceptedMutations: 1, mutationAttempts: 1, rejectedActions: 0 });
    expect(final).toMatchObject({ status: "completed", stopReason: "model_declared_done" });
  });

  it("stops an observe/plan loop that makes no progress, naming what failed to advance", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 8 });
    const final = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT])).run();
    expect(final).toMatchObject({ status: "stopped", stopReason: "no_progress", cycle: 3 });
    expect(final.decisions.every((d) => !d.progress)).toBe(true);
    expect(final.stopDetail).toMatch(/3 consecutive cycles without progress: no server time was granted.*no action or inspection was accepted.*eligible actions did not change.*Continuing would spend model calls/);
  });

  it("does not stop a long crop-growth wait: granted simulated time counts as progress across many cycles", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 10, maxSimSeconds: 100_000, maxAdvanceRequests: 20, maxConsecutiveAdvances: 20 });
    const wait = [ADVANCE(600), PLAN("continue", "Crops are still developing."), TEXT];
    const final = await controller(store, sim, scriptedModel([...wait, ...wait, ...wait, ...wait, ...wait, ...wait, PLAN("stop", "Nothing left."), TEXT])).run();
    expect(final.stopReason).not.toBe("no_progress");
    expect(final.budgets.acceptedMutations).toBe(0);
  });

  it("does not penalize positive-time crop waiting with the zero-time advance safeguard", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 20, maxSimSeconds: 100_000, maxAdvanceRequests: 20, maxConsecutiveAdvances: 3 });
    const wait = [ADVANCE(600), PLAN("continue"), TEXT];
    const final = await controller(store, sim, scriptedModel([...wait, ...wait, ...wait, ...wait])).run();
    expect(final.stopReason).not.toBe("zero_time_advance_limit");
    expect(final.budgets.advancedSimSeconds).toBeGreaterThan(0);
  });

  it("counts an accepted inspection and a field-attention warning as progress without any mutation", async () => {
    sim = await fakeSimulator((req) => {
      if (req.url.includes("/events") && /cursor=0\b/.test(req.url)) {
        return { status: 200, body: { gameId: GAME_ID, clock, events: [{ eventId: 7, simTimeS: clock.simTimeS, kind: "field_attention", actionId: null, summary: "attention", data: { fieldId: "field-1", category: "crop_water_stress", level: 2 } }], nextCursor: 7 } };
      }
      return undefined;
    });
    const { store } = setup({ maxConsecutiveNoProgress: 2, maxCycles: 3 });
    const final = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT])).run();
    expect(final.decisions.length, `${final.stopReason}: ${final.stopDetail}`).toBeGreaterThan(0);
    expect(final.decisions[0]!.progressReasons).toContain("field_attention");
    expect(final.decisions[0]!.progress).toBe(true);
    expect(final).toMatchObject({ stopReason: "no_progress", cycle: 3 }); // the warning bought one cycle, not an unlimited pass
  });

  it("does not credit an unchanged or replayed field_attention warning again", async () => {
    sim = await fakeSimulator((req) =>
      req.url.includes("/events") ? { status: 200, body: { gameId: GAME_ID, clock, events: [{ eventId: 7, simTimeS: clock.simTimeS, kind: "field_attention", actionId: null, summary: "attention", data: { fieldId: "field-1", category: "crop_water_stress", level: 2 } }], nextCursor: 7 } } : undefined,
    );
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 8 });
    const final = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT])).run();
    expect(final.decisions.map((d) => d.progress)).toEqual([true, false, false, false]);
    expect(final).toMatchObject({ stopReason: "no_progress", cycle: 4 });
  });

  it("counts an accepted inspection as progress even though no farm mutation happens", async () => {
    sim = await fakeSimulator();
    const SURVEY: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "inspectField", params: { fieldId: "field-1" }, rationale: "Stale moisture reading before deciding." } }] };
    const { store } = setup({ maxInspections: 1, maxConsecutiveNoProgress: 1, maxCycles: 4 });
    const final = await controller(store, sim, scriptedModel([SURVEY, PLAN("continue", "Inspected."), TEXT])).run();
    expect(final.budgets).toMatchObject({ acceptedInspections: 1, acceptedMutations: 0 });
    expect(final.decisions[0]!.progress).toBe(true);
    expect(final.decisions[0]!.progressReasons).toEqual(expect.arrayContaining(["inspection_accepted"]));
    expect(final.decisions[0]!.progressReasons).not.toContain("action_accepted");
    expect(final.decisions[1]!.progress).toBe(false); // with a limit of 1, only the inspection cycle was spared
  });

  describe("eligibility changes", () => {
    // Eligibility changes only once the game revision moves (a snapshot is reused while revision and time are unchanged).
    const changingEligibility = () =>
      fakeSimulator((req, state) => {
        if (req.method !== "GET" || !req.url.split("?")[0]!.endsWith("/actions")) return undefined;
        const first = availableActions.actions.find((a) => a.eligibility.eligible)!;
        const spare = { ...first, type: "spareAction" }; // keeps one action eligible so the session is not completed
        return { status: 200, body: { ...availableActions, revision: state.revision, simTimeS: state.simTimeS, actions: [spare, ...availableActions.actions].map((a) => (state.revision > 4 && a.type === first.type ? { ...a, eligibility: { eligible: false, issues: [{ code: "not_ready", detail: "x" }] } } : a)) } };
      });

    it("counts a genuine change in eligible actions as progress", async () => {
      sim = await changingEligibility();
      const { store } = setup({ maxConsecutiveNoProgress: 5, maxCycles: 3, maxSimSeconds: 100_000, maxAdvanceRequests: 5 });
      const final = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT, ADVANCE(600), PLAN("continue"), TEXT, PLAN("continue"), TEXT])).run();
      expect(final.decisions.length, `${final.stopReason}: ${final.stopDetail}`).toBe(3); expect(final.decisions[0]!.progressReasons).not.toContain("eligible_actions_changed"); // first observation is only a baseline
      expect(final.decisions[1]!.progressReasons).not.toContain("eligible_actions_changed"); // snapshot predates the advance
      expect(final.decisions[2]!.progressReasons).toEqual(["eligible_actions_changed"]);
    });

    it("treats the first observation after a restart as a baseline, not as a change", async () => {
      sim = await changingEligibility();
      const { store } = setup({ maxConsecutiveNoProgress: 5, maxCycles: 4 });
      await controller(store, sim, scriptedModel([PLAN("continue"), TEXT]), { sliceCycles: 1 }).run();
      sim.state.revision = 5; // the world changed while the worker was down
      // A new controller is a restarted worker: it has no memory of the previous eligibility.
      const resumed = await controller(store, sim, scriptedModel([PLAN("continue"), TEXT]), { sliceCycles: 1 }).run();
      expect(resumed.decisions).toHaveLength(2);
      expect(resumed.decisions[1]!.progressReasons).not.toContain("eligible_actions_changed");
    });
  });

  it("does not credit empty model responses or blocked execution as progress", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCycles: 8, maxConsecutiveErrors: 10 });
    const final = await controller(store, sim, scriptedModel([{ content: null }])).run();
    expect(final.stopReason).toBe("no_progress");
    expect(final.decisions.every((d) => !d.progress)).toBe(true);
    expect(final.stopDetail).toMatch(/3 cycle\(s\) ended without a usable model decision/);
  });

  it("stops after repeated rejected actions", async () => {
    const rejected = { gameId: GAME_ID, revision: 4, accepted: false, dryRun: false, action: null, errors: [{ code: "insufficient_credits", detail: "Not enough credits." }], asynchronous: false };
    sim = await fakeSimulator((req) => (req.method === "POST" && req.url.includes("/actions") ? { status: 422, body: rejected } : undefined));
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
    expect(final.budgets.failedModelCalls).toBe(1);
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
    // Repeated failures never consume the model-call budget, but they are counted separately so they remain observable.
    expect(final.budgets).toMatchObject({ modelCalls: 0, failedModelCalls: 3 });
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
    request: { type: "irrigateField", params: { fieldId: "field-1" }, expectedRevision, dryRun: false, idempotencyKey: key },
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

describe("MOCKED continuous autonomous lifecycle", () => {
  const planReviewAt = (simTimeS: number): ScriptedStep => ({
    calls: [{ name: "update_plan", args: { summary: "Wait for crop review", nextStep: "continue", priorities: ["review growth"], nextReviewSimSeconds: simTimeS } }],
  });

  it("continues beyond 24 cycles and past every lifetime quota without stopping", async () => {
    sim = await fakeSimulator();
    const steps = [...Array.from({ length: 25 }, () => [PLAN("continue"), TEXT]).flat(), PLAN("stop", "Harvest and sale objective complete."), TEXT];
    const model = scriptedModel(steps);
    const { store } = setup({ maxCycles: 2, maxModelCalls: 3, maxToolCalls: 3, maxWallClockMs: 1_000, maxMutations: 1, maxInspections: 0, maxAdvanceRequests: 1, maxCostUsd: 1, maxConsecutiveNoProgress: 100 }, true, {}, "continuous");

    const completed = await controller(store, sim, model).run();
    expect(completed).toMatchObject({ status: "completed", lifecycle: "completed", cycle: 26, stopReason: "model_declared_done" });
    expect(completed.budgets.modelCalls).toBe(52);
  });

  it("keeps counting model and tool calls past 200 and 600 without a lifetime stop", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([...Array.from({ length: 105 }, () => [PLAN("continue"), TEXT]).flat(), PLAN("stop", "done"), TEXT]);
    const { store } = setup({ maxCycles: 5, maxModelCalls: 200, maxToolCalls: 600, maxCostUsd: 1, maxConsecutiveNoProgress: 1_000 }, true, {}, "continuous");
    const final = await controller(store, sim, model).run();
    expect(final.stopReason).toBe("model_declared_done");
    expect(final.budgets.modelCalls).toBeGreaterThan(200);
    expect(final.cycle).toBe(106);
  }, 60_000);

  it("enforces an explicit spending cap strictly and lets unlimited spending run past it only when chosen", async () => {
    sim = await fakeSimulator();
    const costly = (): ScriptedStep[] => [{ calls: [{ name: "update_plan", args: { summary: "s", nextStep: "continue", priorities: ["p"] } }], costUsd: 0.01 }, { content: "ok", costUsd: 0.01 }];
    const capped = setup({ maxCostUsd: 0.05, maxConsecutiveNoProgress: 100 }, true, {}, "continuous");
    const stopped = await controller(capped.store, sim, scriptedModel(Array.from({ length: 10 }, costly).flat())).run();
    expect(stopped).toMatchObject({ status: "paused", lifecycle: "awaiting_budget", stopReason: "cost_budget_exhausted" });
    expect(stopped.budgets.costUsd).toBeGreaterThanOrEqual(0.05);

    const open = setup({ maxCostUsd: 0.05, unlimitedSpending: true, maxConsecutiveNoProgress: 100 }, true, {}, "continuous");
    const steps = [...Array.from({ length: 8 }, costly).flat(), PLAN("stop", "done"), TEXT];
    const done = await controller(open.store, sim, scriptedModel(steps)).run();
    expect(done.stopReason).toBe("model_declared_done");
    expect(done.budgets.costUsd).toBeGreaterThan(0.05);
  });

  it("preserves monotonic lifetime cycles and does not repeat model calls across bounded worker restarts", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([...Array.from({ length: 26 }, () => [PLAN("continue"), TEXT]).flat()]);
    const { store } = setup({ maxCycles: 24, maxModelCalls: 100, maxCostUsd: 1, maxConsecutiveNoProgress: 100 }, true, {}, "continuous");
    for (let n = 0; n < 26; n += 1) {
      await controller(store, sim, model, { sliceCycles: 1 }).run();
    }
    const state = store.load("t1");
    expect(state).toMatchObject({ cycle: 26, budgets: { modelCalls: 52 } });
    expect(model.requests).toHaveLength(52);
    expect(sim.posts).toHaveLength(0);
  });

  it("refuses to replay an uncertain model request after restart", async () => {
    sim = await fakeSimulator();
    const { store, state } = setup({ maxCycles: 8 });
    const lease = store.acquire("t1");
    lease.save({ ...state, cycle: 1, pendingModelCycle: 1 });
    lease.release();
    const model = scriptedModel([TEXT]);

    const resumed = await controller(store, sim, model).run();
    expect(resumed).toMatchObject({ status: "failed", lifecycle: "failed", stopReason: "model_request_outcome_unknown", pendingModelCycle: 1 });
    expect(resumed.stopDetail).toMatch(/was not replayed/);
    expect(model.requests).toHaveLength(0);
  });

  it("persists a write-ahead model-cycle marker before requests and clears it after accounting", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxCycles: 8 });
    const model = scriptedModel([PLAN("stop", "Done."), TEXT]);
    const complete = model.complete.bind(model);
    let sawPendingMarker = 0;
    model.complete = async (request) => {
      expect(store.load("t1").pendingModelCycle).toBe(1);
      sawPendingMarker += 1;
      return complete(request);
    };

    const final = await controller(store, sim, model).run();
    expect(sawPendingMarker).toBe(2);
    expect(final.pendingModelCycle).toBeNull();
  });

  it("advances long maturation checkpoints without repeated model calls and wakes at the planned review", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([planReviewAt(clock.simTimeS + 1_200), TEXT, PLAN("stop", "Review completed."), TEXT]);
    const { store } = setup({ maxCycles: 1, maxModelCalls: 4, maxCostUsd: 1, maxSimSeconds: 100, maxAdvanceRequests: 1, maxWallClockMs: 1_000, maxWaitChunkSeconds: 600 }, true, {}, "continuous");
    const waiting = await controller(store, sim, model, { sliceCycles: 1 }).run();
    expect(waiting).toMatchObject({ status: "paused", lifecycle: "waiting_for_simulation", stopReason: "waiting_for_simulation", cycle: 1, waitingUntilSimTimeS: clock.simTimeS + 1_200 });
    const callsBeforeWait = model.requests.length;
    // One slice chains the whole accelerated wait server-side and wakes the model exactly at the planned review.
    const reviewed = await controller(store, sim, model, { sliceCycles: 1 }).run();
    expect(reviewed).toMatchObject({ lifecycle: "completed", cycle: 2, stopReason: "model_declared_done" });
    expect(model.requests).toHaveLength(callsBeforeWait + 2);
    expect(reviewed.budgets.advancedSimSeconds).toBe(1_200);
  });

  it("advances a stable farm 40 simulated days in ONE slice with a single model decision, then wakes at the review", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([planReviewAt(clock.simTimeS + 2_400), TEXT, PLAN("stop", "Harvest review."), TEXT]);
    const { store } = setup({}, true, {}, "continuous");
    const waiting = await controller(store, sim, model).run();
    expect(waiting).toMatchObject({ lifecycle: "waiting_for_simulation", stopReason: "waiting_for_simulation" });
    const final = await controller(store, sim, model).run();
    expect(final.decisions).toHaveLength(2);
    expect(final.decisions.length).toBeLessThan(30);
    // The 40 days were covered by checkpoint requests recorded as waits (simulation progress), not as decisions.
    expect(final.waits.reduce((sum, w) => sum + w.advancedSeconds, 0)).toBe(2_400);
    expect(model.requests).toHaveLength(4);
  });

  it("bounds a single accelerated wait by real time, then continues in the next slice with no model call", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([planReviewAt(clock.simTimeS + 7_200), TEXT, PLAN("stop", "done"), TEXT]);
    const { store } = setup({}, true, {}, "continuous");
    let state = await controller(store, sim, model, { sliceCycles: 1, waitSliceMs: 0 }).run();
    expect(state).toMatchObject({ stopReason: "waiting_for_simulation" });
    const calls = model.requests.length;
    for (let n = 0; n < 10 && state.lifecycle === "waiting_for_simulation"; n += 1) state = await controller(store, sim, model, { waitSliceMs: 0 }).run();
    expect(state.lifecycle).toBe("completed");
    expect(model.requests).toHaveLength(calls + 2);
    expect(state.budgets.advancedSimSeconds).toBe(7_200);
  });

  it("does not allow zero-time advances to bypass the no-progress safeguards", async () => {
    sim = await fakeSimulator((req) => {
      if (req.method === "POST") {
        const body = JSON.parse(req.body) as { requestedSeconds: number };
        return { status: 200, body: { gameId: GAME_ID, clockBefore: clock, clockAfter: clock, requestedSeconds: body.requestedSeconds, grantedSeconds: 0, stoppedBecause: "granted_limit_reached", events: [], nextCursor: 0 } };
      }
      return undefined;
    });
    const { store } = setup({ maxCycles: 8, maxModelCalls: 40, maxCostUsd: 1, maxConsecutiveNoProgress: 8, maxConsecutiveAdvances: 2 }, true, {}, "continuous");
    const wait = [ADVANCE(600), PLAN("continue"), TEXT];
    const final = await controller(store, sim, scriptedModel([...wait, ...wait, ...wait])).run();
    expect(final).toMatchObject({ status: "paused", lifecycle: "recovering", stopReason: "consecutive_errors" });
    expect(final.retryAfter).not.toBeNull();
    expect(final.budgets).toMatchObject({ advanceRequests: 2, advancedSimSeconds: 0, consecutiveAdvances: 0 });
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

describe("MOCKED continuous autonomy: no cumulative simulated-time or farm-spend quota, and ineffective-decision backoff", () => {
  const ineligible = (state: { revision: number; simTimeS: number }) => ({
    status: 200,
    body: { ...availableActions, revision: state.revision, simTimeS: state.simTimeS, actions: availableActions.actions.map((a) => ({ ...a, eligibility: { ...a.eligibility, eligible: false } })) },
  });

  it("advances simulated time far past the legacy maxSimSeconds without stopping", async () => {
    sim = await fakeSimulator();
    const wait = [ADVANCE(600), PLAN("continue", "Crops are still developing."), TEXT];
    const { store } = setup({ maxSimSeconds: 100, maxAdvanceRequests: 2, maxConsecutiveAdvances: 50, maxConsecutiveNoProgress: 50, maxCostUsd: 1 }, true, {}, "continuous");
    const final = await controller(store, sim, scriptedModel([...wait, ...wait, ...wait, ...wait, ...wait, ...wait, PLAN("stop", "done"), TEXT])).run();
    expect(final).toMatchObject({ status: "completed", stopReason: "model_declared_done" });
    expect(final.budgets.advancedSimSeconds).toBeGreaterThanOrEqual(3_600);
    expect(final.budgets.advancedSimSeconds).toBeGreaterThan(final.config.limits.maxSimSeconds * 30);
  });

  it("does not end a continuous session at maxFarmSpendCredits, while a legacy session still does", async () => {
    let reads = 0;
    const growingCosts = (req: { url: string }, state: { revision: number; simTimeS: number }) => {
      if (!req.url.includes("/overview")) return undefined;
      reads += 1;
      return { status: 200, body: { ...overview, revision: state.revision, clock: { ...clock, simTimeS: state.simTimeS }, finance: { authorized: true, credits: 12_000 - reads * 100, realizedRevenue: 0, realizedCosts: 300 + reads * 100 } } };
    };
    sim = await fakeSimulator(growingCosts);
    const steps = Array.from({ length: 12 }, () => [INSPECT, PLAN("continue"), TEXT]).flat();
    const cont = setup({ maxFarmSpendCredits: 50, maxConsecutiveNoProgress: 100, maxCostUsd: 1 }, true, {}, "continuous");
    const final = await controller(cont.store, sim, scriptedModel([...steps, PLAN("stop", "done"), TEXT])).run();
    expect(final.stopReason).toBe("model_declared_done");
    const spent = final.metrics.latest!.realizedCosts! - final.metrics.baseline!.realizedCosts!;
    expect(spent).toBeGreaterThan(50 * 10);

    const legacy = setup({ maxFarmSpendCredits: 50, maxConsecutiveNoProgress: 100, maxCycles: 20 });
    const stopped = await controller(legacy.store, sim, scriptedModel(steps)).run();
    expect(stopped.stopReason).toBe("farm_spend_limit_reached");
  });

  it("treats unaffordable or invalid actions as domain feedback: rejected actions change nothing and never exhaust recovery or end the session", async () => {
    const rejected = { gameId: GAME_ID, revision: 4, accepted: false, dryRun: false, action: null, errors: [{ code: "insufficient_credits", detail: "Not enough credits." }], asynchronous: false };
    sim = await fakeSimulator((req) => (req.method === "POST" && req.url.includes("/actions") ? { status: 422, body: rejected } : undefined));
    const { store } = setup({ maxConsecutiveRejections: 2, maxConsecutiveNoProgress: 2, maxCostUsd: 5 }, true, {}, "continuous");
    const step = [INSPECT, PLAN("continue"), TEXT];
    let state = store.load("t1");
    for (let slice = 0; slice < 8; slice += 1) {
      state = await controller(store, sim, scriptedModel([...step, ...step])).run();
      expect(state.status).not.toBe("failed");
      expect(state.status).not.toBe("stopped");
      expect(state.stopReason).not.toBe("recovery_attempts_exhausted");
      expect(state.recoveryAttempts).toBe(0);
    }
    expect(state.budgets.rejectedActions).toBeGreaterThanOrEqual(8);
    expect(state.budgets.acceptedMutations).toBe(0);
    expect(sim.state.accepted).toBe(0);
  });

  it("never fails a continuous session on transient provider outages: persistent, escalating retryAfter and automatic recovery", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveErrors: 1, maxCostUsd: 5 }, true, {}, "continuous");
    const boom = (): ScriptedStep => ({ throws: new ModelApiError("Model API error (HTTP 503).", "server", 503) });
    let state = store.load("t1");
    const delays: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const started = Date.now();
      state = await controller(store, sim, scriptedModel(Array.from({ length: 8 }, boom))).run();
      expect(state).toMatchObject({ status: "paused", lifecycle: "recovering", stopReason: "consecutive_errors", recoveryAttempts: round + 1 });
      delays.push(Date.parse(state.retryAfter!) - started);
    }
    expect(delays[1]!).toBeGreaterThan(delays[0]! * 1.5);
    expect(delays[5]!).toBeLessThanOrEqual(300_500);
    expect(delays[5]!).toBeGreaterThan(100_000);
    // The outage ends: the next slice completes a clean cycle, resets recovery and keeps the session alive.
    const recovered = await controller(store, sim, scriptedModel([PLAN("stop", "done"), TEXT])).run();
    expect(recovered).toMatchObject({ status: "completed", recoveryAttempts: 0, retryAfter: null });
  });

  it("pauses for explicit intervention on deterministic provider rejections (HTTP 400) instead of retrying forever", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveErrors: 1, maxCostUsd: 5 }, true, {}, "continuous");
    const bad = (): ScriptedStep => ({ throws: new ModelApiError("Model API error (HTTP 400): invalid request.", "bad_request", 400) });
    const state = await controller(store, sim, scriptedModel(Array.from({ length: 8 }, bad))).run();
    expect(state).toMatchObject({ status: "paused", lifecycle: "failed", stopReason: "model_configuration_error" });
    expect(state.stopDetail).toMatch(/HTTP 400/);
  });

  it("treats a pre-flight spend refusal as a spending-cap pause, not a provider failure or a recovery attempt", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxCostUsd: 1, maxCostPerRequestUsd: 0.1, maxConsecutiveErrors: 1 }, true, {}, "continuous");
    const model = scriptedModel([{ throws: new SpendLimitError("Worst-case request cost exceeds the remaining session cap.", "session") }]);
    const state = await controller(store, sim, model).run();
    expect(state).toMatchObject({ status: "paused", lifecycle: "awaiting_budget", stopReason: "cost_budget_exhausted", recoveryAttempts: 0, retryAfter: null });
    expect(state.stopDetail).toMatch(/No request was sent/);
    expect(state.budgets.failedModelCalls).toBe(0);
  });

  it("keeps waiting for hundreds of cycles of healthy waiting without ending or calling the model", async () => {
    sim = await fakeSimulator((req, state) => (req.url.includes("/actions") && !/\/actions\/act-/.test(req.url) && req.method === "GET" ? ineligible(state) : undefined));
    const model = scriptedModel([TEXT]);
    const { store } = setup({ maxCycles: 1, maxSimSeconds: 100, maxAdvanceRequests: 1, maxConsecutiveAdvances: 5, maxConsecutiveNoProgress: 3, maxWaitChunkSeconds: 600, maxCostUsd: 1 }, true, {}, "continuous");
    let state = store.load("t1");
    for (let slice = 0; slice < 60; slice += 1) {
      state = await controller(store, sim, model, { sliceCycles: 1 }).run();
      expect(state).toMatchObject({ status: "paused", lifecycle: "waiting_for_simulation", stopReason: "waiting_for_simulation" });
    }
    expect(model.requests).toHaveLength(0);
    expect(state.budgets.modelCalls).toBe(0);
    expect(state.budgets.advancedSimSeconds).toBeGreaterThan(100 * 30);
    expect(state.recoveryAttempts).toBe(0);
  });

  it("answers repeated ineffective decisions with escalating server-time waits, not termination, idle delays or extra model calls", async () => {
    sim = await fakeSimulator();
    const { store } = setup({ maxConsecutiveNoProgress: 3, maxCostUsd: 1, maxWaitChunkSeconds: 600 }, true, {}, "continuous");
    const model = scriptedModel(Array.from({ length: 20 }, () => [PLAN("continue"), TEXT]).flat());
    const waits: number[] = [];
    let calls = 0;
    for (let slice = 0; slice < 4; slice += 1) {
      const state = await controller(store, sim, model).run();
      expect(state).toMatchObject({ status: "paused", lifecycle: "waiting_for_simulation", stopReason: "waiting_for_simulation" });
      // The wait itself paces the model: no real-time retryAfter idling while simulated time can progress.
      expect(state.retryAfter).toBeNull();
      waits.push(state.waitingUntilSimTimeS! - state.lastSimTimeS!);
      const added = model.requests.length - calls;
      calls = model.requests.length;
      // First slice needs the 3 ineffective cycles; each later slice asks the model exactly once before waiting again.
      expect(added).toBe(slice === 0 ? 6 : 2);
    }
    expect(waits[0]).toBeGreaterThanOrEqual(1_800);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
    expect(waits[3]!).toBeGreaterThanOrEqual(waits[2]!);
    expect(store.load("t1").budgets.acceptedMutations).toBe(0);
  });

  it("still ends on an explicit API spending cap regardless of farm cash", async () => {
    sim = await fakeSimulator();
    const costly = (): ScriptedStep[] => [{ calls: [{ name: "update_plan", args: { summary: "s", nextStep: "continue", priorities: ["p"] } }], costUsd: 0.02 }, { content: "ok", costUsd: 0.02 }];
    const { store } = setup({ maxCostUsd: 0.05, maxFarmSpendCredits: 1_000_000, maxConsecutiveNoProgress: 100 }, true, {}, "continuous");
    const stopped = await controller(store, sim, scriptedModel(Array.from({ length: 10 }, costly).flat())).run();
    expect(stopped).toMatchObject({ status: "paused", lifecycle: "awaiting_budget", stopReason: "cost_budget_exhausted" });
  });
});
