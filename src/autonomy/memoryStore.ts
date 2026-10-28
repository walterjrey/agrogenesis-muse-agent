import { SessionState } from "./types.js";
import { SessionAlreadyExistsError, SessionLockLostError, SessionLockedError, type SessionBackend, type SessionLease, type SessionSummary } from "./storage.js";

/** Process-local backend for tests and local experiments. It provides no durability across restarts. */
export class MemorySessionStore implements SessionBackend {
  private readonly sessions = new Map<string, { state: string; owner: string | null }>();

  exists(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  load(sessionId: string): SessionState {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} does not exist.`);
    return SessionState.parse(JSON.parse(entry.state));
  }

  list(): SessionSummary[] {
    return [...this.sessions.keys()]
      .map((id) => this.load(id))
      .map((s) => ({ sessionId: s.sessionId, status: s.status, gameId: s.gameId, updatedAt: s.updatedAt }))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  create(state: SessionState): void {
    if (this.sessions.has(state.sessionId)) throw new SessionAlreadyExistsError(state.sessionId);
    this.sessions.set(state.sessionId, { state: JSON.stringify(SessionState.parse(state)), owner: null });
  }

  acquire(sessionId: string): SessionLease {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} does not exist.`);
    if (entry.owner !== null) throw new SessionLockedError(sessionId, { pid: process.pid, host: "memory", heartbeatAt: new Date().toISOString() });
    const owner = `${Date.now()}-${Math.random()}`;
    entry.owner = owner;
    return {
      save: (state) => {
        if (entry.owner !== owner) throw new SessionLockLostError(`Session ${sessionId} is no longer owned by this controller.`);
        entry.state = JSON.stringify(SessionState.parse({ ...state, updatedAt: new Date().toISOString() }));
      },
      release: () => {
        if (entry.owner === owner) entry.owner = null;
      },
    };
  }
}
