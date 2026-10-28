import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { SessionLockLostError, SessionLockedError, SessionAlreadyExistsError, PostgresSessionStore, newSessionState } from "../src/index.js";

/**
 * LIVE PostgreSQL test: runs only when AGENT_PKG_TEST_DATABASE_URL points at an isolated, disposable database.
 * It creates and drops its own uniquely named table. Without the variable the suite is skipped (not "passed").
 */
const URL = process.env.AGENT_PKG_TEST_DATABASE_URL;
const TABLE = `agent_sessions_t${process.pid}_${Date.now()}`;

describe.skipIf(!URL)("LIVE PostgreSQL session store", () => {
  let pool: pg.Pool;
  let store: PostgresSessionStore;
  const fresh = (id: string) => newSessionState({ sessionId: id, gameId: "game-1", modelId: "muse-spark-1.3", mutationsEnabled: false });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL!, max: 4 });
    store = new PostgresSessionStore(pool, { table: TABLE, leaseTtlMs: 600 });
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.end();
  });

  it("creates, loads and lists sessions; refuses duplicates", async () => {
    await store.create(fresh("pg-1"));
    expect(await store.exists("pg-1")).toBe(true);
    expect((await store.load("pg-1")).gameId).toBe("game-1");
    expect((await store.list()).map((s) => s.sessionId)).toContain("pg-1");
    await expect(store.create(fresh("pg-1"))).rejects.toBeInstanceOf(SessionAlreadyExistsError);
  });

  it("grants the lease to one controller at a time and persists saves", async () => {
    await store.create(fresh("pg-2"));
    const lease = await store.acquire("pg-2");
    await expect(store.acquire("pg-2")).rejects.toBeInstanceOf(SessionLockedError);
    const state = await store.load("pg-2");
    await lease.save({ ...state, cycle: 7, status: "running" });
    expect(await store.load("pg-2")).toMatchObject({ cycle: 7, status: "running" });
    await lease.release();
    await expect(store.acquire("pg-2")).resolves.toBeDefined();
  });

  it("only one of many concurrent acquirers wins", async () => {
    await store.create(fresh("pg-3"));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => store.acquire("pg-3")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("fences a displaced controller: its save is refused and cannot overwrite newer state", async () => {
    await store.create(fresh("pg-4"));
    const stale = await store.acquire("pg-4");
    await pool.query(`UPDATE ${TABLE} SET lock_heartbeat = now() - interval '1 hour' WHERE session_id = 'pg-4'`);
    const successor = await store.acquire("pg-4");
    await successor.save({ ...(await store.load("pg-4")), cycle: 9 });
    await expect(stale.save({ ...(await store.load("pg-4")), cycle: 1 })).rejects.toBeInstanceOf(SessionLockLostError);
    expect((await store.load("pg-4")).cycle).toBe(9);
    await successor.release();
    await stale.release();
  });

  it("rejects an invalid table name", () => {
    expect(() => new PostgresSessionStore(pool, { table: "x; drop table y" })).toThrow(/Invalid table name/);
  });
});
