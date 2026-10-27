import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { SessionState } from "./types.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export class SessionLockedError extends Error {
  constructor(readonly sessionId: string, readonly holder: { pid: number; host: string; heartbeatAt: string }) {
    super(`Session ${sessionId} is owned by another controller (pid ${holder.pid} on ${holder.host}, last heartbeat ${holder.heartbeatAt}).`);
  }
}

export class SessionLockLostError extends Error {}

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
export class SessionStore {
  constructor(readonly root: string, private readonly lockTtlMs = 60_000) {
    mkdirSync(root, { recursive: true });
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
    return SessionState.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  list(): Array<{ sessionId: string; status: string; gameId: string; updatedAt: string }> {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name) && this.exists(entry.name))
      .map((entry) => this.load(entry.name))
      .map((s) => ({ sessionId: s.sessionId, status: s.status, gameId: s.gameId, updatedAt: s.updatedAt }))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
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

export class SessionLock {
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
