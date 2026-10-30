import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { silentLogger, type Logger } from "../logging/logger.js";
import { estimateCostUsd, priceFor, type TokenUsage } from "./pricing.js";
import { classifyResponse, describeResponse } from "./responseClass.js";
import { SpendGuard } from "./spendGuard.js";
import { backoffDelayMs, isRetryableStatus, MODEL_NOT_FOUND_CODE, parseRetryAfterMs, RequestAbortedError, resolveRetryPolicy, safeProviderCode, safeRequestId, sleepAbortable, type ModelAttempt, type RetryPolicy } from "./retry.js";

export type { ModelAttempt, RetryPolicy } from "./retry.js";

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
  /** Aborts the request, including any wait between retry attempts (e.g. worker shutdown). */
  signal?: AbortSignal;
  /** Epoch milliseconds after which no attempt is started and no backoff is waited. */
  deadlineMs?: number;
}

export interface ModelResponse {
  model: string;
  content: string | null;
  toolCalls: ModelToolCall[];
  /** The assistant message exactly as returned; Chat Completions requires it to be replayed before tool results. */
  assistantMessage: ChatCompletionMessageParam;
  finishReason: string;
  usage: TokenUsage | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  requestId: string | null;
  /** Number of choices the provider returned (diagnostics only). */
  choiceCount?: number;
  /** Tool calls in the raw message, including ones that were not usable function calls (diagnostics only). */
  rawToolCallCount?: number;
  /** Every attempt made for this completion, including the successful one. Contains no prompts or credentials. */
  attempts?: ModelAttempt[];
}

/** Provider abstraction so the agent never depends on a specific SDK. */
export interface ModelProvider {
  readonly modelId: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelApiErrorKind = "auth" | "rate_limit" | "bad_request" | "timeout" | "server" | "network" | "aborted";

export interface ModelApiErrorDetails {
  /** Structured provider error code (e.g. `model_not_found`), never free text. */
  code?: string | null;
  requestId?: string | null;
  attempts?: ModelAttempt[];
}

export class ModelApiError extends Error {
  readonly code: string | null;
  readonly requestId: string | null;
  readonly attempts: ModelAttempt[];
  constructor(message: string, readonly kind: ModelApiErrorKind, readonly status?: number, details: ModelApiErrorDetails = {}) {
    super(message);
    this.name = "ModelApiError";
    this.code = details.code ?? null;
    this.requestId = details.requestId ?? null;
    this.attempts = details.attempts ?? [];
  }
}

export interface MetaModelConfig {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  /** Timeout of a single attempt. */
  timeoutMs?: number;
  /** Legacy: retries after the first attempt. `maxAttempts` wins when both are set. */
  maxRetries?: number;
  /** Total attempts including the original request (default 4, at most 8). */
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Longest provider-requested Retry-After that is honored (default 30 s); a longer one stops retrying. */
  retryMaxRetryAfterMs?: number;
  /**
   * Workaround for Meta's intermittent `404 model_not_found` on a valid model: retry that exact status + code pair.
   * Off by default; only applies to models this package prices (known valid). Any other 404 is never retried.
   */
  retryModelNotFound?: boolean;
  /** Overall deadline across all attempts and backoff waits (default 120 s). */
  requestDeadlineMs?: number;
  maxOutputTokens?: number;
  /** Chat Completions `reasoning_effort`; omitted (provider default) when unset. "none" is rejected by Muse Spark (HTTP 400). */
  reasoningEffort?: ReasoningEffort;
  spendGuard: SpendGuard;
  logger?: Logger;
  /** Test seams. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const META_BASE_URL = "https://api.meta.ai/v1";
/** Documented Chat Completions values; "none" is excluded because Muse Spark rejects it with HTTP 400. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_REQUEST_DEADLINE_MS = 120_000;

/** Meta Model API via its OpenAI-compatible Chat Completions endpoint (https://dev.meta.ai/docs). */
export class MetaModelProvider implements ModelProvider {
  readonly modelId: string;
  private readonly client: OpenAI;
  private readonly logger: Logger;
  private readonly policy: RetryPolicy;

  constructor(private readonly config: MetaModelConfig) {
    this.modelId = config.modelId;
    this.logger = config.logger ?? silentLogger;
    this.policy = resolveRetryPolicy({
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.retryBaseDelayMs !== undefined ? { baseDelayMs: config.retryBaseDelayMs } : {}),
      ...(config.retryMaxDelayMs !== undefined ? { maxDelayMs: config.retryMaxDelayMs } : {}),
      ...(config.retryMaxRetryAfterMs !== undefined ? { maxRetryAfterMs: config.retryMaxRetryAfterMs } : {}),
      retryModelNotFound: config.retryModelNotFound === true,
    });
    // Retries are owned by `complete` (so each attempt is recorded and bounded); the SDK must not retry on its own.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? META_BASE_URL,
      timeout: config.timeoutMs ?? 60_000,
      maxRetries: 0,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const maxOutputTokens = request.maxOutputTokens ?? this.config.maxOutputTokens ?? 1024;
    const estimatedPromptTokens = Math.ceil(JSON.stringify({ m: request.messages, t: request.tools ?? [] }).length / 3);
    const worstCaseUsd = this.config.spendGuard.preflight(this.modelId, estimatedPromptTokens, maxOutputTokens);

    const started = Date.now();
    const deadline = Math.min(started + (this.config.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS), request.deadlineMs ?? Infinity);
    const attemptTimeoutMs = this.config.timeoutMs ?? 60_000;
    const sleep = this.config.sleep ?? sleepAbortable;
    const random = this.config.random ?? Math.random;
    const attempts: ModelAttempt[] = [];

    for (let attempt = 1; ; attempt += 1) {
      const attemptStarted = Date.now();
      try {
        if (request.signal?.aborted) throw new RequestAbortedError();
        const remainingMs = deadline - attemptStarted;
        if (attempt > 1 && remainingMs <= 0) throw new ModelApiError("Model request deadline exceeded.", "timeout", undefined, { attempts });
        const { data, requestId } = await this.client.chat.completions
          .create(
            {
              model: this.modelId,
              messages: request.messages,
              ...(request.tools?.length ? { tools: request.tools } : {}),
              max_completion_tokens: maxOutputTokens,
              ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
            },
            { timeout: Math.max(1, Math.min(attemptTimeoutMs, remainingMs)), ...(request.signal ? { signal: request.signal } : {}) },
          )
          .withResponse()
          .then(({ data, response }) => ({ data, requestId: safeRequestId(response.headers.get("x-request-id")) }));

        const choice = data.choices[0];
        if (!choice) throw new ModelApiError("Model returned no choices.", "server", undefined, { requestId });
        attempts.push({ attempt, status: 200, code: null, latencyMs: Date.now() - attemptStarted, requestId, outcome: "success", backoffMs: null, possiblyBillable: true });
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
        // Only the successful response is priced; failed attempts carry no usage statistics.
        this.config.spendGuard.record(cost ?? worstCaseUsd);

        const toolCalls = (choice.message.tool_calls ?? []).flatMap((tc) =>
          tc.type === "function" ? [{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }] : [],
        );
        const response: ModelResponse = {
          model: this.modelId,
          content: choice.message.content,
          toolCalls,
          assistantMessage: replayableAssistantMessage(choice.message),
          finishReason: choice.finish_reason,
          usage,
          estimatedCostUsd: cost,
          latencyMs: Date.now() - started,
          requestId,
          attempts,
          choiceCount: data.choices.length,
          rawToolCallCount: (choice.message.tool_calls ?? []).length,
        };
        const classification = classifyResponse(response);
        if (classification !== "ok") {
          // Content-free: no prompt, no response text, no credentials.
          this.logger.log("error", "model.unusable_response", { model: this.modelId, latencyMs: response.latencyMs, ...describeResponse(response, classification) });
        }
        this.logger.log("info", "model.completion", {
          model: this.modelId,
          finishReason: response.finishReason,
          toolCallCount: toolCalls.length,
          usage,
          estimatedCostUsd: cost,
          sessionSpentUsd: this.config.spendGuard.sessionSpentUsd,
          latencyMs: response.latencyMs,
          requestId: response.requestId,
          attemptCount: attempts.length,
        });
        return response;
      } catch (error) {
        const aborted = error instanceof RequestAbortedError || request.signal?.aborted === true;
        const failure = aborted ? null : this.classify(error);
        const mapped = aborted ? new ModelApiError("Model request aborted.", "aborted", undefined, { attempts }) : failure!.mapped;
        const record: ModelAttempt = {
          attempt,
          status: mapped.status ?? null,
          code: mapped.code,
          latencyMs: Date.now() - attemptStarted,
          requestId: mapped.requestId,
          outcome: "failed",
          backoffMs: null,
          possiblyBillable: !aborted && (mapped.kind === "timeout" || mapped.kind === "network" || mapped.kind === "server"),
        };
        attempts.push(record);

        let retryDelay: number | null = null;
        if (failure?.retryable && attempt < this.policy.maxAttempts) {
          const asked = failure.retryAfterMs;
          if (asked === null || asked <= this.policy.maxRetryAfterMs) {
            const delay = Math.max(backoffDelayMs(attempt, this.policy, random), asked ?? 0);
            if (Date.now() + delay < deadline) retryDelay = delay;
          }
        }
        this.logger.log(retryDelay === null ? "error" : "warn", retryDelay === null ? "model.error" : "model.retry", {
          model: this.modelId,
          kind: mapped.kind,
          status: mapped.status,
          code: mapped.code,
          requestId: mapped.requestId,
          message: mapped.message,
          latencyMs: Date.now() - started,
          attempt,
          maxAttempts: this.policy.maxAttempts,
          ...(retryDelay !== null ? { backoffMs: retryDelay } : {}),
          possiblyBillableAttempts: attempts.filter((a) => a.possiblyBillable && a.outcome !== "success").length,
        });
        if (retryDelay === null) {
          throw new ModelApiError(
            attempts.length > 1 && !aborted ? `${mapped.message.replace(/\.$/, "")} after ${attempts.length} attempts.` : mapped.message,
            mapped.kind,
            mapped.status,
            { code: mapped.code, requestId: mapped.requestId, attempts },
          );
        }
        record.outcome = "retry";
        record.backoffMs = retryDelay;
        try {
          await sleep(retryDelay, request.signal);
        } catch {
          throw new ModelApiError("Model request aborted.", "aborted", undefined, { attempts });
        }
      }
    }
  }

  private classify(error: unknown): { mapped: ModelApiError; retryable: boolean; retryAfterMs: number | null } {
    if (error instanceof ModelApiError) return { mapped: error, retryable: false, retryAfterMs: null };
    if (error instanceof OpenAI.APIConnectionTimeoutError) return { mapped: new ModelApiError("Model API request timed out.", "timeout"), retryable: true, retryAfterMs: null };
    if (error instanceof OpenAI.APIConnectionError) return { mapped: new ModelApiError("Model API is unreachable.", "network"), retryable: true, retryAfterMs: null };
    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      const code = safeProviderCode((error as { code?: unknown }).code) ?? safeProviderCode((error.error as { code?: unknown } | undefined)?.code);
      const headers = error.headers as { get?: (name: string) => string | null } | Record<string, string> | undefined;
      const header = (name: string): string | null => (headers && typeof (headers as { get?: unknown }).get === "function" ? (headers as { get: (n: string) => string | null }).get(name) : ((headers as Record<string, string> | undefined)?.[name] ?? null));
      const requestId = safeRequestId((error as { requestID?: unknown }).requestID) ?? safeRequestId(header("x-request-id"));
      const kind: ModelApiErrorKind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status && status >= 500 ? "server" : "bad_request";
      const retryable = isRetryableStatus(status) || (status === 404 && code === MODEL_NOT_FOUND_CODE && this.policy.retryModelNotFound && priceFor(this.modelId) !== undefined);
      return { mapped: new ModelApiError(`Model API error (HTTP ${status ?? "?"}${code ? ` ${code}` : ""}).`, kind, status, { code, requestId }), retryable, retryAfterMs: parseRetryAfterMs(header("retry-after")) };
    }
    return { mapped: new ModelApiError("Unexpected model client error.", "network"), retryable: false, retryAfterMs: null };
  }
}

/** Keeps only the fields Chat Completions accepts back (role, content, function tool calls). */
function replayableAssistantMessage(message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function?: { name: string; arguments: string } }> }): ChatCompletionMessageParam {
  const toolCalls = (message.tool_calls ?? []).flatMap((tc) =>
    tc.type === "function" && tc.function ? [{ id: tc.id, type: "function" as const, function: { name: tc.function.name, arguments: tc.function.arguments } }] : [],
  );
  return { role: "assistant", content: message.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}
