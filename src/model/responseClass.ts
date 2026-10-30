import type { ModelResponse } from "./meta.js";

/**
 * Why a successful HTTP response carries nothing the agent can act on. Only the first two are retried (once):
 * the others have causes that are not understood yet, so repeating the request would just spend budget.
 */
export type ResponseClassification = "ok" | "empty_content" | "reasoning_only" | "truncated" | "unexpected_tool_format";

export const RETRYABLE_CLASSIFICATIONS: ReadonlySet<ResponseClassification> = new Set(["empty_content", "reasoning_only"]);

export function classifyResponse(response: Pick<ModelResponse, "content" | "toolCalls" | "finishReason" | "usage" | "rawToolCallCount">): ResponseClassification {
  if (response.toolCalls.length > 0) return "ok";
  if ((response.content ?? "").trim() !== "") return "ok";
  // The provider returned tool calls we could not use, or announced them without sending any.
  if ((response.rawToolCallCount ?? 0) > 0 || response.finishReason === "tool_calls") return "unexpected_tool_format";
  if (response.finishReason === "length") return "truncated";
  const reasoning = response.usage?.reasoningTokens ?? 0;
  return reasoning > 0 ? "reasoning_only" : "empty_content";
}

/** Structured, content-free facts about an unusable response. Never contains prompts, text or credentials. */
export interface ResponseDiagnostic {
  httpStatus: number;
  requestId: string | null;
  classification: Exclude<ResponseClassification, "ok">;
  finishReason: string | null;
  choiceCount: number | null;
  hasContent: boolean;
  toolCallCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}

export function formatResponseDiagnostic(d: ResponseDiagnostic): string {
  const tokens = `tokens in=${d.promptTokens ?? "?"} out=${d.completionTokens ?? "?"} reasoning=${d.reasoningTokens ?? "?"}`;
  return `empty_response: ${d.classification} (HTTP ${d.httpStatus}, finish_reason=${d.finishReason ?? "none"}, choices=${d.choiceCount ?? "?"}, content=${d.hasContent ? "yes" : "no"}, tool_calls=${d.toolCallCount}, ${tokens}, request=${d.requestId ?? "n/a"})`;
}

export function describeResponse(response: ModelResponse, classification: Exclude<ResponseClassification, "ok">): ResponseDiagnostic {
  return {
    httpStatus: 200,
    requestId: response.requestId,
    classification,
    finishReason: typeof response.finishReason === "string" ? response.finishReason.slice(0, 40) : null,
    choiceCount: response.choiceCount ?? null,
    hasContent: (response.content ?? "").trim() !== "",
    toolCallCount: Math.max(response.toolCalls.length, response.rawToolCallCount ?? 0),
    promptTokens: response.usage?.promptTokens ?? null,
    completionTokens: response.usage?.completionTokens ?? null,
    reasoningTokens: response.usage?.reasoningTokens ?? null,
  };
}
