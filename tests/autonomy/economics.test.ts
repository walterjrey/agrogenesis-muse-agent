import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { digestCatalog, terseCatalog } from "../../src/autonomy/catalog.js";
import { buildEconomics, ledgerEntry } from "../../src/autonomy/economics.js";
import { buildAttribution } from "../../src/autonomy/report.js";
import { cycleBrief } from "../../src/autonomy/prompt.js";
import { compactHistory, type ToolCallMeta } from "../../src/agent/history.js";
import { newSessionState } from "../../src/autonomy/controller.js";
import { summarizeSnapshot, type Snapshot } from "../../src/autonomy/observation.js";
import { buildProgress } from "../../src/autonomy/progress.js";
import type { ObservationSummary, SessionState, TrackedAction } from "../../src/autonomy/types.js";
import { availableActions, fieldObservations, GAME_ID, overview } from "../fixtures.js";

/** MOCKED / pure-function tests on hand-built state. Real simulator behaviour is evidenced by docs/ECONOMIC_REASONING.md. */

const PRICES = { corn: 0.2, soybean: 0.45, wheat: 0.25, hay: 0.1 };

function summary(simTimeS: number, grain: Record<string, number>, over: Partial<ObservationSummary> = {}): ObservationSummary {
  return {
    revision: 1, simTimeS, credits: 2500, realizedRevenue: 0, realizedCosts: 0, marketPricesPerKg: PRICES, priceConfigVersion: 1,
    resources: [
      ...Object.entries(grain).map(([id, quantity]) => ({ id: `grain-${id}`, kind: "grain", quantity, unit: "kg" })),
      { id: "fuel", kind: "fuel", quantity: 3000, unit: "L" },
      { id: "fuel-in-machine-tanks", kind: "fuel_in_machines", quantity: 700, unit: "L" },
    ],
    activeActions: 0, fields: [], ...over,
  };
}

const act = (over: Partial<TrackedAction>): TrackedAction => ({
  actionId: "a", type: "x", status: "completed", submittedAtRevision: 1, idempotencyKey: "k", lastCheckedAt: null, target: "field-1", startedAtS: 0, estimatedCompletionS: null, finishedAtS: 0,
  progress: 1, consumedCredits: null, outcome: null, failure: null, params: {}, consumedWaterM3: null, consumedSeedKg: null, consumedFuelL: null, measurements: {}, ...over,
});

function state(actions: TrackedAction[], baseline: ObservationSummary, latest: ObservationSummary): SessionState {
  const s = newSessionState({ sessionId: "eco-1", gameId: GAME_ID, modelId: "test", mutationsEnabled: true });
  s.actions = actions;
  s.metrics.baseline = baseline;
  s.metrics.latest = latest;
  s.lastSimTimeS = latest.simTimeS;
  return s;
}

describe("MOCKED economic summary", () => {
  it("values stock only at published quotes and marks everything else unknown", () => {
    const s = state([], summary(0, { wheat: 0 }), summary(100, { wheat: 1000, corn: 500 }, { credits: 2450, realizedCosts: 50 }));
    const e = buildEconomics(s)!;
    expect(e.inventory).toEqual([
      { product: "wheat", kg: 1000, pricePerKg: 0.25, priceStatus: "known_configured_quote", estimatedValueCredits: 250 },
      { product: "corn", kg: 500, pricePerKg: 0.2, priceStatus: "known_configured_quote", estimatedValueCredits: 100 },
    ]);
    expect(e.estimatedUnsoldValueCredits).toBe(350);
    expect(e.sinceSessionStart).toEqual({ creditsDelta: -50, revenueDelta: 0, operatingCostsDelta: 50 });
    expect(e.storageCapacity).toMatch(/unknown/);
    expect(e.notes.join(" ")).toMatch(/until it is sold/);

    const unpriced = buildEconomics(state([], summary(0, {}), summary(100, { wheat: 10 }, { marketPricesPerKg: null, priceConfigVersion: null })))!;
    expect(unpriced.inventory[0]).toMatchObject({ pricePerKg: null, priceStatus: "unknown", estimatedValueCredits: null });
    expect(unpriced.estimatedUnsoldValueCredits).toBeNull();
    expect(unpriced.priceSource).toMatch(/unknown/);
  });

  it("separates depot fuel from machine-tank fuel (fuel accounting distinction)", () => {
    const e = buildEconomics(state([], summary(0, {}), summary(10, {})))!;
    expect(e.fuel.depotL).toBe(3000);
    expect(e.fuel.inMachineTanksL).toBe(700);
    expect(e.fuel.note).toMatch(/tank first/);
  });

  it("exposes the last sale result and recent harvest/sale effects for the next decision", () => {
    const harvest = act({ actionId: "h1", type: "harvestField", target: "field-1", finishedAtS: 50 });
    const sale = act({ actionId: "s1", type: "sellHarvest", target: null, finishedAtS: 120, params: { product: "wheat", kg: 400 }, measurements: { revenueCredits: 100 } });
    const before = summary(40, { wheat: 0 });
    const afterHarvest = summary(60, { wheat: 1000 });
    const afterSale = summary(130, { wheat: 600 }, { credits: 2600, realizedRevenue: 100 });
    const s = state([harvest, sale], before, afterSale);
    s.metrics.ledger = [ledgerEntry(before, afterHarvest, [harvest, sale])!, ledgerEntry(afterHarvest, afterSale, [harvest, sale])!];
    const e = buildEconomics(s)!;
    expect(e.lastSale).toEqual({ actionId: "s1", product: "wheat", kg: 400, revenueCredits: 100, atSimTimeS: 120 });
    expect(e.recentHarvestAndSaleEffects[0]).toMatchObject({ harvests: 1, grainDeltaKg: { "grain-wheat": 1000 } });
    expect(e.recentHarvestAndSaleEffects[1]).toMatchObject({ sales: 1, grainDeltaKg: { "grain-wheat": -400 }, creditsDelta: 100, revenueDelta: 100 });
  });

  it("ledgerEntry ignores intervals without this session's harvest/sale and non-advancing observations", () => {
    expect(ledgerEntry(summary(0, {}), summary(50, { wheat: 10 }), [])).toBeNull();
    expect(ledgerEntry(summary(50, {}), summary(50, {}), [act({ type: "harvestField", finishedAtS: 50 })])).toBeNull();
  });

  it("reaches the model inside the cycle brief", () => {
    const s = state([], summary(0, {}), summary(100, { wheat: 1000 }));
    const snapshot: Snapshot = { gameId: GAME_ID, revision: 1, simTimeS: 100, overview: overview, fields: fieldObservations, actions: availableActions, rounds: 1, mixedRevisionsDetected: 0 } as Snapshot;
    const brief = cycleBrief({ state: s, snapshot, events: [], progress: buildProgress(s), economics: buildEconomics(s) });
    expect(brief).toContain('"economy"');
    expect(brief).toContain('"estimatedUnsoldValueCredits":250');
  });

  it("carries the published market quotes from the overview into the observation summary", () => {
    const base = overview;
    const finance = { authorized: true as const, credits: 1, realizedRevenue: 0, realizedCosts: 0, marketPricesPerKg: PRICES, priceConfigVersion: 3 };
    const snapshot = { gameId: GAME_ID, revision: 1, simTimeS: 0, overview: { ...base, finance }, fields: fieldObservations, actions: availableActions, rounds: 1, mixedRevisionsDetected: 0 } as Snapshot;
    expect(summarizeSnapshot(snapshot)).toMatchObject({ marketPricesPerKg: PRICES, priceConfigVersion: 3 });
  });
});

describe("MOCKED attribution from action provenance", () => {
  it("attributes harvests to Muse only when Muse planted the field first; never from timing alone", () => {
    const actions = [
      act({ actionId: "p3", type: "plantField", target: "field-3", finishedAtS: 100, params: { crop: "wheat" } }),
      act({ actionId: "h3", type: "harvestField", target: "field-3", finishedAtS: 3700 }),
      act({ actionId: "h1", type: "harvestField", target: "field-1", finishedAtS: 3600 }),
    ];
    const base = summary(0, { wheat: 0 });
    const mid = summary(3650, { wheat: 900 });
    const end = summary(3800, { wheat: 1500 }, { credits: 2400, realizedCosts: 100 });
    const s = state(actions, base, end);
    s.metrics.ledger = [ledgerEntry(base, mid, actions)!, ledgerEntry(mid, end, actions)!];
    const a = buildAttribution(s);
    expect(a.harvests.map((h) => [h.actionId, h.origin])).toEqual([["h3", "muse_planted"], ["h1", "preexisting_or_unknown"]]);
    expect(a.harvestCountByOrigin).toEqual({ muse_planted: 1, preexisting_or_unknown: 1 });
    expect(a.intervals.map((i) => i.harvestOrigin)).toEqual(["preexisting_or_unknown", "muse_planted"]);
    expect(a.positiveStockGainKgByHarvestOrigin).toEqual({ muse_planted: 600, preexisting_or_unknown: 900, mixed_pooled: 0 });
    expect(a.unsoldInventoryKg).toEqual({ "grain-wheat": 1500 });
    expect(a.netCashChange).toBe(-100);
  });

  it("marks interval attribution as mixed when harvests of different origin land in one interval", () => {
    const actions = [
      act({ actionId: "p3", type: "plantField", target: "field-3", finishedAtS: 10, params: { crop: "corn" } }),
      act({ actionId: "h3", type: "harvestField", target: "field-3", finishedAtS: 60 }),
      act({ actionId: "h1", type: "harvestField", target: "field-1", finishedAtS: 61 }),
    ];
    const s = state(actions, summary(0, {}), summary(100, { corn: 700 }));
    s.metrics.ledger = [ledgerEntry(summary(0, {}), summary(100, { corn: 700 }), actions)!];
    expect(buildAttribution(s).intervals[0]!.harvestOrigin).toBe("mixed_pooled");
  });
});

describe("MOCKED context compaction and native tool-call integrity", () => {
  const meta = (name: string, args = "{}"): ToolCallMeta => ({ name, arguments: args });
  const result = (id: string, data: Record<string, unknown>): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: id, content: JSON.stringify({ ok: true, data }) });
  const call = (id: string, name: string): ChatCompletionMessageParam => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] });

  it("stubs read results made stale by a later successful state change, keeps pairing and newer reads", () => {
    const calls = new Map<string, ToolCallMeta>([["c1", meta("describe_action", '{"type":"plantField"}')], ["c2", meta("execute_action")], ["c3", meta("observe_snapshot")]]);
    const big = "x".repeat(3000);
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "brief" },
      call("c1", "describe_action"), result("c1", { revision: 4, type: "plantField", schema: big }),
      call("c2", "execute_action"), result("c2", { accepted: true, actionId: "a1" }),
      call("c3", "observe_snapshot"), result("c3", { revision: 5, simTimeS: 10, blob: big }),
    ];
    const out = compactHistory(messages, calls);
    expect(out).toHaveLength(messages.length);
    const toolContent = (id: string) => (out.find((m) => m.role === "tool" && m.tool_call_id === id) as { content: string }).content;
    expect(toolContent("c1")).toContain("superseded");
    expect(toolContent("c1").length).toBeLessThan(400);
    expect(toolContent("c2")).toContain("accepted");
    expect(toolContent("c3")).toContain(big);
    const callIds = out.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls.map((t) => t.id) : []));
    const resultIds = out.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(resultIds).toEqual(callIds);
  });

  it("never stubs mutation results or failed reads, and does not mutate its input", () => {
    const calls = new Map<string, ToolCallMeta>([["c1", meta("describe_action", '{"type":"x"}')], ["c2", meta("advance_time")]]);
    const failed: ChatCompletionMessageParam = { role: "tool", tool_call_id: "c1", content: JSON.stringify({ ok: false, error: { code: "unknown_action_type", message: "no such type ".repeat(80) } }) };
    const messages: ChatCompletionMessageParam[] = [call("c1", "describe_action"), failed, call("c2", "advance_time"), result("c2", { grantedSeconds: 5 })];
    const snapshot = JSON.stringify(messages);
    const out = compactHistory(messages, calls);
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(out).toEqual(messages);
  });
});

describe("MOCKED terse action catalog", () => {
  it("lists exactly the simulator's eligible targets, nothing invented, and is smaller than the digest", () => {
    const terse = terseCatalog(availableActions as Parameters<typeof terseCatalog>[0]);
    for (const a of availableActions.actions) {
      const listed = terse.eligible[a.type]?.includes(a.target?.id ?? null) ?? false;
      expect(listed).toBe(a.eligibility.eligible);
      if (!a.eligibility.eligible && !terse.eligible[a.type]) expect(terse.notEligible).toContain(a.type);
    }
    expect(JSON.stringify(terse).length).toBeLessThan(JSON.stringify(digestCatalog(availableActions as Parameters<typeof digestCatalog>[0])).length);
    expect(terse.note).toMatch(/describe_action/);
  });
});
