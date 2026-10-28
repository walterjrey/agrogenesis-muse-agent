import { numberEnv, requireEnv } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { MetaModelProvider, META_BASE_URL } from "./meta.js";
import { SpendGuard } from "./spendGuard.js";

export interface ProviderOverrides {
  maxCostPerRequestUsd?: number;
  maxSessionCostUsd?: number;
  maxOutputTokens?: number;
}

/** Explicit overrides (from the run's limits) can only tighten the env-configured spend limits. */
export function metaProviderFromEnv(logger: Logger, overrides: ProviderOverrides = {}): MetaModelProvider {
  const perRequest = numberEnv("MODEL_MAX_COST_PER_REQUEST_USD", 0.05);
  const session = numberEnv("MODEL_MAX_SESSION_COST_USD", 1);
  return new MetaModelProvider({
    apiKey: requireEnv("MODEL_API_KEY"),
    modelId: process.env.MODEL_ID?.trim() || "muse-spark-1.3",
    baseUrl: process.env.MODEL_BASE_URL?.trim() || META_BASE_URL,
    timeoutMs: numberEnv("MODEL_TIMEOUT_MS", 60_000),
    maxAttempts: process.env.MODEL_MAX_RETRIES?.trim() ? numberEnv("MODEL_MAX_RETRIES", 3) + 1 : numberEnv("MODEL_MAX_ATTEMPTS", 4),
    retryModelNotFound: process.env.MODEL_RETRY_MODEL_NOT_FOUND === "true",
    requestDeadlineMs: numberEnv("MODEL_REQUEST_DEADLINE_MS", 120_000),
    maxOutputTokens: overrides.maxOutputTokens ?? numberEnv("MODEL_MAX_OUTPUT_TOKENS", 1024),
    spendGuard: new SpendGuard({
      maxCostPerRequestUsd: Math.min(perRequest, overrides.maxCostPerRequestUsd ?? perRequest),
      maxSessionCostUsd: Math.min(session, overrides.maxSessionCostUsd ?? session),
    }),
    logger,
  });
}
