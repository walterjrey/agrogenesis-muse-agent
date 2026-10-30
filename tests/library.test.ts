import { afterEach, describe, expect, it } from "vitest";
import { MemorySessionStore, SessionLockedError, getSessionReport, runSessionSlice, startSession, type AgentDependencies } from "../src/index.js";
import { executeAccepted, GAME_ID } from "./fixtures.js";
import { fakeSimulator, scriptedModel, type FakeSim, type ScriptedStep } from "./agent/harness.js";

/** MOCKED: scripted model and fake HTTP simulator. These verify the library facade, not live Muse or a live simulator. */

let sim: FakeSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

const SCOPES = ["observe", "act", "advance"];
const gamesBody = (managementMode: string, scopes: string[]) => ({ status: 200, body: { games: [{ gameId: GAME_ID, name: "Test farm", managementMode, lifecycle: "running", scopes }] } });
// Generic "accepted mutating action" stand-in (the fake simulator always accepts regardless of submitted type).
const INSPECT: ScriptedStep = { calls: [{ name: "execute_action", args: { type: "irrigateField", params: { fieldId: "field-1" }, rationale: "Moisture is stale." } }] };
const PLAN = (nextStep: "continue" | "stop"): ScriptedStep => ({ calls: [{ name: "update_plan", args: { summary: `plan ${nextStep}`, nextStep, priorities: ["verify"], ...(nextStep === "stop" ? { stopReason: "done" } : {}) } }] });
const TEXT: ScriptedStep = { content: "ok" };
const LIMITS = { maxCostUsd: 1, maxMutations: 3, maxModelCalls: 20, maxSimSeconds: 600 };

async function deps(mode = "muse_ai", scopes = SCOPES, steps: ScriptedStep[] = [TEXT]) {
  sim = await fakeSimulator((req) => (req.url.split("?")[0] === "/api/agent/v1/games" ? gamesBody(mode, scopes) : undefined));
  const backend = new MemorySessionStore();
  const model = scriptedModel(steps);
  const d: AgentDependencies = { backend, simulator: { baseUrl: sim.server.url, agentToken: "test-agent-token-SECRET" }, model: { provider: model } };
  return { d, backend, model };
}

describe("MOCKED library: startSession", () => {
  it("creates a paused, credential-free session and executes nothing", async () => {
    const { d, backend } = await deps();
    const state = await startSession(d, { gameId: GAME_ID, sessionId: "lib-1", mutationsEnabled: true, limits: LIMITS, planningHorizonDays: 200 });
    expect(state).toMatchObject({ status: "paused", stopReason: "not_started", config: { mutationsEnabled: true, planning: { horizonDays: 200 } } });
    expect(JSON.stringify(await backend.load("lib-1"))).not.toContain("SECRET");
    expect(sim!.posts).toHaveLength(0);
  });

  it("refuses unauthorized games, missing scopes, non-Muse games and mutations without explicit budgets", async () => {
    const { d } = await deps("muse_ai", SCOPES);
    await expect(startSession(d, { gameId: "other-game" })).rejects.toThrow(/not authorized/);
    await expect(startSession(d, { gameId: GAME_ID, mutationsEnabled: true, limits: { maxMutations: 1 } })).rejects.toThrow(/explicit budget/);
    const manual = await deps("manual");
    await expect(startSession(manual.d, { gameId: GAME_ID, mutationsEnabled: true, limits: LIMITS })).rejects.toThrow(/require muse_ai/);
    const readOnly = await deps("muse_ai", ["observe"]);
    await expect(startSession(readOnly.d, { gameId: GAME_ID, mutationsEnabled: true, limits: LIMITS })).rejects.toThrow(/lacks the act scope/);
    await expect(startSession(readOnly.d, { gameId: GAME_ID })).resolves.toMatchObject({ config: { mutationsEnabled: false } });
  });

  it("refuses to create the same session twice", async () => {
    const { d } = await deps();
    await startSession(d, { gameId: GAME_ID, sessionId: "dup" });
    await expect(startSession(d, { gameId: GAME_ID, sessionId: "dup" })).rejects.toThrow(/already exists/);
  });
});

describe("MOCKED library: runSessionSlice", () => {
  it("runs an observe-only slice without any mutation", async () => {
    const { d } = await deps("muse_ai", ["observe"], [PLAN("stop"), TEXT]);
    const { sessionId } = await startSession(d, { gameId: GAME_ID });
    const result = await runSessionSlice(d, { sessionId });
    expect(result).toMatchObject({ finished: true, state: { status: "completed" } });
    expect(sim!.posts).toHaveLength(0);
  });

  it("does not mutate unless the caller re-confirms mutations on that call", async () => {
    const { d } = await deps("muse_ai", SCOPES, [INSPECT, PLAN("stop"), TEXT]);
    const { sessionId } = await startSession(d, { gameId: GAME_ID, mutationsEnabled: true, limits: LIMITS, autoWait: false });
    const result = await runSessionSlice(d, { sessionId });
    expect(result.state.budgets.acceptedMutations).toBe(0);
    expect(sim!.posts).toHaveLength(0);
  });

  it("runs a bounded slice, persists progress and resumes where it paused", async () => {
    const { d, backend } = await deps("muse_ai", SCOPES, [INSPECT, PLAN("continue"), TEXT, PLAN("stop"), TEXT]);
    const { sessionId } = await startSession(d, { gameId: GAME_ID, mutationsEnabled: true, limits: LIMITS, autoWait: false });
    const first = await runSessionSlice(d, { sessionId, mutationsEnabled: true, sliceCycles: 1 });
    expect(first).toMatchObject({ finished: false, state: { status: "paused", stopReason: "slice_complete", cycle: 1 } });
    expect(sim!.posts.map((p) => p.path)).toEqual(["/actions"]);
    expect(first.state.actions[0]).toMatchObject({ actionId: executeAccepted.action.actionId });
    expect((await backend.load(sessionId)).cycle).toBe(1);

    const second = await runSessionSlice(d, { sessionId, mutationsEnabled: true, sliceCycles: 1 });
    expect(second).toMatchObject({ finished: true, state: { status: "completed", cycle: 2 } });
    expect(sim!.state.accepted).toBe(1);
    expect((await getSessionReport(backend, sessionId)).actions).toMatchObject({ accepted: 1 });
    await expect(runSessionSlice(d, { sessionId, mutationsEnabled: true })).rejects.toThrow(/cannot be resumed/);
  });

  it("rejects a second concurrent slice on the same session", async () => {
    const { d, backend } = await deps("muse_ai", ["observe"], [PLAN("stop"), TEXT]);
    const { sessionId } = await startSession(d, { gameId: GAME_ID });
    const held = await backend.acquire(sessionId);
    await expect(runSessionSlice(d, { sessionId })).rejects.toBeInstanceOf(SessionLockedError);
    await held.release();
    await expect(runSessionSlice(d, { sessionId })).resolves.toMatchObject({ finished: true });
  });
});
