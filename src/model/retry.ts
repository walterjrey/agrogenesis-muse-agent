/** Pure helpers for the Meta provider's bounded retry policy. Nothing here touches the network or credentials. */

export interface ModelAttempt {
  /** 1-based attempt number, including the original request. */
  attempt: number;
  /** HTTP status when the provider answered; null for network failures, timeouts and local aborts. */
  status: number | null;
  /** Structured provider error code (`error.code`), only when it is a short identifier. */
  code: string | null;
  latencyMs: number;
  requestId: string | null;
  outcome: "success" | "retry" | "failed";
  /** Delay before the next attempt, when outcome is "retry". */
  backoffMs: number | null;
  /**
   * True when the provider may have processed the request even though no usable response arrived (timeouts, dropped
   * connections, 5xx). Such attempts cannot be priced, so they are reported rather than silently ignored.
   */
  possiblyBillable: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest Retry-After the provider may ask for; anything longer is treated as "do not retry". */
  maxRetryAfterMs: number;
  /** Retry HTTP 404 only when the structured provider code is exactly `model_not_found`. Off by default. */
  retryModelNotFound: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  retryModelNotFound: false,
};

export const MAX_ATTEMPTS_CEILING = 8;
export const MODEL_NOT_FOUND_CODE = "model_not_found";

export function resolveRetryPolicy(input: Partial<RetryPolicy> & { maxRetries?: number }): RetryPolicy {
  const requested = input.maxAttempts ?? (input.maxRetries !== undefined ? input.maxRetries + 1 : DEFAULT_RETRY_POLICY.maxAttempts);
  return {
    maxAttempts: Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Math.floor(requested))),
    baseDelayMs: Math.max(0, input.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: Math.max(0, input.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs),
    maxRetryAfterMs: Math.max(0, input.maxRetryAfterMs ?? DEFAULT_RETRY_POLICY.maxRetryAfterMs),
    retryModelNotFound: input.retryModelNotFound === true,
  };
}

/** HTTP statuses that are retried by the general policy: 408, 429 and every 5xx. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/** Exponential backoff with "equal jitter": half the capped delay is fixed, half is random. `failedAttempt` is 1-based. */
export function backoffDelayMs(failedAttempt: number, policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">, random: () => number = Math.random): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Retry-After as delta-seconds or an HTTP date. Returns null when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Provider error codes are logged, so only short identifier-shaped values are accepted. */
export function safeProviderCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;
}

export function safeRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

export class RequestAbortedError extends Error {
  constructor() {
    super("Model request aborted.");
    this.name = "RequestAbortedError";
  }
}

/** Resolves after `ms`; rejects with RequestAbortedError as soon as the signal aborts. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RequestAbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
