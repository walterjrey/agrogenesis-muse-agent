import { loadDotEnv } from "../src/config.js";
import { createLogger, type LogLevel } from "../src/logging/logger.js";
import { metaProviderFromEnv } from "../src/model/fromEnv.js";

/** Real connectivity check against Meta Model API. Sends no farm data. Exits non-zero on failure. */
loadDotEnv();
const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || "info", file: "logs/model-ping.jsonl" });

try {
  const provider = metaProviderFromEnv(logger);
  const response = await provider.complete({
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
    maxOutputTokens: 256,
  });
  console.log(JSON.stringify({ ok: true, model: response.model, reply: response.content, finishReason: response.finishReason, usage: response.usage, estimatedCostUsd: response.estimatedCostUsd }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
