import { loadDotEnv, numberEnv, requireEnv } from "../src/config.js";
import { createLogger, type LogLevel } from "../src/logging/logger.js";
import { SimulatorClient } from "../src/simulator/client.js";
import { runReadOnlyIntegration } from "../src/simulator/integration.js";

/**
 * REAL integration check against a running AgroGenesis simulator exposing the agent API
 * (docs/SIMULATOR_INTEGRATION.md). Read-only: it never executes actions or advances the clock.
 */
loadDotEnv();
const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || "info", file: "logs/integration.jsonl" });

try {
  const client = new SimulatorClient({
    baseUrl: requireEnv("SIMULATOR_BASE_URL"),
    agentToken: requireEnv("SIMULATOR_AGENT_TOKEN"),
    timeoutMs: numberEnv("SIMULATOR_TIMEOUT_MS", 15_000),
    logger,
  });
  const report = await runReadOnlyIntegration(client, logger, process.env.SIMULATOR_GAME_ID?.trim() || undefined);
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (error) {
  logger.log("error", "integration.failed", { message: error instanceof Error ? error.message : String(error) });
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
