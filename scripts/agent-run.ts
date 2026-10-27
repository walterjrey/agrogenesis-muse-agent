import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runAgent } from "../src/agent/runtime.js";
import { DEFAULT_LIMITS, type ExecutionMode, type RunLimits } from "../src/agent/policy.js";
import { loadDotEnv, numberEnv, requireEnv } from "../src/config.js";
import { createLogger, type LogLevel } from "../src/logging/logger.js";
import { metaProviderFromEnv } from "../src/model/fromEnv.js";
import { SimulatorClient } from "../src/simulator/client.js";

/**
 * Real Meta Muse tool-calling run against a running AgroGenesis simulator.
 *
 *   npm run agent:observe                      read-only tools only
 *   npm run agent:test-action -- --enable-mutations --game-id <dedicated test game>
 *
 * Mutations need the explicit flag, an explicitly named game and a Muse-mode game whose token grants act+advance.
 */
loadDotEnv();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "enable-mutations": { type: "boolean", default: false },
    "game-id": { type: "string" },
    "max-model-calls": { type: "string" },
    "max-cost-usd": { type: "string" },
    "max-advance-seconds": { type: "string" },
    "max-mutations": { type: "string" },
  },
});

function fail(message: string, code = 1): never {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

const command = positionals[0];
if (command !== "observe" && command !== "test-action") fail("Usage: agent-run <observe|test-action> [--enable-mutations] [--game-id <id>]", 2);
const mode: ExecutionMode = command === "test-action" ? "controlled_mutation" : "observe_only";
if (mode === "controlled_mutation" && !values["enable-mutations"]) fail("test-action changes the simulated farm; pass --enable-mutations to confirm.", 2);

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fail(`Invalid number: ${raw}`, 2);
  return n;
};
const limits: RunLimits = {
  ...DEFAULT_LIMITS,
  maxModelCalls: num(values["max-model-calls"], DEFAULT_LIMITS.maxModelCalls),
  maxCostUsd: num(values["max-cost-usd"], DEFAULT_LIMITS.maxCostUsd),
  maxTotalAdvanceSeconds: num(values["max-advance-seconds"], DEFAULT_LIMITS.maxTotalAdvanceSeconds),
  maxMutations: num(values["max-mutations"], DEFAULT_LIMITS.maxMutations),
};

const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || "info", file: "logs/agent-run.jsonl" });

try {
  const client = new SimulatorClient({
    baseUrl: requireEnv("SIMULATOR_BASE_URL"),
    agentToken: requireEnv("SIMULATOR_AGENT_TOKEN"),
    timeoutMs: numberEnv("SIMULATOR_TIMEOUT_MS", 15_000),
    logger,
  });

  const requestedGameId = values["game-id"]?.trim() || process.env.SIMULATOR_GAME_ID?.trim() || undefined;
  if (mode === "controlled_mutation" && !requestedGameId) fail("Mutations require an explicitly named test game (--game-id or SIMULATOR_GAME_ID).", 2);

  const { games } = await client.listGames();
  const candidates = requestedGameId ? games.filter((g) => g.gameId === requestedGameId) : games;
  const game = candidates.length === 1 ? candidates[0] : undefined;
  if (!game) fail(requestedGameId ? "The configured game is not authorized for this token." : "Set --game-id: the token does not authorize exactly one game.");
  if (!game.scopes.includes("observe")) fail("The token lacks the observe scope for this game.");
  if (mode === "controlled_mutation") {
    if (game.managementMode !== "muse_ai") fail(`Game management mode is "${game.managementMode}"; mutations require muse_ai.`);
    for (const scope of ["act", "advance"] as const) if (!game.scopes.includes(scope)) fail(`The token lacks the ${scope} scope required for controlled mutation.`);
  }

  const provider = metaProviderFromEnv(logger, { maxCostPerRequestUsd: limits.maxCostPerRequestUsd, maxSessionCostUsd: limits.maxCostUsd, maxOutputTokens: limits.maxOutputTokens });
  const result = await runAgent({ provider, client, gameId: game.gameId, mode, limits });

  mkdirSync("logs/runs", { recursive: true });
  const { trace, ...summary } = result;
  writeFileSync(`logs/runs/${result.runId}.summary.json`, `${JSON.stringify({ ...summary, traceEntries: trace.entries.length }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.status === "completed", ...summary }, null, 2));
  process.exit(result.status === "completed" ? 0 : 1);
} catch (error) {
  logger.log("error", "agent_run.failed", { message: error instanceof Error ? error.message : String(error) });
  fail(error instanceof Error ? error.message : String(error));
}
