import { parseArgs } from "node:util";
import { loadDotEnv, numberEnv, requireEnv } from "../src/config.js";
import { createLogger, type LogLevel } from "../src/logging/logger.js";
import { metaProviderFromEnv } from "../src/model/fromEnv.js";
import { AutonomousController, newSessionState } from "../src/autonomy/controller.js";
import { buildReport } from "../src/autonomy/report.js";
import { SessionLockedError, SessionStore } from "../src/autonomy/store.js";
import { DEFAULT_SESSION_LIMITS, type SessionLimits } from "../src/autonomy/types.js";
import { SimulatorClient } from "../src/simulator/client.js";

/**
 *   npm run agent:autonomous -- --game-id <id> [--enable-mutations --max-cost-usd 1 --max-mutations 3 --max-sim-days 1 --max-model-calls 20]
 *   npm run agent:resume     -- --session-id <id> [--enable-mutations]
 *   npm run agent:status     -- [--session-id <id>] [--decisions]
 *
 * Observe-only by default. Mutations need --enable-mutations, an explicit game, an isolated Muse-mode test game and
 * explicit cost/mutation/time/model-call budgets. Credentials come from the environment and are never persisted.
 */
loadDotEnv();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "game-id": { type: "string" },
    "session-id": { type: "string" },
    "sessions-dir": { type: "string", default: "sessions" },
    "enable-mutations": { type: "boolean", default: false },
    objective: { type: "string" },
    "slice-cycles": { type: "string" },
    decisions: { type: "boolean", default: false },
    "max-cost-usd": { type: "string" },
    "max-model-calls": { type: "string" },
    "max-tool-calls": { type: "string" },
    "max-mutations": { type: "string" },
    "max-sim-seconds": { type: "string" },
    "max-sim-days": { type: "string" },
    "max-advance-requests": { type: "string" },
    "max-consecutive-advances": { type: "string" },
    "max-conflicts": { type: "string" },
    "max-farm-spend": { type: "string" },
    "no-auto-wait": { type: "boolean", default: false },
    "max-wall-minutes": { type: "string" },
    "max-cycles": { type: "string" },
    "max-consecutive-errors": { type: "string" },
    "max-consecutive-no-progress": { type: "string" },
  },
});

function fail(message: string, code = 1): never {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

const num = (name: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fail(`Invalid --${name}: ${raw}`, 2);
  return n;
};

const command = positionals[0];
if (command !== "start" && command !== "resume" && command !== "status") fail("Usage: agent-autonomous <start|resume|status> [options]", 2);
const store = new SessionStore(values["sessions-dir"] ?? "sessions");

if (command === "status") {
  const id = values["session-id"] ?? store.list().at(-1)?.sessionId;
  if (!id) {
    console.log(JSON.stringify({ sessions: store.list() }, null, 2));
    process.exit(0);
  }
  const state = store.load(id);
  console.log(JSON.stringify({ report: buildReport(state), plan: state.plan, ...(values.decisions ? { decisions: state.decisions, operations: state.operations, actions: state.actions } : { recentDecisions: state.decisions.slice(-3).map((d) => ({ cycle: d.cycle, summary: d.summary, progress: d.progress })) }) }, null, 2));
  process.exit(0);
}

const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || "info", file: "logs/agent-autonomous.jsonl" });
const say = (m: string) => console.error(`[agent] ${m}`);

try {
  const client = new SimulatorClient({
    baseUrl: requireEnv("SIMULATOR_BASE_URL"),
    agentToken: requireEnv("SIMULATOR_AGENT_TOKEN"),
    timeoutMs: numberEnv("SIMULATOR_TIMEOUT_MS", 15_000),
    logger,
  });
  const mutations = values["enable-mutations"] === true;

  let sessionId: string;
  let limits: SessionLimits;
  let modelId: string | undefined;
  let gameId: string;

  if (command === "start") {
    gameId = values["game-id"]?.trim() ?? "";
    if (!gameId) fail("--game-id is required (no game is ever chosen automatically).", 2);
    const overrides: Partial<SessionLimits> = {
      ...(num("max-cost-usd", values["max-cost-usd"]) !== undefined && { maxCostUsd: num("max-cost-usd", values["max-cost-usd"])! }),
      ...(num("max-model-calls", values["max-model-calls"]) !== undefined && { maxModelCalls: num("max-model-calls", values["max-model-calls"])! }),
      ...(num("max-tool-calls", values["max-tool-calls"]) !== undefined && { maxToolCalls: num("max-tool-calls", values["max-tool-calls"])! }),
      ...(num("max-mutations", values["max-mutations"]) !== undefined && { maxMutations: num("max-mutations", values["max-mutations"])! }),
      ...(num("max-sim-seconds", values["max-sim-seconds"]) !== undefined && { maxSimSeconds: num("max-sim-seconds", values["max-sim-seconds"])! }),
      ...(num("max-sim-days", values["max-sim-days"]) !== undefined && { maxSimSeconds: num("max-sim-days", values["max-sim-days"])! * 60 }),
      ...(num("max-advance-requests", values["max-advance-requests"]) !== undefined && { maxAdvanceRequests: num("max-advance-requests", values["max-advance-requests"])! }),
      ...(num("max-consecutive-advances", values["max-consecutive-advances"]) !== undefined && { maxConsecutiveAdvances: num("max-consecutive-advances", values["max-consecutive-advances"])! }),
      ...(num("max-conflicts", values["max-conflicts"]) !== undefined && { maxConflicts: num("max-conflicts", values["max-conflicts"])! }),
      ...(num("max-farm-spend", values["max-farm-spend"]) !== undefined && { maxFarmSpendCredits: num("max-farm-spend", values["max-farm-spend"])! }),
      ...(num("max-wall-minutes", values["max-wall-minutes"]) !== undefined && { maxWallClockMs: num("max-wall-minutes", values["max-wall-minutes"])! * 60_000 }),
      ...(num("max-cycles", values["max-cycles"]) !== undefined && { maxCycles: num("max-cycles", values["max-cycles"])! }),
      ...(num("max-consecutive-errors", values["max-consecutive-errors"]) !== undefined && { maxConsecutiveErrors: num("max-consecutive-errors", values["max-consecutive-errors"])! }),
      ...(num("max-consecutive-no-progress", values["max-consecutive-no-progress"]) !== undefined && { maxConsecutiveNoProgress: num("max-consecutive-no-progress", values["max-consecutive-no-progress"])! }),
    };
    if (mutations) {
      for (const flag of ["max-cost-usd", "max-mutations", "max-model-calls"] as const) {
        if (values[flag] === undefined) fail(`--enable-mutations requires explicit budgets: missing --${flag}.`, 2);
      }
      if (values["max-sim-seconds"] === undefined && values["max-sim-days"] === undefined) fail("--enable-mutations requires an explicit simulated-time budget: --max-sim-days or --max-sim-seconds.", 2);
      if ((overrides.maxMutations ?? 0) < 1) fail("--max-mutations must be at least 1 when mutations are enabled.", 2);
    }

    const { games } = await client.listGames();
    const game = games.find((g) => g.gameId === gameId);
    if (!game) fail("The configured game is not authorized for this token.");
    if (!game.scopes.includes("observe")) fail("The token lacks the observe scope for this game.");
    if (mutations) {
      if (game.managementMode !== "muse_ai") fail(`Game management mode is "${game.managementMode}"; mutations require muse_ai.`);
      for (const scope of ["act", "advance"] as const) if (!game.scopes.includes(scope)) fail(`The token lacks the ${scope} scope required for mutations.`);
    }
    limits = { ...DEFAULT_SESSION_LIMITS, ...overrides };
    const provider = metaProviderFromEnv(logger, { maxCostPerRequestUsd: limits.maxCostPerRequestUsd, maxSessionCostUsd: limits.maxCostUsd, maxOutputTokens: limits.maxOutputTokens });
    modelId = provider.modelId;
    const state = newSessionState({ ...(values["session-id"] ? { sessionId: values["session-id"] } : {}), gameId, modelId, mutationsEnabled: mutations, autoWait: values["no-auto-wait"] !== true, ...(values.objective ? { objective: values.objective } : {}), limits });
    if (store.exists(state.sessionId)) fail(`Session ${state.sessionId} already exists; use agent:resume.`, 2);
    const lock = store.acquire(state.sessionId);
    lock.save(state);
    lock.release();
    sessionId = state.sessionId;
  } else {
    sessionId = values["session-id"] ?? "";
    if (!sessionId) fail("--session-id is required.", 2);
    const existing = store.load(sessionId);
    gameId = existing.gameId;
    limits = existing.config.limits;
    modelId = existing.config.modelId;
    if (mutations && !existing.config.mutationsEnabled) fail("This session was created observe-only; it cannot be upgraded to mutations. Start a new session.", 2);
    const { games } = await client.listGames();
    const game = games.find((g) => g.gameId === gameId);
    if (!game) fail("The session's game is not authorized for this token.");
    if (mutations && game.managementMode !== "muse_ai") fail(`Game management mode is "${game.managementMode}"; mutations require muse_ai.`);
  }

  const resumed = command === "resume" ? store.load(sessionId) : null;
  const spent = resumed?.budgets.costUsd ?? 0;
  const provider = metaProviderFromEnv(logger, { maxCostPerRequestUsd: limits.maxCostPerRequestUsd, maxSessionCostUsd: Math.max(0.0001, limits.maxCostUsd - spent), maxOutputTokens: limits.maxOutputTokens });
  if (modelId && provider.modelId !== modelId) fail(`Session was created with model ${modelId} but the environment selects ${provider.modelId}.`, 2);

  const sliceCycles = num("slice-cycles", values["slice-cycles"]);
  say(`${command} session ${sessionId} on game ${gameId} (mutations ${mutations ? "ENABLED" : "disabled"})`);
  const controller = new AutonomousController({ store, sessionId, provider, client, mutationsEnabled: mutations, ...(sliceCycles !== undefined ? { sliceCycles } : {}), onEvent: say });
  const state = await controller.run();
  console.log(JSON.stringify({ ok: state.status !== "failed", sessionId, report: buildReport(state) }, null, 2));
  process.exit(0);
} catch (error) {
  if (error instanceof SessionLockedError) fail(error.message, 3);
  logger.log("error", "agent_autonomous.failed", { message: error instanceof Error ? error.message : String(error) });
  fail(error instanceof Error ? error.message : String(error));
}
