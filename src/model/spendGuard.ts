import { estimateCostUsd } from "./pricing.js";

export class SpendLimitError extends Error {
  constructor(message: string, readonly limit: "per_request" | "session" | "unknown_pricing") {
    super(message);
    this.name = "SpendLimitError";
  }
}

export interface SpendLimits {
  maxCostPerRequestUsd: number;
  maxSessionCostUsd: number;
}

/** Blocks requests whose worst-case cost would break a limit, and accumulates actual estimated spend. */
export class SpendGuard {
  private spentUsd = 0;

  constructor(private readonly limits: SpendLimits) {}

  get sessionSpentUsd(): number {
    return this.spentUsd;
  }

  /** Worst case = every estimated prompt token plus the full output allowance, all uncached. */
  preflight(model: string, estimatedPromptTokens: number, maxOutputTokens: number): number {
    let worstCase: number;
    try {
      worstCase = estimateCostUsd(model, {
        promptTokens: estimatedPromptTokens,
        cachedPromptTokens: 0,
        completionTokens: maxOutputTokens,
        reasoningTokens: null,
        totalTokens: estimatedPromptTokens + maxOutputTokens,
      });
    } catch (error) {
      throw new SpendLimitError(error instanceof Error ? error.message : "Unknown pricing.", "unknown_pricing");
    }
    if (worstCase > this.limits.maxCostPerRequestUsd) {
      throw new SpendLimitError(`Worst-case request cost $${worstCase.toFixed(4)} exceeds the per-request limit $${this.limits.maxCostPerRequestUsd}.`, "per_request");
    }
    if (this.spentUsd + worstCase > this.limits.maxSessionCostUsd) {
      throw new SpendLimitError(`Request could exceed the session budget $${this.limits.maxSessionCostUsd} (spent $${this.spentUsd.toFixed(4)}).`, "session");
    }
    return worstCase;
  }

  record(costUsd: number): void {
    this.spentUsd += costUsd;
  }
}
