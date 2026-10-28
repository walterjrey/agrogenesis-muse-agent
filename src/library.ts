import { MetaModelProvider, META_BASE_URL, type ModelProvider } from "./model/meta.js";
import { SpendGuard } from "./model/spendGuard.js";
import { silentLogger, type Logger } from "./logging/logger.js";
import { SimulatorClient } from "./simulator/client.js";
import { AutonomousController, newSessionState } from "./autonomy/controller.js";
import { buildReport } from "./autonomy/report.js";
import type { SessionBackend } from "./autonomy/storage.js";
import { DEFAULT_SESSION_LIMITS, type ScenarioManifest, type SessionLimits, type SessionState } from "./autonomy/types.js";

/** Server-side connection to the simulator's agent API. The token is held in memory only and never persisted. */
export interface SimulatorConnection {
  baseUrl: string;
  agentToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Server-side Meta Model API settings, or an injected provider (tests, other model backends). */
export type ModelConnection =
  | {
      apiKey: string;
      modelId?: string;
      baseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
      /** Hard ceilings enforced by the spend guard in addition to the session limits (which can only tighten them). */
      maxCostPerRequestUsd?: number;
      maxSessionCostUsd?: number;
    }
  | { provider: ModelProvider };

export interface AgentDependencies {
  backend: SessionBackend;
  simulator: SimulatorConnection;
  model: ModelConnection;
  logger?: Logger;
}

export interface StartSessionOptions {
  gameId: string;
  sessionId?: string;
  /** Default false: an observe-only session. Mutations additionally require explicit budgets in `limits`. */
  mutationsEnabled?: boolean;
  limits?: Partial<SessionLimits>;
  objective?: string;
  autoWait?: boolean;
  /** Evaluation horizon in simulated days; persisted with the session and not changeable afterwards. */
  planningHorizonDays?: number;
  scenario?: Partial<ScenarioManifest>;
}

export interface RunSliceOptions {
  sessionId: string;
  /** Must be re-confirmed on every call; a session created observe-only can never mutate. Default false. */
  mutationsEnabled?: boolean;
  /** Decision cycles to run before pausing with `slice_complete` (default 3). */
  sliceCycles?: number;
  onEvent?: (message: string) => void;
}

export interface SliceResult {
  state: SessionState;
  report: ReturnType<typeof buildReport>;
  /** True when the session ended (completed, stopped or failed) rather than paused and resumable. */
  finished: boolean;
}

export const DEFAULT_SLICE_CYCLES = 3;
const REQUIRED_MUTATION_BUDGETS = ["maxCostUsd", "maxMutations", "maxModelCalls", "maxSimSeconds"] as const;

function simulatorClient(deps: AgentDependencies): SimulatorClient {
  return new SimulatorClient({
    baseUrl: deps.simulator.baseUrl,
    agentToken: deps.simulator.agentToken,
    ...(deps.simulator.timeoutMs !== undefined ? { timeoutMs: deps.simulator.timeoutMs } : {}),
    ...(deps.simulator.fetchImpl ? { fetchImpl: deps.simulator.fetchImpl } : {}),
    logger: deps.logger ?? silentLogger,
  });
}

function modelProvider(deps: AgentDependencies, limits: SessionLimits, alreadySpentUsd: number): ModelProvider {
  const model = deps.model;
  if ("provider" in model) return model.provider;
  const perRequest = model.maxCostPerRequestUsd ?? 0.05;
  const session = model.maxSessionCostUsd ?? 1;
  return new MetaModelProvider({
    apiKey: model.apiKey,
    modelId: model.modelId ?? "muse-spark-1.3",
    baseUrl: model.baseUrl ?? META_BASE_URL,
    timeoutMs: model.timeoutMs ?? 60_000,
    maxRetries: model.maxRetries ?? 2,
    maxOutputTokens: limits.maxOutputTokens,
    spendGuard: new SpendGuard({
      maxCostPerRequestUsd: Math.min(perRequest, limits.maxCostPerRequestUsd),
      maxSessionCostUsd: Math.min(session, Math.max(0.0001, limits.maxCostUsd - alreadySpentUsd)),
    }),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/** Throws unless the token is authorized for the game with the scopes (and management mode) the session needs. */
async function assertAuthorized(client: SimulatorClient, gameId: string, mutations: boolean): Promise<void> {
  const { games } = await client.listGames();
  const game = games.find((g) => g.gameId === gameId);
  if (!game) throw new Error("The configured game is not authorized for this token.");
  if (!game.scopes.includes("observe")) throw new Error("The token lacks the observe scope for this game.");
  if (!mutations) return;
  if (game.managementMode !== "muse_ai") throw new Error(`Game management mode is "${game.managementMode}"; mutations require muse_ai.`);
  for (const scope of ["act", "advance"] as const) if (!game.scopes.includes(scope)) throw new Error(`The token lacks the ${scope} scope required for mutations.`);
}

/**
 * Validates session options and builds the credential-free initial state. Pure: no network, no storage. Used by
 * `startSession` and by a web process that must enqueue a session without holding any agent or model credentials
 * (it must then verify game ownership itself; the worker re-checks token authorization on every slice).
 */
export function buildSessionRecord(options: StartSessionOptions, modelId: string): SessionState {
  const mutations = options.mutationsEnabled === true;
  if (!options.gameId.trim()) throw new Error("gameId is required.");
  if (mutations) {
    for (const field of REQUIRED_MUTATION_BUDGETS) if (options.limits?.[field] === undefined) throw new Error(`Mutations require an explicit budget: limits.${field}.`);
    if ((options.limits?.maxMutations ?? 0) < 1) throw new Error("limits.maxMutations must be at least 1 when mutations are enabled.");
  }
  if (options.planningHorizonDays !== undefined && !(options.planningHorizonDays > 0)) throw new Error("planningHorizonDays must be greater than 0.");
  const limits: SessionLimits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
  return newSessionState({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    gameId: options.gameId,
    modelId,
    mutationsEnabled: mutations,
    autoWait: options.autoWait ?? true,
    ...(options.objective ? { objective: options.objective } : {}),
    limits,
    planning: options.planningHorizonDays !== undefined ? { horizonDays: options.planningHorizonDays } : {},
    ...(options.scenario ? { scenario: options.scenario } : {}),
  });
}

/** Creates and persists a new session (status `paused`, nothing executed). Chooses no game automatically. */
export async function startSession(deps: AgentDependencies, options: StartSessionOptions): Promise<SessionState> {
  const mutations = options.mutationsEnabled === true;
  const limits: SessionLimits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
  const preview = buildSessionRecord(options, modelProvider(deps, limits, 0).modelId);
  await assertAuthorized(simulatorClient(deps), options.gameId, mutations);
  await deps.backend.create(preview);
  return preview;
}

/**
 * Runs one bounded slice of a session and returns. Call it from a worker or a job runner, never from inside an HTTP
 * request handler: a slice can take minutes (model calls plus server-side waiting). Progress is persisted after every
 * state-changing step, so a slice that dies mid-way is recovered by the next call (same idempotency keys, no repeats).
 */
export async function runSessionSlice(deps: AgentDependencies, options: RunSliceOptions): Promise<SliceResult> {
  const stored = await deps.backend.load(options.sessionId);
  const mutations = options.mutationsEnabled === true && stored.config.mutationsEnabled;
  const client = simulatorClient(deps);
  await assertAuthorized(client, stored.gameId, mutations);
  const provider = modelProvider(deps, stored.config.limits, stored.budgets.costUsd);
  if (provider.modelId !== stored.config.modelId) throw new Error(`Session was created with model ${stored.config.modelId} but the configuration selects ${provider.modelId}.`);
  const controller = new AutonomousController({
    store: deps.backend,
    sessionId: options.sessionId,
    provider,
    client,
    mutationsEnabled: mutations,
    sliceCycles: options.sliceCycles ?? DEFAULT_SLICE_CYCLES,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const state = await controller.run();
  return { state, report: buildReport(state), finished: state.status !== "paused" && state.status !== "running" };
}

/** Read-only view of a persisted session. Contains no credentials and no simulator snapshot. */
export async function getSessionReport(backend: SessionBackend, sessionId: string): Promise<ReturnType<typeof buildReport>> {
  return buildReport(await backend.load(sessionId));
}
