import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  IncompatibleSessionError,
  SessionAlreadyExistsError,
  SessionLockLostError,
  SessionLockedError,
  parseSessionState,
  type SessionBackend,
  type SessionLease,
} from "./storage.js";
import { SessionState } from "./types.js";

export { IncompatibleSessionError, SessionLockLostError, SessionLockedError };

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SESSION_ID = SESSION_ID_PATTERN;

interface LockFile {
  ownerId: string;
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Durable session storage: one directory per session holding `state.json` (credential-free, schema validated,
 * written atomically via temp file + rename) and `lock.json` (single active controller).
 */
export class SessionStore implements SessionBackend {
  constructor(readonly root: string, private readonly lockTtlMs = 60_000) {
    mkdirSync(root, { recursive: true });
  }

  traceDirectory(sessionId: string): string {
    return join(this.sessionDir(sessionId), "runs");
  }

  create(state: SessionState): void {
    if (this.exists(state.sessionId)) throw new SessionAlreadyExistsError(state.sessionId);
    const lock = this.acquire(state.sessionId);
    try {
      lock.save(state);
    } finally {
      lock.release();
    }
  }

  sessionDir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id.");
    return join(this.root, sessionId);
  }

  exists(sessionId: string): boolean {
    return existsSync(join(this.sessionDir(sessionId), "state.json"));
  }

  load(sessionId: string): SessionState {
    const file = join(this.sessionDir(sessionId), "state.json");
    if (!existsSync(file)) throw new Error(`Session ${sessionId} does not exist.`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new IncompatibleSessionError(sessionId, "state.json is not valid JSON");
    }
    return parseSessionState(sessionId, raw);
  }

  /** Readable autonomous sessions only. Directories holding other record types or schemas are skipped, never modified. */
  list(): Array<{ sessionId: string; status: string; gameId: string; updatedAt: string }> {
    return this.scan().sessions;
  }

  /** Directory entries that are not compatible autonomous sessions (e.g. baseline runs), with the reason. */
  listIncompatible(): Array<{ sessionId: string; reason: string }> {
    return this.scan().incompatible;
  }

  private scan() {
    const sessions: Array<{ sessionId: string; status: string; gameId: string; updatedAt: string }> = [];
    const incompatible: Array<{ sessionId: string; reason: string }> = [];
    if (!existsSync(this.root)) return { sessions, incompatible };
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name) || !this.exists(entry.name)) continue;
      try {
        const s = this.load(entry.name);
        sessions.push({ sessionId: s.sessionId, status: s.status, gameId: s.gameId, updatedAt: s.updatedAt });
      } catch (error) {
        if (!(error instanceof IncompatibleSessionError)) throw error;
        incompatible.push({ sessionId: entry.name, reason: error.reason });
      }
    }
    return { sessions: sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)), incompatible };
  }

  /** Takes exclusive ownership of a session. A lock whose process is gone, or whose heartbeat expired, is taken over. */
  acquire(sessionId: string): SessionLock {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "lock.json");
    const ownerId = randomUUID();
    const mine = (): LockFile => ({ ownerId, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(lockPath, JSON.stringify(mine()), { flag: "wx" });
        return new SessionLock(this, sessionId, dir, lockPath, ownerId, this.lockTtlMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let holder: LockFile | null = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
      } catch {
        holder = null;
      }
      const age = holder ? Date.now() - Date.parse(holder.heartbeatAt) : Infinity;
      const sameHost = holder?.host === hostname();
      const dead = holder === null || age > this.lockTtlMs || (sameHost && !isProcessAlive(holder.pid));
      if (!dead && holder) throw new SessionLockedError(sessionId, { pid: holder.pid, host: holder.host, heartbeatAt: holder.heartbeatAt });
      rmSync(lockPath, { force: true });
    }
    throw new Error(`Could not acquire session ${sessionId}.`);
  }
}

export class SessionLock implements SessionLease {
  private timer: NodeJS.Timeout | undefined;
  private released = false;

  constructor(
    private readonly store: SessionStore,
    readonly sessionId: string,
    private readonly dir: string,
    private readonly lockPath: string,
    readonly ownerId: string,
    ttlMs: number,
  ) {
    this.timer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        /* ownership loss surfaces on the next save */
      }
    }, Math.max(50, Math.floor(ttlMs / 3)));
    this.timer.unref();
  }

  private assertOwner(): LockFile {
    if (this.released) throw new SessionLockLostError("The session lock was released.");
    let current: LockFile;
    try {
      current = JSON.parse(readFileSync(this.lockPath, "utf8")) as LockFile;
    } catch {
      throw new SessionLockLostError(`Session ${this.sessionId} lock is missing.`);
    }
    if (current.ownerId !== this.ownerId) throw new SessionLockLostError(`Session ${this.sessionId} is now owned by another controller.`);
    return current;
  }

  heartbeat(): void {
    const current = this.assertOwner();
    writeFileSync(this.lockPath, JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }));
  }

  /** Persists the state atomically; refuses if another controller has taken the session over. */
  save(state: SessionState): void {
    this.assertOwner();
    const next = SessionState.parse({ ...state, updatedAt: new Date().toISOString() });
    const tmp = join(this.dir, `state.${this.ownerId}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, join(this.dir, "state.json"));
    this.heartbeat();
  }

  load(): SessionState {
    return this.store.load(this.sessionId);
  }

  release(): void {
    if (this.released) return;
    if (this.timer) clearInterval(this.timer);
    try {
      this.assertOwner();
      rmSync(this.lockPath, { force: true });
    } catch {
      /* not ours anymore */
    }
    this.released = true;
  }
}
