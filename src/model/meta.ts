import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { silentLogger, type Logger } from "../logging/logger.js";
import { estimateCostUsd, type TokenUsage } from "./pricing.js";
import { SpendGuard } from "./spendGuard.js";

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model. It is untrusted and must be validated before use. */
  arguments: string;
}

export interface ModelRequest {
  messages: ChatCompletionMessageParam[];
  /** Function tools only; Chat Completions on Meta Model API supports `tool_choice: "auto"` only. */
  tools?: ChatCompletionTool[];
  maxOutputTokens?: number;
}

export interface ModelResponse {
  model: string;
  content: string | null;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage: TokenUsage | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  requestId: string | null;
}

/** Provider abstraction so the agent never depends on a specific SDK. */
export interface ModelProvider {
  readonly modelId: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelApiError extends Error {
  constructor(message: string, readonly kind: "auth" | "rate_limit" | "bad_request" | "timeout" | "server" | "network", readonly status?: number) {
    super(message);
    this.name = "ModelApiError";
  }
}

export interface MetaModelConfig {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  spendGuard: SpendGuard;
  logger?: Logger;
}

export const META_BASE_URL = "https://api.meta.ai/v1";

/** Meta Model API via its OpenAI-compatible Chat Completions endpoint (https://dev.meta.ai/docs). */
export class MetaModelProvider implements ModelProvider {
  readonly modelId: string;
  private readonly client: OpenAI;
  private readonly logger: Logger;

  constructor(private readonly config: MetaModelConfig) {
    this.modelId = config.modelId;
    this.logger = config.logger ?? silentLogger;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? META_BASE_URL,
      timeout: config.timeoutMs ?? 60_000,
      maxRetries: config.maxRetries ?? 2,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const maxOutputTokens = request.maxOutputTokens ?? this.config.maxOutputTokens ?? 1024;
    const estimatedPromptTokens = Math.ceil(JSON.stringify({ m: request.messages, t: request.tools ?? [] }).length / 3);
    const worstCaseUsd = this.config.spendGuard.preflight(this.modelId, estimatedPromptTokens, maxOutputTokens);

    const started = Date.now();
    try {
      const { data, request_id } = await this.client.chat.completions
        .create({
          model: this.modelId,
          messages: request.messages,
          ...(request.tools?.length ? { tools: request.tools } : {}),
          max_completion_tokens: maxOutputTokens,
        })
        .withResponse()
        .then(({ data, response }) => ({ data, request_id: response.headers.get("x-request-id") }));

      const choice = data.choices[0];
      if (!choice) throw new ModelApiError("Model returned no choices.", "server");
      const usage: TokenUsage | null = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            cachedPromptTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
            completionTokens: data.usage.completion_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? null,
            totalTokens: data.usage.total_tokens,
          }
        : null;
      const cost = usage ? estimateCostUsd(this.modelId, usage) : null;
      this.config.spendGuard.record(cost ?? worstCaseUsd);

      const toolCalls = (choice.message.tool_calls ?? []).flatMap((tc) =>
        tc.type === "function" ? [{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }] : [],
      );
      const response: ModelResponse = {
        model: this.modelId,
        content: choice.message.content,
        toolCalls,
        finishReason: choice.finish_reason,
        usage,
        estimatedCostUsd: cost,
        latencyMs: Date.now() - started,
        requestId: request_id,
      };
      this.logger.log("info", "model.completion", {
        model: this.modelId,
        finishReason: response.finishReason,
        toolCallCount: toolCalls.length,
        usage,
        estimatedCostUsd: cost,
        sessionSpentUsd: this.config.spendGuard.sessionSpentUsd,
        latencyMs: response.latencyMs,
        requestId: response.requestId,
      });
      return response;
    } catch (error) {
      const mapped = mapError(error);
      this.logger.log("error", "model.error", { model: this.modelId, kind: mapped.kind, status: mapped.status, message: mapped.message, latencyMs: Date.now() - started });
      throw mapped;
    }
  }
}

function mapError(error: unknown): ModelApiError {
  if (error instanceof ModelApiError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ModelApiError("Model API request timed out.", "timeout");
  if (error instanceof OpenAI.APIConnectionError) return new ModelApiError("Model API is unreachable.", "network");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status && status >= 500 ? "server" : "bad_request";
    return new ModelApiError(`Model API error (HTTP ${status ?? "?"}).`, kind, status);
  }
  return new ModelApiError("Unexpected model client error.", "network");
}
