import { AUTONOMOUS_SYSTEM_PROMPT, buildBriefSections, type CycleBriefInput } from "./prompt.js";

/**
 * Heuristic chars-per-token used only to LABEL ESTIMATES in logs/diagnostics; it is never sent to the model and
 * never substituted for provider-reported usage. Real token counts always come from the model response's own
 * `usage` (see TokenUsage in ../model/pricing.js) when available.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

export interface BriefSectionSize {
  section: string;
  chars: number;
  /** Estimated via CHARS_PER_TOKEN_ESTIMATE; label as "estimated" wherever this is surfaced alongside real usage. */
  estimatedTokens: number;
}

export interface BriefSizeReport {
  cycle: number;
  /** Per top-level section of the cycle brief, in the exact shape sent to the model (JSON.stringify of each value). */
  sections: BriefSectionSize[];
  /** The brief body only (excludes the constant system prompt and the short wrapper sentence). */
  briefChars: number;
  briefEstimatedTokens: number;
  /** AUTONOMOUS_SYSTEM_PROMPT is a byte-identical constant across cycles; providers that support prefix/prompt
   * caching (confirmed for Muse Spark 1.3 via its cachedInput pricing tier) can serve it at a steep discount after
   * the first cycle, so it is reported separately rather than folded into the per-cycle total. */
  systemPromptChars: number;
  systemPromptEstimatedTokens: number;
  totalEstimatedTokens: number;
}

/**
 * Measures the serialized size of every top-level section of a cycle brief, for diagnostics and benchmarking only.
 * This never changes what is sent to the model; it re-derives the same structure cycleBrief() builds and measures
 * it section by section so regressions (e.g. a reintroduced duplicate) are visible per section, not just in total.
 */
export function measureCycleBrief(input: CycleBriefInput): BriefSizeReport {
  const brief = buildBriefSections(input);
  const sections: BriefSectionSize[] = Object.entries(brief).map(([section, value]) => {
    const chars = JSON.stringify(value)?.length ?? 0;
    return { section, chars, estimatedTokens: estimateTokens(chars) };
  });
  const briefChars = sections.reduce((sum, s) => sum + s.chars, 0);
  const systemPromptChars = AUTONOMOUS_SYSTEM_PROMPT.length;
  const briefEstimatedTokens = estimateTokens(briefChars);
  const systemPromptEstimatedTokens = estimateTokens(systemPromptChars);
  return {
    cycle: input.state.cycle,
    sections,
    briefChars,
    briefEstimatedTokens,
    systemPromptChars,
    systemPromptEstimatedTokens,
    totalEstimatedTokens: briefEstimatedTokens + systemPromptEstimatedTokens,
  };
}
