/**
 * Public library entrypoint. Server-side only: it holds Meta API and simulator agent credentials in memory.
 * The agent talks to the simulator exclusively through the authorized /api/agent/v1 HTTP API; no simulator code is bundled.
 */
export { startSession, buildSessionRecord, runSessionSlice, getSessionReport, DEFAULT_SLICE_CYCLES } from "./library.js";
export type { AgentDependencies, ModelConnection, SimulatorConnection, StartSessionOptions, RunSliceOptions, SliceResult } from "./library.js";

export { SessionLockedError, SessionLockLostError, SessionAlreadyExistsError, IncompatibleSessionError } from "./autonomy/storage.js";
export type { SessionBackend, ControllableBackend, SessionControl, SessionLease, SessionSummary } from "./autonomy/storage.js";
export { SessionStore as FileSessionStore } from "./autonomy/store.js";
export { MemorySessionStore } from "./autonomy/memoryStore.js";
export { PostgresSessionStore, postgresJsQueryable, sessionMigrations } from "./autonomy/postgresStore.js";
export type { PgQueryable, PostgresSessionStoreOptions } from "./autonomy/postgresStore.js";
export { runWorker, runWorkerOnce } from "./worker.js";
export type { WorkerOptions, WorkerEvent } from "./worker.js";

export { SessionState, SessionLimits, DEFAULT_SESSION_LIMITS, PLANNING_POLICY_VERSION } from "./autonomy/types.js";
export { buildReport } from "./autonomy/report.js";

export { AutonomousController, newSessionState } from "./autonomy/controller.js";
export type { ControllerOptions, NewSessionOptions } from "./autonomy/controller.js";

export { SimulatorClient, SimulatorError } from "./simulator/client.js";
export { MetaModelProvider, ModelApiError, META_BASE_URL } from "./model/meta.js";
export type { ModelProvider, ModelApiErrorKind, ModelAttempt, RetryPolicy } from "./model/meta.js";
export { SpendGuard, SpendLimitError } from "./model/spendGuard.js";
export { createLogger, silentLogger, redact } from "./logging/logger.js";
export type { Logger, LogLevel } from "./logging/logger.js";
