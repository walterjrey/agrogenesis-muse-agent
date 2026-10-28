import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresSessionStore, getSessionReport, runWorkerOnce, startSession, type AgentDependencies, type WorkerEvent } from "../src/index.js";
import { GAME_ID } from "./fixtures.js";
import { fakeSimulator, scriptedModel, type FakeSim, type ScriptedStep } from "./agent/harness.js";

/**
 * LIVE PostgreSQL (store, control columns, leases) with a MOCKED simulator and model. Skipped without
 * AGENT_PKG_TEST_DATABASE_URL. It proves worker scheduling and exclusion, not live Muse or live simulator behaviour.
 */
const URL = process.env.AGENT_PKG_TEST_DATABASE_URL;
const TABLE = `agent_sessions_w${process.pid}_${Date.now()}`;
const PLAN = (nextStep: "continue" | "stop"): ScriptedStep => ({ calls: [{ name: "update_plan", args: { summary: `plan ${nextStep}`, nextStep, priorities: ["verify"], ...(nextStep === "stop" ? { stopReason: "done" } : {}) } }] });
const TEXT: ScriptedStep = { content: "ok" };
const games = { games: [{ gameId: GAME_ID, name: "Test farm", managementMode: "muse_ai", lifecycle: "running", scopes: ["observe", "act", "advance"] }] };

let sim: FakeSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

describe.skipIf(!URL)("LIVE PostgreSQL worker control (mocked simulator and model)", () => {
  let pool: pg.Pool;
  let store: PostgresSessionStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL!, max: 6 });
    store = new PostgresSessionStore(pool, { table: TABLE, leaseTtlMs: 600 });
    await store.migrate();
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}_migrations`);
    await pool.end();
  });

  async function setup(steps: ScriptedStep[]) {
    sim = await fakeSimulator((req) => (req.url.split("?")[0] === "/api/agent/v1/games" ? { status: 200, body: games } : undefined));
    const model = scriptedModel(steps);
    const deps: AgentDependencies & { backend: PostgresSessionStore } = { backend: store, simulator: { baseUrl: sim.server.url, agentToken: "test-agent-token-SECRET" }, model: { provider: model } };
    return { deps, model };
  }
  const events = () => {
    const log: WorkerEvent[] = [];
    return { log, onEvent: (e: WorkerEvent) => log.push(e) };
  };

  it("migrations are idempotent and record their ids", async () => {
    expect(await store.migrate()).toEqual([]);
    const done = await pool.query(`SELECT id FROM ${TABLE}_migrations ORDER BY id`);
    expect(done.rows.map((r) => r.id)).toEqual(["0001_sessions", "0002_worker_control"]);
  });

  it("does not run a paused session; runs it once queued and stops scheduling it when finished", async () => {
    const { deps, model } = await setup([PLAN("stop"), TEXT]);
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-1" });
    const e = events();
    expect(await runWorkerOnce({ deps, ...e })).toBe(0);
    expect(model.requests).toHaveLength(0);

    expect(await store.requestControl("w-1", "run")).toBe(true);
    expect(await runWorkerOnce({ deps, ...e })).toBe(1);
    expect(e.log.map((x) => x.type)).toEqual(["slice_started", "slice_finished"]);
    expect((await getSessionReport(store, "w-1")).status).toBe("completed");
    expect(await store.getControl("w-1")).toMatchObject({ control: "pause", leased: false });
    expect(await runWorkerOnce({ deps, ...e })).toBe(0);
  });

  it("two concurrent workers never execute the same session twice", async () => {
    const { deps, model } = await setup([PLAN("stop"), TEXT, PLAN("stop"), TEXT]);
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-2" });
    await store.requestControl("w-2", "run");
    const a = events();
    const b = events();
    const counts = await Promise.all([runWorkerOnce({ deps, ...a }), runWorkerOnce({ deps, ...b })]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    expect([...a.log, ...b.log].filter((x) => x.type === "slice_started")).toHaveLength(1);
    expect(model.requests.length).toBeLessThanOrEqual(2);
    expect((await store.load("w-2")).cycle).toBe(1);
  });

  it("a bounded slice leaves the session queued; pause stops further slices and survives a resume", async () => {
    const { deps } = await setup([PLAN("continue"), TEXT, PLAN("continue"), TEXT]);
    const limits = { maxCostUsd: 1, maxMutations: 3, maxModelCalls: 20, maxSimSeconds: 600 };
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-3", mutationsEnabled: true, limits, autoWait: false });
    await store.requestControl("w-3", "run");
    const e = events();
    await runWorkerOnce({ deps, sliceCycles: 1, mutationsAllowed: true, ...e });
    expect(await store.getControl("w-3")).toMatchObject({ control: "run" });
    expect((await store.load("w-3")).stopReason).toBe("slice_complete");

    await store.requestControl("w-3", "pause");
    expect(await runWorkerOnce({ deps, sliceCycles: 1, mutationsAllowed: true, ...e })).toBe(0);
    await store.requestControl("w-3", "run");
    expect(await runWorkerOnce({ deps, sliceCycles: 1, mutationsAllowed: true, ...e })).toBe(1);
    expect((await store.load("w-3")).cycle).toBe(2);
    await store.requestControl("w-3", "pause");
  });

  it("cancel is final: the worker stops the session and a later resume is refused", async () => {
    const { deps, model } = await setup([PLAN("continue"), TEXT]);
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-4" });
    await store.requestControl("w-4", "run");
    await store.requestControl("w-4", "cancel");
    const e = events();
    expect(await runWorkerOnce({ deps, ...e })).toBe(0);
    expect(e.log).toEqual([{ type: "cancelled", sessionId: "w-4" }]);
    expect(await store.load("w-4")).toMatchObject({ status: "stopped", stopReason: "cancelled_by_operator" });
    expect(await store.requestControl("w-4", "run")).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("a worker with mutations disabled never runs a session that allows them", async () => {
    const { deps, model } = await setup([PLAN("stop"), TEXT]);
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-5", mutationsEnabled: true, limits: { maxCostUsd: 1, maxMutations: 2, maxModelCalls: 10, maxSimSeconds: 600 } });
    await store.requestControl("w-5", "run");
    const e = events();
    expect(await runWorkerOnce({ deps, mutationsAllowed: false, ...e })).toBe(0);
    expect(e.log.map((x) => x.type)).toEqual(["skipped_mutations_disabled"]);
    expect(model.requests).toHaveLength(0);
    expect((await store.load("w-5")).status).toBe("paused");
    expect((await store.getControl("w-5"))?.lastError).toMatch(/mutations disabled/);
  });

  it("a crashed worker's session is picked up after the lease expires, without repeating completed cycles", async () => {
    const { deps } = await setup([PLAN("stop"), TEXT]);
    await startSession(deps, { gameId: GAME_ID, sessionId: "w-6" });
    await store.requestControl("w-6", "run");
    const dead = await store.acquire("w-6");
    await dead.save({ ...(await store.load("w-6")), status: "running", stopReason: null });
    await dead.release();
    // Simulate a killed process: a lease owner that stopped heartbeating (no timer survives a real crash).
    await pool.query(`UPDATE ${TABLE} SET lock_owner = 'dead-owner', lock_heartbeat = now() WHERE session_id = 'w-6'`);
    expect(await store.listRunnable(10)).not.toContain("w-6");
    await pool.query(`UPDATE ${TABLE} SET lock_heartbeat = now() - interval '1 hour' WHERE session_id = 'w-6'`);
    expect(await store.listRunnable(10)).toContain("w-6");
    const e = events();
    expect(await runWorkerOnce({ deps, ...e })).toBe(1);
    expect((await store.load("w-6")).status).toBe("completed");
  });
});
