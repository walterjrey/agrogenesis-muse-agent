import { afterEach, describe, expect, it } from "vitest";
import { MetaModelProvider, ModelApiError, type MetaModelConfig } from "../src/model/meta.js";
import { backoffDelayMs, parseRetryAfterMs, resolveRetryPolicy } from "../src/model/retry.js";
import { SpendGuard } from "../src/model/spendGuard.js";
import { startMockServer, type MockServer } from "./mockServer.js";

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const ok = { id: "c1", object: "chat.completion", created: 0, model: "muse-spark-1.3", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ready" } }], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } };
const notFound = { status: 404, body: { error: { code: "model_not_found", message: "The model `muse-spark-1.3` does not exist" } } };
const messages = [{ role: "user" as const, content: "SECRET PROMPT TEXT" }];

interface Harness { provider: MetaModelProvider; delays: number[]; guard: SpendGuard; logs: Array<{ event: string; fields: Record<string, unknown> }> }
function harness(url: string, overrides: Partial<MetaModelConfig> = {}): Harness {
  const delays: number[] = [];
  const logs: Harness["logs"] = [];
  const guard = new SpendGuard({ maxCostPerRequestUsd: 0.05, maxSessionCostUsd: 0.5 });
  const provider = new MetaModelProvider({
    apiKey: "test-key-123", modelId: "muse-spark-1.3", baseUrl: url, timeoutMs: 1000, spendGuard: guard,
    retryBaseDelayMs: 100, retryMaxDelayMs: 1000, random: () => 0.5,
    sleep: async (ms) => { delays.push(ms); },
    logger: { log: (_level, event, fields = {}) => void logs.push({ event, fields }) },
    ...overrides,
  });
  return { provider, delays, guard, logs };
}
const sequence = (...responses: Array<{ status: number; body: unknown; headers?: Record<string, string>; delayMs?: number }>) => {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)]!;
};

describe("Meta provider retry policy (MOCKED Meta API)", () => {
  it("404 model_not_found, 404, 200 -> success when the workaround is enabled", async () => {
    server = await startMockServer(sequence(notFound, notFound, { status: 200, body: ok }));
    const h = harness(server.url, { retryModelNotFound: true });
    const res = await h.provider.complete({ messages });
    expect(res.content).toBe("ready");
    expect(server.requests).toHaveLength(3);
    expect(res.attempts?.map((a) => [a.attempt, a.status, a.code, a.outcome])).toEqual([[1, 404, "model_not_found", "retry"], [2, 404, "model_not_found", "retry"], [3, 200, null, "success"]]);
    expect(h.delays).toEqual([75, 150]);
    expect(h.guard.sessionSpentUsd).toBeCloseTo((1000 * 1.25 + 200 * 4.25) / 1e6, 8);
    expect(h.logs.filter((l) => l.event === "model.retry")).toHaveLength(2);
  });

  it("persistent model_not_found is bounded at 4 attempts and reports a provider failure", async () => {
    server = await startMockServer(() => notFound);
    const h = harness(server.url, { retryModelNotFound: true });
    const error = await h.provider.complete({ messages }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "bad_request", status: 404, code: "model_not_found" });
    expect((error as ModelApiError).message).toBe("Model API error (HTTP 404 model_not_found) after 4 attempts.");
    expect((error as ModelApiError).attempts).toHaveLength(4);
    expect(server.requests).toHaveLength(4);
    expect(h.guard.sessionSpentUsd).toBe(0);
    expect(h.logs.at(-1)?.event).toBe("model.error");
  });

  it("does not retry model_not_found unless explicitly enabled", async () => {
    server = await startMockServer(() => notFound);
    await expect(harness(server.url).provider.complete({ messages })).rejects.toMatchObject({ status: 404, code: "model_not_found" });
    expect(server.requests).toHaveLength(1);
  });

  it("does not apply the workaround to an unpriced (not known valid) model", async () => {
    server = await startMockServer(() => notFound);
    const h = harness(server.url, { retryModelNotFound: true, modelId: "unknown-model", spendGuard: new SpendGuard({ maxCostPerRequestUsd: 1, maxSessionCostUsd: 1 }) });
    await expect(h.provider.complete({ messages })).rejects.toBeDefined();
    expect(server.requests).toHaveLength(0); // the spend guard refuses unpriced models before any request
  });

  it("never retries an unrelated 404 (other code, no code, or code in the message only)", async () => {
    for (const body of [{ error: { code: "route_not_found", message: "x" } }, {}, { error: { message: "model_not_found" } }]) {
      server = await startMockServer(() => ({ status: 404, body }));
      await expect(harness(server.url, { retryModelNotFound: true }).provider.complete({ messages })).rejects.toMatchObject({ status: 404 });
      expect(server.requests).toHaveLength(1);
      await server.close();
    }
    server = undefined;
  });

  it.each([400, 401, 403])("never retries HTTP %i", async (status) => {
    server = await startMockServer(() => ({ status, body: { error: { code: "model_not_found", message: "nope" } } }));
    const error = await harness(server.url, { retryModelNotFound: true }).provider.complete({ messages }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status });
    expect(server.requests).toHaveLength(1);
  });

  it.each([408, 429, 500, 503, 599])("retries HTTP %i with backoff and then succeeds", async (status) => {
    server = await startMockServer(sequence({ status, body: { error: { code: "overloaded", message: "x" } } }, { status: 200, body: ok }));
    const h = harness(server.url);
    const res = await h.provider.complete({ messages });
    expect(res.attempts).toHaveLength(2);
    expect(h.delays).toEqual([75]);
    expect(res.attempts?.[0]).toMatchObject({ status, outcome: "retry", possiblyBillable: status >= 500 });
  });

  it("backs off exponentially with jitter and stops at maxAttempts", async () => {
    server = await startMockServer(() => ({ status: 503, body: {} }));
    const h = harness(server.url, { maxAttempts: 4, random: () => 1 });
    await expect(h.provider.complete({ messages })).rejects.toMatchObject({ status: 503, kind: "server" });
    expect(server.requests).toHaveLength(4);
    expect(h.delays).toEqual([100, 200, 400]);
    expect(backoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 0)).toBe(200);
    expect(backoffDelayMs(10, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 1)).toBe(1000);
  });

  it("honors Retry-After (seconds) over the computed backoff", async () => {
    server = await startMockServer(sequence({ status: 429, body: {}, headers: { "retry-after": "2" } }, { status: 200, body: ok }));
    const h = harness(server.url);
    await h.provider.complete({ messages });
    expect(h.delays).toEqual([2000]);
  });

  it("stops instead of waiting when Retry-After exceeds the cap or the overall deadline", async () => {
    server = await startMockServer(() => ({ status: 429, body: {}, headers: { "retry-after": "120" } }));
    await expect(harness(server.url).provider.complete({ messages })).rejects.toMatchObject({ status: 429, kind: "rate_limit" });
    expect(server.requests).toHaveLength(1);
    await server.close();
    server = await startMockServer(() => ({ status: 503, body: {} }));
    const h = harness(server.url, { retryBaseDelayMs: 500, retryMaxDelayMs: 500, requestDeadlineMs: 300 });
    await expect(h.provider.complete({ messages })).rejects.toMatchObject({ status: 503 });
    expect(server.requests).toHaveLength(1);
    expect(h.delays).toEqual([]);
    const caller = harness(server.url, { retryBaseDelayMs: 500 });
    await expect(caller.provider.complete({ messages, deadlineMs: Date.now() + 100 })).rejects.toMatchObject({ status: 503 });
    expect(caller.delays).toEqual([]);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(5000);
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it("aborts during backoff without making another request", async () => {
    server = await startMockServer(() => ({ status: 503, body: {} }));
    const controller = new AbortController();
    const h = harness(server.url, { sleep: async (_ms, signal) => { controller.abort(); if (signal?.aborted) throw new Error("aborted"); } });
    const error = await h.provider.complete({ messages, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "aborted", message: "Model request aborted." });
    expect(server.requests).toHaveLength(1);
  });

  it("does not start a request when already aborted, and aborts the real sleep", async () => {
    server = await startMockServer(() => ({ status: 503, body: {} }));
    const done = new AbortController();
    done.abort();
    await expect(harness(server.url).provider.complete({ messages, signal: done.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(server.requests).toHaveLength(0);
    const live = new AbortController();
    const real = new MetaModelProvider({ apiKey: "k", modelId: "muse-spark-1.3", baseUrl: server.url, timeoutMs: 1000, retryBaseDelayMs: 10_000, retryMaxDelayMs: 10_000, spendGuard: new SpendGuard({ maxCostPerRequestUsd: 0.05, maxSessionCostUsd: 0.5 }) });
    const started = Date.now();
    const pending = real.complete({ messages, signal: live.signal }).catch((e: unknown) => e);
    setTimeout(() => live.abort(), 150);
    expect(await pending).toMatchObject({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("retries per-attempt timeouts within the bounded policy", async () => {
    server = await startMockServer(sequence({ status: 200, body: ok, delayMs: 400 }, { status: 200, body: ok }));
    const h = harness(server.url, { timeoutMs: 100 });
    const res = await h.provider.complete({ messages });
    expect(res.attempts?.map((a) => [a.status, a.possiblyBillable, a.outcome])).toEqual([[null, true, "retry"], [200, true, "success"]]);
    await server.close();
    server = await startMockServer(() => ({ status: 200, body: ok, delayMs: 400 }));
    const bounded = harness(server.url, { timeoutMs: 80, maxAttempts: 2 });
    await expect(bounded.provider.complete({ messages })).rejects.toMatchObject({ kind: "timeout", message: "Model API request timed out after 2 attempts." });
    expect(bounded.guard.sessionSpentUsd).toBe(0);
  });

  it("budget exhaustion stops before any request, and retries do not add spend", async () => {
    server = await startMockServer(() => ({ status: 200, body: ok }));
    const tight = harness(server.url, { spendGuard: new SpendGuard({ maxCostPerRequestUsd: 0.05, maxSessionCostUsd: 0.000001 }) });
    await expect(tight.provider.complete({ messages })).rejects.toMatchObject({ name: "SpendLimitError" });
    expect(server.requests).toHaveLength(0);
  });

  it("logs attempts without credentials, headers or prompt text", async () => {
    server = await startMockServer(sequence({ ...notFound, headers: { "x-request-id": "req_abc123" } }, { status: 200, body: ok }));
    const h = harness(server.url, { retryModelNotFound: true });
    const res = await h.provider.complete({ messages });
    expect(res.attempts?.[0]).toMatchObject({ requestId: "req_abc123", code: "model_not_found" });
    const dump = JSON.stringify([h.logs, res.attempts]);
    expect(dump).not.toMatch(/test-key-123|SECRET PROMPT|authorization|bearer/i);
  });

  it("resolves policy: default 4 attempts, legacy maxRetries, ceiling, workaround off", () => {
    expect(resolveRetryPolicy({})).toMatchObject({ maxAttempts: 4, retryModelNotFound: false });
    expect(resolveRetryPolicy({ maxRetries: 0 }).maxAttempts).toBe(1);
    expect(resolveRetryPolicy({ maxRetries: 2, maxAttempts: 5 }).maxAttempts).toBe(5);
    expect(resolveRetryPolicy({ maxAttempts: 99 }).maxAttempts).toBe(8);
  });
});
