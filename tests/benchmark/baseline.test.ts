import { describe, expect, it, vi } from "vitest";

// Mocked unit tests only: no simulator, no model. Live evidence lives in docs/BENCHMARK_FOUNDATION.md.
const outcome = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../../src/benchmark/outcome.js", async (orig) => ({ ...(await orig<object>()), outcomeSnapshot: () => outcome.value }));

import { DEFAULT_BASELINE_CONFIG, decide, learn, newMemory } from "../../src/baseline/policy.js";
import { pacedApi, type BaselineApi } from "../../src/baseline/paced.js";
import { canonicalJson, sha256 } from "../../src/benchmark/fingerprint.js";
import { SimulatorError } from "../../src/simulator/client.js";

const act = (type: string, id: string, eligible = true) => ({ type, target: { id }, eligibility: { eligible } });
const view = (actions: unknown[], over: { simTimeS?: number; active?: number } = {}) =>
  ({ overview: { clock: { simTimeS: over.simTimeS ?? 0 }, status: { activeActionCount: over.active ?? 0 } }, actions: { actions } }) as never;
const setOutcome = (inventoryKg: Record<string, number>, prices: Record<string, number>, seedKg: Record<string, number> = { soybean: 100, corn: 100, wheat: 100 }) => {
  outcome.value = { inventoryKg, marketPricesPerKg: prices, seedKg };
};
const cfg = DEFAULT_BASELINE_CONFIG;

describe("baseline policy", () => {
  it("stops at the horizon", () => {
    setOutcome({}, {});
    expect(decide(view([], { simTimeS: 200 * 60 }), newMemory(), cfg).kind).toBe("stop");
  });

  it("waits while an operation is active, before anything else", () => {
    setOutcome({ wheat: 50 }, { wheat: 0.25 });
    const d = decide(view([act("harvestField", "field-1")], { active: 1 }), newMemory(), cfg);
    expect(d).toMatchObject({ kind: "advance", rule: "R1_wait" });
  });

  it("sells stock only at a published price and records the hold otherwise", () => {
    setOutcome({ corn: 10.9, hay: 5 }, { corn: 0.2 });
    const d = decide(view([]), newMemory(), cfg);
    expect(d).toMatchObject({ kind: "execute", type: "sellHarvest", params: { product: "corn", kg: 10 } });
    setOutcome({ hay: 5 }, {});
    const d2 = decide(view([]), newMemory(), cfg);
    expect(d2.kind).toBe("advance");
    expect(d2.holds.join()).toContain("no published price");
  });

  it("harvests eligible fields, then plants by rotation, then prepares soil", () => {
    setOutcome({}, {});
    expect(decide(view([act("harvestField", "field-2"), act("plantField", "field-1")]), newMemory(), cfg)).toMatchObject({ type: "harvestField", params: { fieldId: "field-2" } });
    expect(decide(view([act("plantField", "field-1")]), newMemory(), cfg)).toMatchObject({ type: "plantField", params: { fieldId: "field-1", crop: "soybean" }, preflight: true });
    expect(decide(view([act("prepareSoil", "field-4")]), newMemory(), cfg)).toMatchObject({ type: "prepareSoil" });
  });

  it("rotates after its own planting and skips crops without seed", () => {
    setOutcome({}, {}, { soybean: 100, corn: 0, wheat: 50 });
    const m = newMemory();
    learn(m, { type: "plantField", params: { fieldId: "field-1", crop: "soybean" }, status: "completed", finishedAtS: 5 });
    const d = decide(view([act("plantField", "field-1")]), m, cfg);
    expect(d).toMatchObject({ params: { crop: "wheat" } });
    expect(d.holds.join()).toContain("no corn seed");
  });

  it("is deterministic and honours rejection cooldowns", () => {
    setOutcome({}, {});
    const v = view([act("harvestField", "field-1")]);
    expect(decide(v, newMemory(), cfg)).toEqual(decide(v, newMemory(), cfg));
    const m = newMemory();
    m.cooldowns["harvestField:field-1"] = 999;
    expect(decide(v, m, cfg).kind).toBe("advance");
  });

  it("ignores failed actions when learning", () => {
    const m = newMemory();
    learn(m, { type: "plantField", params: { fieldId: "field-1", crop: "corn" }, status: "failed", finishedAtS: 1 });
    expect(m.fields["field-1"]).toBeUndefined();
  });
});

describe("pacedApi", () => {
  const client = (fn: () => Promise<unknown>) => ({ getFarmOverview: fn }) as unknown as BaselineApi;

  it("retries a 429 after waiting and counts it", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const api = pacedApi(client(async () => { if (++calls === 1) throw new SimulatorError("rate", "http", 429); return "ok"; }), { minIntervalMs: 0, rateLimitWaitMs: 61_000, maxRateLimitRetries: 2, sleep });
    await expect(api.getFarmOverview("g" as never)).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(61_000);
    expect(api.rateLimited()).toBe(1);
  });

  it("does not retry other errors and gives up after the retry limit", async () => {
    const sleep = vi.fn(async () => undefined);
    const bad = pacedApi(client(async () => { throw new Error("boom"); }), { minIntervalMs: 0, rateLimitWaitMs: 1, maxRateLimitRetries: 2, sleep });
    await expect(bad.getFarmOverview("g" as never)).rejects.toThrow("boom");
    const limited = pacedApi(client(async () => { throw new SimulatorError("rate", "http", 429); }), { minIntervalMs: 0, rateLimitWaitMs: 1, maxRateLimitRetries: 2, sleep });
    await expect(limited.getFarmOverview("g" as never)).rejects.toBeInstanceOf(SimulatorError);
    expect(limited.rateLimited()).toBe(2);
  });
});

describe("canonical fingerprint", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(sha256({ a: 1, b: 2 })).toBe(sha256({ b: 2, a: 1 }));
    expect(sha256({ a: 1 })).not.toBe(sha256({ a: 2 }));
  });
});
