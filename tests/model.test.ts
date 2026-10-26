import { afterEach, describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/logging/logger.js";
import { MetaModelProvider, ModelApiError } from "../src/model/meta.js";
import { estimateCostUsd } from "../src/model/pricing.js";
import { SpendGuard, SpendLimitError } from "../src/model/spendGuard.js";
import { startMockServer, type MockServer } from "./mockServer.js";

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const completion = (extra: object = {}) => ({
  id: "c1", object: "chat.completion", created: 0, model: "muse-spark-1.3",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ready", ...extra } }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 150 } },
});

const guard = () => new SpendGuard({ maxCostPerRequestUsd: 0.05, maxSessionCostUsd: 0.06 });
const provider = (baseUrl: string, spendGuard = guard(), modelId = "muse-spark-1.3") =>
  new MetaModelProvider({ apiKey: "k", modelId, baseUrl, maxRetries: 0, timeoutMs: 1000, spendGuard });

describe("Meta model provider (MOCKED Meta API, not proof of real connectivity)", () => {
  it("calls chat/completions with the configured model, tracks usage and cost", async () => {
    server = await startMockServer(() => ({ status: 200, body: completion() }));
    const p = provider(server.url);
    const res = await p.complete({ messages: [{ role: "user", content: "hi" }] });
    const sent = JSON.parse(server.requests[0]!.body) as Record<string, unknown>;
    expect(server.requests[0]!.url).toBe("/chat/completions");
    expect(server.requests[0]!.authorization).toBe("Bearer k");
    expect(sent).toMatchObject({ model: "muse-spark-1.3", max_completion_tokens: 1024 });
    expect(res.usage).toMatchObject({ promptTokens: 1000, cachedPromptTokens: 400, completionTokens: 200, reasoningTokens: 150 });
    expect(res.estimatedCostUsd).toBeCloseTo((600 * 1.25 + 400 * 0.15 + 200 * 4.25) / 1e6, 8);
  });

  it("returns native tool calls with raw, unvalidated arguments", async () => {
    const tool_calls = [{ id: "call_1", type: "function", function: { name: "get_overview", arguments: "{not json" } }];
    server = await startMockServer(() => ({ status: 200, body: { ...completion({ content: null, tool_calls }), choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls } }] } }));
    const res = await provider(server.url).complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "get_overview", arguments: "{not json" }]);
  });

  it("maps HTTP failures to typed errors", async () => {
    server = await startMockServer(() => ({ status: 401, body: { error: { message: "bad key" } } }));
    await expect(provider(server.url).complete({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(new ModelApiError("x", "timeout")).toBeInstanceOf(Error);
  });

  it("enforces spending safeguards before calling the API", async () => {
    server = await startMockServer(() => ({ status: 200, body: completion() }));
    const p = provider(server.url);
    await expect(p.complete({ messages: [{ role: "user", content: "x" }], maxOutputTokens: 100_000 })).rejects.toBeInstanceOf(SpendLimitError);
    await expect(provider(server.url, guard(), "unpriced-model").complete({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ limit: "unknown_pricing" });
    expect(server.requests).toHaveLength(0);
  });

  it("stops when the session budget would be exceeded", () => {
    const g = new SpendGuard({ maxCostPerRequestUsd: 1, maxSessionCostUsd: 0.01 });
    g.record(0.009);
    expect(() => g.preflight("muse-spark-1.3", 1000, 1000)).toThrowError(/session budget/);
  });

  it("prices both supported models", () => {
    const usage = { promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 1_000_000, reasoningTokens: null, totalTokens: 2_000_000 };
    expect(estimateCostUsd("muse-spark-1.3", usage)).toBeCloseTo(5.5);
    expect(estimateCostUsd("muse-wonder-1.0", usage)).toBeCloseTo(24);
  });
});

describe("logging", () => {
  it("redacts secrets", () => {
    expect(redact({ apiKey: "sk-1", nested: { Authorization: "Bearer abc", note: "Bearer xyz.123 here" } })).toEqual({ apiKey: "[redacted]", nested: { Authorization: "[redacted]", note: "Bearer [redacted] here" } });
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).log("info", "evt", { token: "secret", n: 1 });
    expect(lines[0]).not.toContain("secret");
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "evt", n: 1 });
  });
});
