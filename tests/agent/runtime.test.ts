import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/runtime.js";
import { createToolRegistry, toolSpecs } from "../../src/agent/tools.js";
import { RunPolicy } from "../../src/agent/policy.js";
import { ModelApiError } from "../../src/model/meta.js";
import { SpendLimitError } from "../../src/model/spendGuard.js";
import { executeAccepted, GAME_ID, overview } from "../fixtures.js";
import { countingIds, fakeSimulator, scriptedModel, toolMessages, type FakeSim } from "./harness.js";

let sim: FakeSim | undefined;
const dirs: string[] = [];
afterEach(async () => { await sim?.close(); sim = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const OBSERVE = [{ name: "observe_farm" }, { name: "observe_fields" }, { name: "list_available_actions" }];
const EXECUTE = { name: "execute_action", args: { type: "irrigateField", params: { fieldId: "field-1", volumeM3: 50 }, rationale: "Soil moisture is low and stale." } };

const base = (s: FakeSim) => ({ client: s.client, gameId: GAME_ID, traceDirectory: null, newMutationId: countingIds(), retryDelayMs: 1 });

describe("MOCKED tool registry and policy", () => {
  it("generates strict JSON schemas and hides mutating tools in observe-only mode", () => {
    const registry = createToolRegistry();
    expect(registry.map((t) => t.name)).toEqual(["observe_farm", "observe_fields", "list_available_actions", "execute_action", "get_action_status", "advance_time", "get_recent_events"]);
    for (const tool of registry) {
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.parameters).not.toHaveProperty("$schema");
    }
    const execute = registry.find((t) => t.name === "execute_action")!;
    expect(Object.keys((execute.parameters as { properties: object }).properties).sort()).toEqual(["params", "rationale", "type"]);
    const observeOnly = new RunPolicy("observe_only");
    const names = toolSpecs(registry, (t) => observeOnly.isExposed(t)).map((t) => ("function" in t ? t.function.name : ""));
    expect(names).not.toContain("execute_action");
    expect(names).not.toContain("advance_time");
    expect(names).toHaveLength(5);
  });
});

describe("MOCKED runtime: native tool-call exchange", () => {
  it("executes several read-only calls in one step and returns one tool message per call id", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: OBSERVE.map((c, i) => ({ ...c, id: `c${i}` })) }, { content: "Moisture is stale; I would inspect the field first." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "observe_only" });
    expect(result.status).toBe("completed");
    expect(result.finalSummary).toContain("inspect");
    expect(toolMessages(model, 1).map((m) => m.tool_call_id)).toEqual(["c0", "c1", "c2"]);
    expect(toolMessages(model, 1).every((m) => m.body.ok)).toBe(true);
    expect(model.requests[1]!.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(sim.posts).toHaveLength(0);
    expect(result.totals).toMatchObject({ modelCalls: 2, toolCalls: 3, acceptedMutations: 0 });
  });

  it("offers only read-only tools and blocks mutations if the model asks anyway (observe-only)", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: [{ name: "observe_farm" }] }, { calls: [EXECUTE] }, { content: "done" }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "observe_only" });
    expect(model.requests[0]!.tools!.map((t) => "function" in t ? t.function.name : "")).not.toContain("execute_action");
    expect(toolMessages(model, 2).at(-1)!.body.error).toMatchObject({ code: "mutation_disabled" });
    expect(sim.posts).toHaveLength(0);
    expect(result.totals.mutationAttempts).toBe(0);
  });

  it("returns structured errors for unknown tools, malformed JSON and invalid or smuggled arguments", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([
      { calls: [{ name: "observe_farm" }] },
      { calls: [
        { name: "drop_database" },
        { name: "get_action_status", rawArguments: "{not json" },
        { name: "get_action_status", args: {} },
        { name: "execute_action", args: { ...EXECUTE.args, expectedRevision: 1, idempotencyKey: "mine" } },
      ] },
      { content: "ok" },
    ]);
    await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    const codes = toolMessages(model, 2).map((m) => m.body.error?.code);
    expect(codes).toEqual(["unknown_tool", "invalid_arguments", "invalid_arguments", "invalid_arguments"]);
    expect(sim.posts).toHaveLength(0);
  });

  it("enforces per-step and total tool-call limits and asks for a final answer without tools", async () => {
    sim = await fakeSimulator();
    const six = Array.from({ length: 6 }, () => ({ name: "observe_farm" }));
    const model = scriptedModel([{ calls: six }, { content: "summary" }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "observe_only", limits: { maxToolCallsPerStep: 4, maxTotalToolCalls: 4 } });
    const codes = toolMessages(model, 1).map((m) => m.body.error?.code ?? "ok");
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "per_step_limit", "per_step_limit"]);
    expect(model.requests[1]!.tools).toBeUndefined();
    expect(result.totals.toolCalls).toBe(4);
    expect(result.status).toBe("completed");
  });
});

describe("MOCKED runtime: mutation safety", () => {
  it("attaches the observed revision and a runtime-generated key, then verifies and advances within limits", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([
      { calls: OBSERVE },
      { calls: [EXECUTE] },
      { calls: [{ name: "get_action_status", args: { actionId: "act-1" } }] },
      { calls: [{ name: "observe_farm" }] },
      { calls: [{ name: "advance_time", args: { requestedSeconds: 900, rationale: "See progress." } }] },
      { content: "Irrigation scheduled and time advanced." },
    ]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    expect(sim.posts[0]).toMatchObject({ path: "/actions", body: { type: "irrigateField", expectedRevision: 4, dryRun: false, idempotencyKey: "00000000-0000-4000-8000-000000000001" } });
    expect(sim.posts[1]).toMatchObject({ path: "/clock/advance", body: { requestedSeconds: 900, expectedRevision: 5, stopOn: ["action_completion"] } });
    expect(result.totals).toMatchObject({ acceptedMutations: 1, mutationAttempts: 1, advancedSimSeconds: 900 });
    expect(result.status).toBe("completed");
  });

  it("requires an observation first and defers state-changing calls issued alongside other calls", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: [EXECUTE] }, { calls: [{ name: "observe_farm" }, EXECUTE] }, { content: "ok" }]);
    await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    expect(toolMessages(model, 1)[0]!.body.error).toMatchObject({ code: "observation_required" });
    expect(toolMessages(model, 2).map((m) => m.body.error?.code ?? "ok")).toEqual(["ok", "mutation_must_be_alone"]);
    expect(sim.posts).toHaveLength(0);
  });

  it("stops at the mutation limit and never submits a second action", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: OBSERVE }, { calls: [EXECUTE] }, { calls: [{ name: "observe_farm" }] }, { calls: [EXECUTE] }, { content: "limit hit" }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    expect(toolMessages(model, 4).at(-1)!.body.error).toMatchObject({ code: "mutation_limit_reached" });
    expect(sim.posts.filter((p) => p.path === "/actions")).toHaveLength(1);
    expect(result.totals.acceptedMutations).toBe(1);
  });

  it("rejects advances beyond the per-call and total limits without calling the simulator", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: [{ name: "observe_farm" }] }, { calls: [{ name: "advance_time", args: { requestedSeconds: 5000 } }] }, { calls: [{ name: "advance_time", args: { requestedSeconds: 1800 } }] }, { calls: [{ name: "observe_farm" }] }, { calls: [{ name: "advance_time", args: { requestedSeconds: 1800 } }] }, { calls: [{ name: "observe_farm" }] }, { calls: [{ name: "advance_time", args: { requestedSeconds: 1800 } }] }, { content: "done" }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation", limits: { maxTotalAdvanceSeconds: 3600 } });
    expect(toolMessages(model, 2).at(-1)!.body.error).toMatchObject({ code: "advance_limit_exceeded" });
    expect(toolMessages(model, 7).at(-1)!.body.error).toMatchObject({ code: "advance_limit_exceeded" });
    expect(sim.posts).toHaveLength(2);
    expect(result.totals.advancedSimSeconds).toBe(3600);
  });

  it("on 409 returns a structured conflict with fresh data and never repeats the original action", async () => {
    sim = await fakeSimulator();
    const model = scriptedModel([{ calls: [{ name: "observe_farm" }] }, { calls: [EXECUTE] }, { calls: [EXECUTE] }, { content: "Farm changed; I will observe again." }]);
    // Another writer bumps the revision right after the model's observation.
    const original = sim.client.getFarmOverview.bind(sim.client);
    let reads = 0;
    sim.client.getFarmOverview = async (id: string) => { const r = await original(id); if (++reads === 1) sim!.state.revision += 3; return r; };
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    const conflict = toolMessages(model, 2)[0]!.body.error!;
    expect(conflict).toMatchObject({ code: "stale_revision", currentRevision: 7 });
    expect(conflict.latestOverview).toMatchObject({ revision: 7 });
    expect(toolMessages(model, 3)[0]!.body.error).toMatchObject({ code: "observation_required" });
    expect(sim.posts.filter((p) => p.path === "/actions")).toHaveLength(1);
    expect(sim.state.accepted).toBe(0);
    expect(result.totals.acceptedMutations).toBe(0);
  });

  it("retries a timed-out mutation with the SAME idempotency key and the simulator applies it once", async () => {
    let first = true;
    sim = await fakeSimulator((req) => (req.method === "POST" && first ? ((first = false), { status: 200, body: {}, delayMs: 400 }) : undefined), 150);
    // The slow first response is dropped by the client; the fake simulator never saw it apply, so emulate a committed-but-lost response.
    sim.server.requests.length = 0;
    const model = scriptedModel([{ calls: OBSERVE }, { calls: [EXECUTE] }, { content: "done" }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    const posts = sim.server.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(posts.map((p) => p.idempotencyKey)).size).toBe(1);
    expect(new Set(posts.map((p) => JSON.stringify(p))).size).toBe(1);
    expect(sim.state.accepted).toBe(1);
    expect(result.totals.acceptedMutations).toBe(1);
  });

  it("reports outcome_unknown, locks further mutations and keeps one key when every retry times out", async () => {
    sim = await fakeSimulator((req) => (req.method === "POST" ? { status: 200, body: {}, delayMs: 400 } : undefined), 100);
    const model = scriptedModel([{ calls: OBSERVE }, { calls: [EXECUTE] }, { calls: [EXECUTE] }, { content: "Unknown outcome." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation", maxMutationRetries: 2 });
    expect(toolMessages(model, 2)[0]!.body.error).toMatchObject({ code: "outcome_unknown" });
    expect(toolMessages(model, 3).at(-1)!.body.error).toMatchObject({ code: "mutation_locked" });
    const keys = sim.server.requests.filter((r) => r.method === "POST").map((r) => (JSON.parse(r.body) as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(result.totals.acceptedMutations).toBe(0);
  });

  it("recovers after a rejected action: nothing is counted as accepted and a corrected request can succeed", async () => {
    let rejectNext = true;
    sim = await fakeSimulator((req, state) => {
      if (req.method === "POST" && req.url.endsWith("/actions") && rejectNext) {
        rejectNext = false;
        state.revision += 1;
        return { status: 422, body: { gameId: GAME_ID, revision: state.revision, accepted: false, dryRun: false, action: null, errors: [{ code: "invalid_params", detail: "volumeM3: must be positive" }], asynchronous: false } };
      }
      return undefined;
    });
    const fixed = { name: "execute_action", args: { type: "irrigateField", params: { fieldId: "field-1", volumeM3: 20 } } };
    const model = scriptedModel([{ calls: OBSERVE }, { calls: [EXECUTE] }, { calls: [fixed] }, { content: "Retried with corrected parameters." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation" });
    expect(toolMessages(model, 2)[0]!.body.data).toMatchObject({ accepted: false, errors: [{ code: "invalid_params" }] });
    expect(sim.posts.map((p) => p.body.expectedRevision)).toEqual([4, 5]);
    expect(new Set(sim.posts.map((p) => p.body.idempotencyKey)).size).toBe(2);
    expect(result.totals).toMatchObject({ acceptedMutations: 1, mutationAttempts: 2 });
  });
});

describe("MOCKED runtime: failures, limits and partial observability", () => {
  it("maps expired tokens, missing scopes and simulator timeouts to structured tool errors without crashing", async () => {
    sim = await fakeSimulator((req) => {
      if (req.url.endsWith("/overview")) return { status: 401, body: { error: "Invalid or expired token." } };
      if (req.url.endsWith("/fields")) return { status: 403, body: { error: "Token lacks scope.", code: "insufficient_scope" } };
      if (req.url.endsWith("/actions")) return { status: 200, body: {}, delayMs: 500 };
      return undefined;
    }, 100);
    const model = scriptedModel([{ calls: OBSERVE }, { content: "I could not observe the farm." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "observe_only" });
    expect(toolMessages(model, 1).map((m) => m.body.error?.code)).toEqual(["unauthenticated", "insufficient_scope", "simulator_timeout"]);
    expect(result.status).toBe("completed");
  });

  it("withholds simulator payloads that violate the contract so hidden state never reaches the model or the trace", async () => {
    sim = await fakeSimulator((req) => (req.url.endsWith("/overview") ? { status: 200, body: { ...overview, environment: { trueSoilMoisture: 0.123456, rngState: 987654321 } } } : undefined));
    const model = scriptedModel([{ calls: [{ name: "observe_farm" }] }, { content: "Cannot observe." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "observe_only" });
    expect(toolMessages(model, 1)[0]!.body.error).toMatchObject({ code: "contract_violation" });
    const everything = JSON.stringify([model.requests, result.trace.entries]);
    expect(everything).not.toMatch(/trueSoilMoisture|rngState|987654321|0\.123456/);
  });

  it("stops on the estimated cost limit, on the model-call limit, and on a spend-guard refusal", async () => {
    sim = await fakeSimulator();
    const costly = await runAgent({ ...base(sim), provider: scriptedModel([{ calls: [{ name: "observe_farm" }], costUsd: 0.2 }]), mode: "observe_only", limits: { maxCostUsd: 0.25 } });
    expect(costly).toMatchObject({ status: "limited", stopReason: "cost_limit" });
    expect(costly.totals.modelCalls).toBe(2);

    const looping = scriptedModel([{ calls: [{ name: "observe_farm" }] }]);
    const capped = await runAgent({ ...base(sim), provider: looping, mode: "observe_only", limits: { maxModelCalls: 3 } });
    expect(capped.totals.modelCalls).toBe(3);
    expect(looping.requests.at(-1)!.tools).toBeUndefined();

    const refused = await runAgent({ ...base(sim), provider: scriptedModel([{ throws: new SpendLimitError("too expensive", "session") }]), mode: "observe_only" });
    expect(refused).toMatchObject({ status: "limited", stopReason: "cost_limit" });
  });

  it("fails safely and records the error when the model API times out", async () => {
    sim = await fakeSimulator();
    const result = await runAgent({ ...base(sim), provider: scriptedModel([{ throws: new ModelApiError("Model API request timed out.", "timeout") }]), mode: "observe_only" });
    expect(result).toMatchObject({ status: "failed", stopReason: "model_error" });
    expect(result.trace.entries.some((e) => e.event === "model.error" && e.kind === "timeout")).toBe(true);
  });

  it("persists a structured audit trail that never contains credentials", async () => {
    sim = await fakeSimulator();
    const dir = mkdtempSync(join(tmpdir(), "muse-trace-"));
    dirs.push(dir);
    const model = scriptedModel([{ calls: OBSERVE }, { calls: [EXECUTE] }, { content: "Scheduled irrigation." }]);
    const result = await runAgent({ ...base(sim), provider: model, mode: "controlled_mutation", traceDirectory: dir, runId: "run-test" });
    const files = readdirSync(dir);
    expect(files).toEqual(["run-test.jsonl"]);
    const text = readFileSync(join(dir, files[0]!), "utf8");
    const events = text.trim().split("\n").map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(["run.start", "model.response", "tool.request", "tool.result", "mutation.submit", "mutation.result", "run.end"]));
    expect(text).not.toContain("test-agent-token-SECRET");
    expect(text).toContain(executeAccepted.action.actionId);
    expect(result.traceFile).toContain("run-test.jsonl");
  });
});
