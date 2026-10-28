import { SessionState as SessionStateSchema } from "./types.js";
import type { SessionState } from "./types.js";

export type MaybePromise<T> = T | Promise<T>;

export class SessionLockedError extends Error {
  constructor(readonly sessionId: string, readonly holder: { pid: number; host: string; heartbeatAt: string }) {
    super(`Session ${sessionId} is owned by another controller (pid ${holder.pid} on ${holder.host}, last heartbeat ${holder.heartbeatAt}).`);
  }
}

export class SessionLockLostError extends Error {}

export class SessionAlreadyExistsError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} already exists.`);
  }
}

/** A persisted record that is not a readable autonomous-session state (other tool, older or newer schema). */
export class IncompatibleSessionError extends Error {
  constructor(readonly sessionId: string, readonly reason: string) {
    super(`Session ${sessionId} is not a compatible autonomous session (${reason}). It was left untouched.`);
  }
}

export const parseSessionState = (sessionId: string, raw: unknown): SessionState => {
  const result = SessionStateSchema.safeParse(raw);
  if (result.success) return result.data;
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  const first = result.error.issues[0];
  throw new IncompatibleSessionError(sessionId, `version ${String(version)}, ${first ? `${first.path.join(".") || "root"}: ${first.message}` : "invalid"}`);
};

/** Operator intent for a session, stored beside (never inside) the agent state so a web process can set it without owning the lease. */
export type SessionControl = "pause" | "run" | "cancel";

/** Optional capabilities a backend needs for an independent worker plus a web process (implemented by PostgresSessionStore). */
export interface ControllableBackend extends SessionBackend {
  /** `run` queues a paused/running session; `pause` stops scheduling it; `cancel` is final. Returns false when not applicable. */
  requestControl(sessionId: string, control: SessionControl): Promise<boolean>;
  getControl(sessionId: string): Promise<{ control: SessionControl; lastError: string | null; leased: boolean } | null>;
  /** Sessions with `run` requested, resumable status and no live lease. */
  listRunnable(limit: number): Promise<string[]>;
  /** Sessions with `cancel` requested that are not yet in a terminal status and have no live lease. */
  listCancelRequested(limit: number): Promise<string[]>;
  /** Worker bookkeeping that never overrides a pending `cancel`. `stopRunning` turns `run` into `paused`. */
  settleControl(sessionId: string, outcome: { stopRunning: boolean; lastError: string | null }): Promise<void>;
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  gameId: string;
  updatedAt: string;
}

/**
 * Exclusive ownership of one session. `save` must refuse (throw SessionLockLostError) once another controller has
 * taken the session over, so a displaced or stale process can never overwrite newer state.
 */
export interface SessionLease {
  save(state: SessionState): MaybePromise<void>;
  release(): MaybePromise<void>;
}

/**
 * Durable, credential-free session storage. Implementations: local files (CLI), in-memory (tests) and PostgreSQL.
 * Every write the controller makes goes through `SessionLease.save` and is awaited, so the journal-before-mutation
 * ordering that makes retries safe holds for any backend.
 */
export interface SessionBackend {
  exists(sessionId: string): MaybePromise<boolean>;
  load(sessionId: string): MaybePromise<SessionState>;
  list(): MaybePromise<SessionSummary[]>;
  /** Persists a brand-new session. Throws SessionAlreadyExistsError when the id is taken. */
  create(state: SessionState): MaybePromise<void>;
  acquire(sessionId: string): MaybePromise<SessionLease>;
  /** Directory for per-cycle JSONL traces, or null when the backend keeps none. */
  traceDirectory?(sessionId: string): string | null;
}
