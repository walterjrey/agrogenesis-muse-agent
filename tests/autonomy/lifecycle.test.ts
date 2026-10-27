import { afterEach, describe, expect, it } from "vitest";
import { superviseInterval, type SupervisorDeps } from "../../src/autonomy/supervisor.js";
import { compactFields } from "../../src/autonomy/compactObservation.js";
import { buildProgress } from "../../src/autonomy/progress.js";
import { buildReport } from "../../src/autonomy/report.js";
import { newSessionState } from "../../src/autonomy/controller.js";
import type { SessionState, TrackedAction } from "../../src/autonomy/types.js";
import type { FieldObservations } from "../../src/contracts/fieldObservations.js";
import { fieldObservations, GAME_ID } from "../fixtures.js";
import { countingIds } from "../agent/harness.js";
import { timedSim, type TimedSim, type TimedSimOptions } from "./timedSim.js";

/**
 * Everything here is MOCKED (time-aware fake HTTP simulator, hand-built session state). It checks the review-interval
 * supervisor, the progress/report bookkeeping and the context compaction. It says NOTHING about the real crop
 * mechanics, which live in the simulator and are evidenced by the live run documented in docs/CROP_LIFECYCLE.md.
 */

let sim: TimedSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});
const ids = countingIds();

async function start(options: TimedSimOptions = {}, timeoutMs = 2000) {
  sim = await timedSim(options, timeoutMs);
  return sim;
}

function deps(s: TimedSim, over: Partial<SupervisorDeps> = {}) {
  let cursor = 0;
  const advanced: number[] = [];
  const base: SupervisorDeps = {
    client: s.client,
    gameId: GAME_ID,
    newMutationId: ids,
    retryDelayMs: 1,
    maxMutationRetries: 2,
    budget: { requestsLeft: 50, simSecondsLeft: 100_000, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 3 },
    getCursor: () => cursor,
    setCursor: (c) => { cursor = c; },
    onAdvanced: (granted) => { advanced.push(granted); },
  };
  return { deps: { ...base, ...over }, advanced };
}

describe("MOCKED review-interval supervisor", () => {
  it("covers the model's horizon in checkpoint-sized advances and never asks for the server maximum", async () => {
    const s = await start({ maxGrantS: 14_400 });
    const { deps: d, advanced } = deps(s);
    const result = await superviseInterval(d, { maxSeconds: 20 * 60, checkpointSeconds: 5 * 60 });
    expect(result).toMatchObject({ outcome: "horizon_reached", advanceRequests: 4, checkpoints: 4, advancedSeconds: 1200, advancedSimDays: 20 });
    expect(s.state.advances.map((a) => a.requested)).toEqual([300, 300, 300, 300]);
    expect(advanced).toEqual([300, 300, 300, 300]);
    expect(s.state.simTimeS).toBe(1200);
  });

  it("returns control at the checkpoint where a weather alert occurred, without spending the rest of the horizon", async () => {
    const s = await start({ weatherAtS: 400 });
    const result = await superviseInterval(deps(s).deps, { maxSeconds: 30 * 60, checkpointSeconds: 5 * 60 });
    expect(result.outcome).toBe("event_interrupt");
    expect(result.advanceRequests).toBe(2);
    expect(result.events.join("\n")).toContain("weather_alert");
    expect(s.state.simTimeS).toBe(600);
  });

  it("respects the simulated-time and request budgets", async () => {
    const a = await start();
    const r1 = await superviseInterval(deps(a, { budget: { requestsLeft: 50, simSecondsLeft: 700, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 3 } }).deps, { maxSeconds: 1800, checkpointSeconds: 300 });
    expect(r1).toMatchObject({ outcome: "wait_limit", advancedSeconds: 700 });
    await a.close();
    const b = await start();
    const r2 = await superviseInterval(deps(b, { budget: { requestsLeft: 2, simSecondsLeft: 100_000, maxChunkSeconds: 600, maxCallSeconds: 3600, conflictsLeft: 3 } }).deps, { maxSeconds: 1800, checkpointSeconds: 300 });
    expect(r2).toMatchObject({ outcome: "wait_limit", advanceRequests: 2 });
    expect(b.advancePosts).toHaveLength(2);
  });

  it("refreshes the revision after a 409 and does not advance twice", async () => {
    const s = await start({ staleOnce: 1 });
    const result = await superviseInterval(deps(s).deps, { maxSeconds: 600, checkpointSeconds: 300 });
    expect(result).toMatchObject({ outcome: "horizon_reached", conflicts: 1, advancedSeconds: 600 });
    expect(s.state.simTimeS).toBe(600);
  });

  it("reports outcome_unknown after a lost response; the simulator applied exactly one advance and a retry with the same key replays it", async () => {
    const s = await start({ loseResponses: 100 }, 150);
    const result = await superviseInterval(deps(s).deps, { maxSeconds: 600, checkpointSeconds: 300 });
    expect(result.outcome).toBe("outcome_unknown");
    expect(s.state.advances).toHaveLength(1);
    expect(s.state.simTimeS).toBe(300);
    const keys = new Set(s.advancePosts.map((p) => p.idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it("is deterministic: the same inputs against the same mocked server give identical advance sequences", async () => {
    const run = async () => {
      const s = await start({ weatherAtS: 700 });
      const r = await superviseInterval(deps(s).deps, { maxSeconds: 1800, checkpointSeconds: 300 });
      const out = { r, advances: s.state.advances.map((a) => [a.requested, a.granted]) };
      await s.close();
      sim = undefined;
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });
});

describe("MOCKED context compaction of field observations", () => {
  const template = (fieldObservations as unknown as FieldObservations).fields[0]!;
  const quantity = (name: string, i: number) => ({ ...template.measurements.soilMoisture!, value: 0.2 + i / 100, observedAtSimTimeS: 100 + i, ageS: 7.5 + i });
  const obs: FieldObservations = {
    ...(fieldObservations as unknown as FieldObservations),
    fields: ["field-1", "field-2", "field-3", "field-4"].map((id, i) => ({
      ...template,
      fieldId: id,
      label: `Field number ${i + 1} (${id})`,
      measurements: Object.fromEntries(["soilMoisture", "soilFertility", "cropHealth", "pestPressure", "waterAvailability", "vegetationCoverage"].map((n) => [n, quantity(n, i)])),
      missing: ["yieldEstimate"],
    })),
  };

  it("is substantially smaller but keeps values, uncertainty, observation times, freshness, confidence and missing quantities", () => {
    const compact = compactFields(obs);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(obs).length * 0.7);
    expect(compact.revision).toBe(obs.revision);
    expect(compact.simTimeS).toBe(obs.simTimeS);
    for (const f of obs.fields) {
      const c = compact.fields.find((x) => x.id === f.fieldId)!;
      expect(c).toBeDefined();
      for (const [name, m] of Object.entries(f.measurements)) {
        const cm = c.m[name]!;
        expect(cm.v).toBeCloseTo(m.value, 3);
        expect(cm.at).toBeCloseTo(m.observedAtSimTimeS, 1);
        expect(cm.fresh).toBe(m.freshness);
        if (m.uncertainty !== null) expect(cm.sd).toBeCloseTo(m.uncertainty, 3);
      }
      const missing = (c as { unobserved?: string[] }).unobserved ?? compact.unobservedInEveryField ?? [];
      expect(missing).toEqual(f.missing);
    }
    expect(compact.note).toMatch(/crop identity or growth stage/);
  });
});

function tracked(over: Partial<TrackedAction>): TrackedAction {
  return {
    actionId: "a", type: "x", status: "completed", submittedAtRevision: 1, idempotencyKey: "k", lastCheckedAt: null, target: "field-4", startedAtS: 0, estimatedCompletionS: null, finishedAtS: 0,
    progress: 1, consumedCredits: null, outcome: null, failure: null, params: {}, consumedWaterM3: null, consumedSeedKg: null, consumedFuelL: null, ...over,
  } as TrackedAction;
}

function stateWith(actions: TrackedAction[], simTimeS: number): SessionState {
  const s = newSessionState({ sessionId: "life-1", gameId: GAME_ID, modelId: "test", mutationsEnabled: true });
  s.actions = actions;
  s.lastSimTimeS = simTimeS;
  s.metrics.latest = { revision: 1, simTimeS, credits: 2500, realizedRevenue: 0, realizedCosts: 0, marketPricesPerKg: null, priceConfigVersion: null, resources: [], activeActions: 0, fields: [{ fieldId: "field-4", knownCrop: null, knownGrowthStage: null, missingCount: 0 }] };
  return s;
}

describe("MOCKED progress and economic bookkeeping", () => {
  it("derives what was planted and the simulated days since from the session's own completed actions", () => {
    const s = stateWith([tracked({ actionId: "p", type: "plantField", params: { crop: "wheat", fieldId: "field-4" }, finishedAtS: 10, consumedSeedKg: 120, consumedCredits: 50 })], 10 + 60 * 30);
    const field = buildProgress(s).fields.find((f) => f.fieldId === "field-4");
    expect(field).toMatchObject({ plantedCrop: "wheat", plantedAtSimTimeS: 10, simDaysSincePlanting: 30 });
  });

  it("forgets the planting after a later completed harvest and records the harvest time", () => {
    const s = stateWith([
      tracked({ actionId: "p", type: "plantField", params: { crop: "wheat" }, finishedAtS: 10 }),
      tracked({ actionId: "h", type: "harvestField", finishedAtS: 6000 }),
    ], 6100);
    const field = buildProgress(s).fields.find((f) => f.fieldId === "field-4");
    expect(field).toMatchObject({ plantedCrop: null, simDaysSincePlanting: null, lastHarvestAtSimTimeS: 6000 });
  });

  it("reports the crop cycle as completed only when a harvest AND a sale really completed, with measured costs", () => {
    const base = [
      tracked({ actionId: "i", type: "inspectField", finishedAtS: 5 }),
      tracked({ actionId: "p", type: "plantField", params: { crop: "soybean" }, finishedAtS: 10, consumedSeedKg: 100, consumedCredits: 40 }),
      tracked({ actionId: "w", type: "irrigateField", consumedWaterM3: 12.5, consumedCredits: 3 }),
    ];
    const open = buildReport(stateWith(base, 100)).lifecycle;
    expect(open).toMatchObject({ cropCycleCompleted: false, inspections: 1, irrigations: { count: 1, waterM3Consumed: 12.5 }, seedConsumedKg: 100, actionCreditsByType: { plantField: 40, irrigateField: 3 } });
    const closed = buildReport(stateWith([...base, tracked({ actionId: "h", type: "harvestField", finishedAtS: 6000 }), tracked({ actionId: "s", type: "sellHarvest", params: { product: "grain-soybean", kg: 500 }, finishedAtS: 6001 })], 6100)).lifecycle;
    expect(closed.cropCycleCompleted).toBe(true);
    expect(closed.sales).toEqual([expect.objectContaining({ product: "grain-soybean", kg: 500 })]);
  });
});
