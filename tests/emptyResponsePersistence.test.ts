import { afterEach, describe, expect, it } from "vitest";
import { MemorySessionStore, runWorkerOnce, startSession, type AgentDependencies, type ControllableBackend, type SessionControl } from "../src/index.js";
import { GAME_ID } from "./fixtures.js";
import { fakeSimulator, scriptedModel, type FakeSim, type ScriptedStep } from "./agent/harness.js";

/**
 * MOCKED model and simulator, in-memory backend. Verifies that unusable (HTTP 200) model responses are counted, that
 * the three-error safeguard still pauses the session, and that the cause and counters survive slices, pause/resume
 * and a worker restart (a new dependency set over the same persisted backend).
 */

class ControlledMemoryStore extends MemorySessionStore implements ControllableBackend {
  readonly controls = new Map<string, { control: SessionControl; lastError: string | null }>();
  start(id: string): void {
    this.controls.set(id, { control: "run", lastError: null });
  }
  requestControl(id: string, control: SessionControl): Promise<boolean> {
    const entry = this.controls.get(id) ?? { control: "pause" as SessionControl, lastError: null };
    this.controls.set(id, { ...entry, control });
    return Promise.resolve(true);
  }
  getControl(id: string) {
    const entry = this.controls.get(id);
    return Promise.resolve(entry ? { ...entry, leased: false } : null);
  }
  listRunnable(): Promise<string[]> {
    return Promise.resolve([...this.controls].filter(([, c]) => c.control === "run").map(([id]) => id));
  }
  listCancelRequested(): Promise<string[]> {
    return Promise.resolve([]);
  }
  settleControl(id: string, outcome: { stopRunning: boolean; lastError: string | null }): Promise<void> {
    const entry = this.controls.get(id)!;
    this.controls.set(id, { control: outcome.stopRunning ? "pause" : entry.control, lastError: outcome.lastError });
    return Promise.resolve();
  }
}

const EMPTY: ScriptedStep = { content: null };
const PLAN_STOP: ScriptedStep = { calls: [{ name: "update_plan", args: { summary: "plan stop", nextStep: "stop", priorities: ["verify"], stopReason: "done" } }] };
const TEXT: ScriptedStep = { content: "ok" };
const games = { games: [{ gameId: GAME_ID, name: "Test farm", managementMode: "muse_ai", lifecycle: "running", scopes: ["observe", "act", "advance"] }] };
const LIMITS = { maxCostUsd: 1, maxMutations: 3, maxModelCalls: 30, maxSimSeconds: 600 };

let sim: FakeSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

async function harness() {
  sim = await fakeSimulator((req) => (req.url.split("?")[0] === "/api/agent/v1/games" ? { status: 200, body: games } : undefined));
  const backend = new ControlledMemoryStore();
  // A "restart" is a fresh model and dependency set over the same persisted state.
  const depsFor = (steps: ScriptedStep[]): AgentDependencies & { backend: ControlledMemoryStore } => ({
    backend,
    simulator: { baseUrl: sim!.server.url, agentToken: "test-agent-token-SECRET" },
    model: { provider: scriptedModel(steps) },
  });
  return { backend, depsFor };
}

describe("MOCKED worker: unusable responses persist across slices, pause, resume and restart", () => {
  it("accumulates failures across one-cycle slices, pauses at the unchanged three-error limit and keeps the cause visible", async () => {
    const { backend, depsFor } = await harness();
    await startSession(depsFor([EMPTY]), { gameId: GAME_ID, sessionId: "e-1", mutationsEnabled: true, limits: LIMITS, autoWait: false });
    backend.start("e-1");

    for (const expected of [1, 2]) {
      // Every slice is a new dependency set, as after a worker restart.
      await runWorkerOnce({ deps: depsFor([EMPTY]), sliceCycles: 1, mutationsAllowed: true });
      const state = await backend.load("e-1");
      expect(state).toMatchObject({ status: "paused", stopReason: "slice_complete" });
      expect(state.budgets).toMatchObject({ consecutiveErrors: expected, failedModelCalls: expected * 2, modelRetryAttempts: expected });
      expect(backend.controls.get("e-1")).toMatchObject({ control: "run", lastError: null });
    }

    await runWorkerOnce({ deps: depsFor([EMPTY]), sliceCycles: 1, mutationsAllowed: true });
    const paused = await backend.load("e-1");
    expect(paused).toMatchObject({ status: "paused", stopReason: "consecutive_errors" });
    expect(paused.budgets).toMatchObject({ consecutiveErrors: 3, failedModelCalls: 6, modelRetryAttempts: 3, modelCalls: 6 });
    expect(paused.stopDetail).toMatch(/^empty_response: empty_content \(HTTP 200, finish_reason=stop, choices=1, content=no, tool_calls=0/);

    // The cause is persisted beside the session and survives a restart (reloaded from the backend only).
    const control = await backend.getControl("e-1");
    expect(control?.control).toBe("pause");
    expect(control?.lastError).toMatch(/^paused: consecutive_errors — empty_response: empty_content \(HTTP 200/);
    expect(JSON.stringify([paused, control])).not.toMatch(/SECRET|sk-/);

    // A paused session is not rescheduled until an operator resumes it.
    expect(await runWorkerOnce({ deps: depsFor([EMPTY]), sliceCycles: 1, mutationsAllowed: true })).toBe(0);
  });

  it("a resumed session keeps its counters, and a recovered retry resets the consecutive-error count while recording the failed attempt", async () => {
    const { backend, depsFor } = await harness();
    await startSession(depsFor([EMPTY]), { gameId: GAME_ID, sessionId: "e-2", mutationsEnabled: true, limits: LIMITS, autoWait: false });
    backend.start("e-2");
    for (let i = 0; i < 3; i += 1) await runWorkerOnce({ deps: depsFor([EMPTY]), sliceCycles: 1, mutationsAllowed: true });
    expect(await backend.load("e-2")).toMatchObject({ status: "paused", stopReason: "consecutive_errors" });

    await backend.requestControl("e-2", "run");
    // First physical request is empty; the single bounded retry returns a usable plan and a final answer.
    const model = scriptedModel([EMPTY, PLAN_STOP, TEXT]);
    const deps = { ...depsFor([]), model: { provider: model } };
    await runWorkerOnce({ deps, sliceCycles: 1, mutationsAllowed: true });

    const state = await backend.load("e-2");
    expect(model.requests).toHaveLength(3);
    expect(state).toMatchObject({ status: "completed", stopReason: "model_declared_done" });
    expect(state.budgets.consecutiveErrors).toBe(0);
    // Prior history is preserved and the recovered cycle adds exactly one failed physical attempt and one retry.
    expect(state.budgets).toMatchObject({ failedModelCalls: 7, modelRetryAttempts: 4, modelCalls: 9 });
    expect(state.decisions.at(-1)).toMatchObject({ stopReason: "final_answer" });
    expect((await backend.getControl("e-2"))?.lastError).toBeNull();
  });

  it("a recovered retry does not count toward the three-error pause, even after two earlier failed cycles", async () => {
    const { backend, depsFor } = await harness();
    await startSession(depsFor([EMPTY]), { gameId: GAME_ID, sessionId: "e-3", mutationsEnabled: true, limits: LIMITS, autoWait: false });
    backend.start("e-3");
    for (let i = 0; i < 2; i += 1) await runWorkerOnce({ deps: depsFor([EMPTY]), sliceCycles: 1, mutationsAllowed: true });
    expect((await backend.load("e-3")).budgets.consecutiveErrors).toBe(2);

    await runWorkerOnce({ deps: { ...depsFor([]), model: { provider: scriptedModel([EMPTY, PLAN_STOP, TEXT]) } }, sliceCycles: 1, mutationsAllowed: true });
    const state = await backend.load("e-3");
    expect(state.status).toBe("completed");
    expect(state.stopReason).not.toBe("consecutive_errors");
    expect(state.budgets).toMatchObject({ consecutiveErrors: 0, failedModelCalls: 5, modelRetryAttempts: 3 });
  });
});
