import { numberEnv, requireEnv } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { MetaModelProvider, META_BASE_URL } from "./meta.js";
import { SpendGuard } from "./spendGuard.js";

export function metaProviderFromEnv(logger: Logger): MetaModelProvider {
  return new MetaModelProvider({
    apiKey: requireEnv("MODEL_API_KEY"),
    modelId: process.env.MODEL_ID?.trim() || "muse-spark-1.3",
    baseUrl: process.env.MODEL_BASE_URL?.trim() || META_BASE_URL,
    timeoutMs: numberEnv("MODEL_TIMEOUT_MS", 60_000),
    maxRetries: numberEnv("MODEL_MAX_RETRIES", 2),
    maxOutputTokens: numberEnv("MODEL_MAX_OUTPUT_TOKENS", 1024),
    spendGuard: new SpendGuard({
      maxCostPerRequestUsd: numberEnv("MODEL_MAX_COST_PER_REQUEST_USD", 0.05),
      maxSessionCostUsd: numberEnv("MODEL_MAX_SESSION_COST_USD", 1),
    }),
    logger,
  });
}
