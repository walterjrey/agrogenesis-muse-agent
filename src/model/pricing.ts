/** USD per 1,000,000 tokens, Standard mode, from https://dev.meta.ai/docs/pricing-rate-limits (verified 2026-10-26). */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Contributor-mode variants (`*-contributor`) are intentionally absent: they let Meta train on prompts
 * and responses, so they must never be enabled implicitly for farm data.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4.0, cachedInput: 0.2, output: 20.0 },
};

export interface TokenUsage {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
  totalTokens: number;
}

export function priceFor(model: string): ModelPrice | undefined {
  return MODEL_PRICING[model];
}

/** Estimated USD cost. Reasoning tokens are assumed to be included in `completionTokens` (billed as output). */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  if (!price) throw new Error(`No pricing known for model "${model}".`);
  const uncached = Math.max(0, usage.promptTokens - usage.cachedPromptTokens);
  return (uncached * price.input + usage.cachedPromptTokens * price.cachedInput + usage.completionTokens * price.output) / 1_000_000;
}
