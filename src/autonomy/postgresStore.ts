import { randomUUID } from "node:crypto";
import { parseSessionState, SessionAlreadyExistsError, SessionLockLostError, SessionLockedError, type ControllableBackend, type SessionControl, type SessionLease, type SessionSummary } from "./storage.js";
import { SessionState } from "./types.js";

/** The subset of `pg.Pool` / `pg.Client` this store needs. The library has no dependency on `pg`. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

/** Adapts a postgres.js client (`postgres(url)`) to the minimal query interface. */
export function postgresJsQueryable(sql: {
  unsafe(query: string, params?: never[]): PromiseLike<Array<Record<string, unknown>> & { count?: number }>;
}): PgQueryable {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, (params ?? []) as never[]);
      return { rows: Array.from(rows), rowCount: rows.count ?? rows.length };
    },
  };
}

export interface PostgresSessionStoreOptions {
  /** Table name (default `agent_sessions`). Must be a plain SQL identifier. */
  table?: string;
  /** A lease not heartbeated for this long can be taken over by another controller (default 60 s). */
  leaseTtlMs?: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,50}$/;

/**
 * Versioned, idempotent DDL owned by this library. Every statement is safe to re-run, touches only the agent's own
 * tables, and never alters simulator tables. Apply with `store.migrate()` (a release step) or paste the SQL.
 */
export function sessionMigrations(table = "agent_sessions"): Array<{ id: string; sql: string[] }> {
  if (!IDENTIFIER.test(table)) throw new Error("Invalid table name.");
  return [
    {
      id: "0001_sessions",
      sql: [
        `CREATE TABLE IF NOT EXISTS ${table} (
          session_id text PRIMARY KEY,
          game_id text NOT NULL,
          status text NOT NULL,
          state jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          lock_owner text,
          lock_host text,
          lock_heartbeat timestamptz
        )`,
      ],
    },
    {
      id: "0002_worker_control",
      sql: [
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS control text NOT NULL DEFAULT 'pause'`,
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS control_updated_at timestamptz`,
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_error text`,
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_slice_at timestamptz`,
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_control_check') THEN
             ALTER TABLE ${table} ADD CONSTRAINT ${table}_control_check CHECK (control IN ('pause','run','cancel'));
           END IF;
         END $$`,
        `CREATE INDEX IF NOT EXISTS ${table}_control_idx ON ${table} (control, status)`,
      ],
    },
  ];
}

/**
 * PostgreSQL session backend. One row per session holds the credential-free JSONB state plus a lease
 * (`lock_owner`, `lock_heartbeat`). Saves are fenced by the lease owner in the UPDATE itself, so a controller that was
 * displaced after a crash, deploy overlap or stalled heartbeat can never overwrite newer state.
 * Operator intent (`control`) lives in its own column so a web process can pause/resume/cancel without holding the lease.
 */
export class PostgresSessionStore implements ControllableBackend {
  private readonly table: string;
  private readonly leaseTtlMs: number;

  constructor(private readonly db: PgQueryable, options: PostgresSessionStoreOptions = {}) {
    this.table = options.table ?? "agent_sessions";
    if (!IDENTIFIER.test(this.table)) throw new Error("Invalid table name.");
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  /** Applies pending migrations and records them in `<table>_migrations`. Idempotent; run it once per release, not per request. */
  async migrate(): Promise<string[]> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${this.table}_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await this.db.query(`SELECT id FROM ${this.table}_migrations`)).rows.map((r) => String(r.id)));
    const applied: string[] = [];
    for (const migration of sessionMigrations(this.table)) {
      if (done.has(migration.id)) continue;
      for (const statement of migration.sql) await this.db.query(statement);
      await this.db.query(`INSERT INTO ${this.table}_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [migration.id]);
      applied.push(migration.id);
    }
    return applied;
  }

  /** @deprecated Use `migrate()`. */
  async ensureSchema(): Promise<void> {
    await this.migrate();
  }

  async exists(sessionId: string): Promise<boolean> {
    const result = await this.db.query(`SELECT 1 FROM ${this.table} WHERE session_id = $1`, [sessionId]);
    return result.rows.length > 0;
  }

  async load(sessionId: string): Promise<SessionState> {
    const result = await this.db.query(`SELECT state FROM ${this.table} WHERE session_id = $1`, [sessionId]);
    const row = result.rows[0];
    if (!row) throw new Error(`Session ${sessionId} does not exist.`);
    return parseSessionState(sessionId, typeof row.state === "string" ? JSON.parse(row.state) : row.state);
  }

  async list(): Promise<SessionSummary[]> {
    const result = await this.db.query(`SELECT session_id, status, game_id, updated_at FROM ${this.table} ORDER BY updated_at`);
    return result.rows.map((row) => ({ sessionId: String(row.session_id), status: String(row.status), gameId: String(row.game_id), updatedAt: new Date(row.updated_at as string | Date).toISOString() }));
  }

  async requestControl(sessionId: string, control: SessionControl): Promise<boolean> {
    const guard = control === "cancel" ? `status IN ('paused','running')` : `status IN ('paused','running') AND control <> 'cancel'`;
    const result = await this.db.query(
      `UPDATE ${this.table} SET control = $2, control_updated_at = now() WHERE session_id = $1 AND ${guard} RETURNING session_id`,
      [sessionId, control],
    );
    return result.rows.length > 0;
  }

  async getControl(sessionId: string): Promise<{ control: SessionControl; lastError: string | null; leased: boolean } | null> {
    const result = await this.db.query(
      `SELECT control, last_error, (lock_owner IS NOT NULL AND lock_heartbeat >= now() - make_interval(secs => $2)) AS leased FROM ${this.table} WHERE session_id = $1`,
      [sessionId, this.leaseTtlMs / 1000],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { control: row.control as SessionControl, lastError: row.last_error === null ? null : String(row.last_error), leased: row.leased === true };
  }

  async listRunnable(limit: number): Promise<string[]> {
    const result = await this.db.query(
      `SELECT session_id FROM ${this.table}
       WHERE control = 'run' AND status IN ('paused','running') AND (lock_owner IS NULL OR lock_heartbeat < now() - make_interval(secs => $2))
       ORDER BY last_slice_at NULLS FIRST, updated_at LIMIT $1`,
      [limit, this.leaseTtlMs / 1000],
    );
    return result.rows.map((r) => String(r.session_id));
  }

  async listCancelRequested(limit: number): Promise<string[]> {
    const result = await this.db.query(
      `SELECT session_id FROM ${this.table}
       WHERE control = 'cancel' AND status IN ('paused','running') AND (lock_owner IS NULL OR lock_heartbeat < now() - make_interval(secs => $2))
       ORDER BY updated_at LIMIT $1`,
      [limit, this.leaseTtlMs / 1000],
    );
    return result.rows.map((r) => String(r.session_id));
  }

  async settleControl(sessionId: string, outcome: { stopRunning: boolean; lastError: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE ${this.table} SET last_slice_at = now(), last_error = $3,
         control = CASE WHEN control = 'run' AND $2::boolean THEN 'pause' ELSE control END
       WHERE session_id = $1`,
      [sessionId, outcome.stopRunning, outcome.lastError],
    );
  }

  async create(state: SessionState): Promise<void> {
    const parsed = SessionState.parse(state);
    const result = await this.db.query(
      `INSERT INTO ${this.table} (session_id, game_id, status, state) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (session_id) DO NOTHING`,
      [parsed.sessionId, parsed.gameId, parsed.status, JSON.stringify(parsed)],
    );
    if ((result.rowCount ?? 0) === 0) throw new SessionAlreadyExistsError(parsed.sessionId);
  }

  async acquire(sessionId: string): Promise<SessionLease> {
    const owner = randomUUID();
    const taken = await this.db.query(
      `UPDATE ${this.table} SET lock_owner = $2, lock_host = $3, lock_heartbeat = now()
       WHERE session_id = $1 AND (lock_owner IS NULL OR lock_heartbeat < now() - make_interval(secs => $4))
       RETURNING session_id`,
      [sessionId, owner, `pg-${process.pid}`, this.leaseTtlMs / 1000],
    );
    if (taken.rows.length === 0) {
      const holder = await this.db.query(`SELECT lock_host, lock_heartbeat FROM ${this.table} WHERE session_id = $1`, [sessionId]);
      const row = holder.rows[0];
      if (!row) throw new Error(`Session ${sessionId} does not exist.`);
      throw new SessionLockedError(sessionId, { pid: 0, host: String(row.lock_host ?? "unknown"), heartbeatAt: row.lock_heartbeat ? new Date(row.lock_heartbeat as string | Date).toISOString() : "unknown" });
    }
    return new PostgresLease(this.db, this.table, sessionId, owner, this.leaseTtlMs);
  }
}

class PostgresLease implements SessionLease {
  private timer: NodeJS.Timeout | undefined;
  private released = false;

  constructor(private readonly db: PgQueryable, private readonly table: string, private readonly sessionId: string, private readonly owner: string, ttlMs: number) {
    this.timer = setInterval(() => {
      this.db.query(`UPDATE ${this.table} SET lock_heartbeat = now() WHERE session_id = $1 AND lock_owner = $2`, [this.sessionId, this.owner]).catch(() => undefined);
    }, Math.max(50, Math.floor(ttlMs / 3)));
    this.timer.unref();
  }

  async save(state: SessionState): Promise<void> {
    if (this.released) throw new SessionLockLostError("The session lease was released.");
    const next = SessionState.parse({ ...state, updatedAt: new Date().toISOString() });
    const result = await this.db.query(
      `UPDATE ${this.table} SET state = $3::jsonb, status = $4, game_id = $5, updated_at = now(), lock_heartbeat = now()
       WHERE session_id = $1 AND lock_owner = $2 RETURNING session_id`,
      [this.sessionId, this.owner, JSON.stringify(next), next.status, next.gameId],
    );
    if (result.rows.length === 0) throw new SessionLockLostError(`Session ${this.sessionId} is now owned by another controller.`);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    await this.db.query(`UPDATE ${this.table} SET lock_owner = NULL, lock_host = NULL, lock_heartbeat = NULL WHERE session_id = $1 AND lock_owner = $2`, [this.sessionId, this.owner]);
  }
}
