import { describe, expect, it } from "vitest";
import { newSessionState } from "../../src/autonomy/controller.js";
import {
  irrigationNeedM3, irrigationParts, planFieldActions, reconcileQueue, runnableItems, staleReason,
  type PlanContext, type QueueItem,
} from "../../src/autonomy/actionQueue.js";
import { fieldFreshness, inspectionRefusal } from "../../src/autonomy/freshness.js";
import { SessionState } from "../../src/autonomy/types.js";
import type { FieldObservation, FieldObservations } from "../../src/contracts/fieldObservations.js";
import { GAME_ID } from "../fixtures.js";

/** Pure planner tests: hand-built authorized observations and a dry run that mirrors the simulator's published action costs. */

const NOW = 600;
const measure = (value: number, observedAtSimTimeS: number) => ({ value, unit: "fraction", uncertainty: 0.03, observedAtSimTimeS, ageS: NOW - observedAtSimTimeS, freshness: "fresh" as const, confidence: 0.8, sensorType: "remote_inspection", coverage: 1 });

function field(id: string, o: { moisture?: number; pest?: number; at?: number; capacityM3?: number; ha?: number } = {}): FieldObservation {
  const at = o.at ?? NOW - 10;
  return {
    fieldId: id, label: id, areaHa: o.ha ?? 4, knownCrop: null, knownGrowthStage: null,
    measurements: {
      ...(o.moisture !== undefined ? { soilMoisture: measure(o.moisture, at) } : {}),
      ...(o.pest !== undefined ? { pestPressure: measure(o.pest, at) } : {}),
    },
    lastObservedAtSimTimeS: at, missing: [], activeOperationActionId: null,
    soil: { capacityM3: o.capacityM3 ?? 1700, fieldCapacityFraction: 0.8, wiltingPointFraction: 0.2 },
  } as FieldObservation;
}

const observations = (...fields: FieldObservation[]): FieldObservations => ({ gameId: GAME_ID, revision: 7, simTimeS: NOW, fields }) as FieldObservations;

/** Same cost model as the simulator: irrigation $5 + $0.10/m3, pest treatment max($10, $25/ha). */
const preview: PlanContext["preview"] = async (type, params) => {
  const credits = type === "irrigateField" ? 5 + 0.1 * Number(params.volumeM3) : 100;
  return { ok: true, credits, durationS: 10, errors: [] };
};

function context(fields: FieldObservations, over: Partial<PlanContext> = {}): PlanContext {
  const state = newSessionState({ sessionId: "q", gameId: GAME_ID, modelId: "mock", mutationsEnabled: true, scenario: { startSimTimeS: 0 } });
  return { fields, nowS: NOW, credits: 5000, queue: [], riskLedger: state.riskLedger, actions: [], preview, ...over };
}

describe("irrigation sizing", () => {
  it("computes the volume from observed moisture and soil capacity, never padded and never above one operation's capacity per part", () => {
    const need = irrigationNeedM3(field("f", { moisture: 0.5 }))!;
    expect(need.volumeM3).toBeCloseTo((0.8 * 0.95 - 0.5) * 1700, 6);
    expect(irrigationParts(442, 1000)).toEqual([442]);
    const parts = irrigationParts(1980, 1000);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p <= 1000)).toBe(true);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(1980, 1);
  });

  it("schedules several irrigation operations only when one is not enough", async () => {
    const big = observations(field("big", { moisture: 0.1, capacityM3: 3000 }), field("small", { moisture: 0.5 }));
    const plan = await planFieldActions(context(big), [
      { fieldId: "big", kind: "irrigate", reason: "very dry" },
      { fieldId: "small", kind: "irrigate", reason: "dry" },
    ]);
    const bigItems = plan.queued.filter((i) => i.fieldId === "big");
    const smallItems = plan.queued.filter((i) => i.fieldId === "small");
    expect(bigItems).toHaveLength(2);
    expect(bigItems[1]!.dependsOn).toEqual([bigItems[0]!.id]);
    expect(bigItems[0]!.status).toBe("queued");
    expect(bigItems[1]!.status).toBe("planned");
    expect(smallItems).toHaveLength(1);
    expect(smallItems[0]!.quantity).toBeCloseTo(442, 0);
  });

  it("splits a need above the per-day pump limit into one operation per simulated day", async () => {
    const f = field("dry", { moisture: 0.2, capacityM3: 1000 });
    f.soil = { ...f.soil!, pumpLimitM3PerDay: 120 };
    const plan = await planFieldActions(context(observations(f)), [{ fieldId: "dry", kind: "irrigate", reason: "dry" }]);
    const items = plan.queued.filter((i) => i.fieldId === "dry");
    expect(items.length).toBeGreaterThan(1);
    expect(items.every((i) => i.quantity! <= 120 + 1e-9)).toBe(true);
    items.forEach((it2, n) => expect(it2.earliestSimTimeS).toBeCloseTo(NOW + n * 60, 6));
    expect(items[1]!.dependsOn).toEqual([items[0]!.id]);
  });

  it("rejects irrigation of a field that is already wet enough, or whose need is below the worthwhile volume", async () => {
    const wet = observations(field("wet", { moisture: 0.74 }), field("near", { moisture: 0.745 }));
    const plan = await planFieldActions(context(wet), [
      { fieldId: "wet", kind: "irrigate", reason: "check" },
      { fieldId: "near", kind: "irrigate", reason: "check" },
    ]);
    expect(plan.queued).toHaveLength(0);
    expect(plan.rejected.map((r) => r.code)).toEqual(["no_water_need", "no_water_need"]);
  });
});

describe("one inspection, several justified operations", () => {
  it("queues both irrigation and pest treatment for the same field, each with its observation reference and criteria", async () => {
    const plan = await planFieldActions(context(observations(field("f1", { moisture: 0.4, pest: 0.55 }))), [
      { fieldId: "f1", kind: "irrigate", reason: "moisture 0.40", priority: 2 },
      { fieldId: "f1", kind: "pest_treatment", reason: "pressure 0.55", priority: 1 },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.queued.map((i) => i.kind).sort()).toEqual(["irrigate", "pest_treatment"]);
    for (const item of plan.queued) {
      expect(item.observationRef.atS).toBe(NOW - 10);
      expect(item.completionCriteria.length).toBeGreaterThan(10);
      expect(item.expectedCostCredits).toBeGreaterThan(0);
      expect(item.idempotencyKey).toBeNull();
    }
    // Urgent item first.
    expect(plan.queued[0]!.kind).toBe("pest_treatment");
  });

  it("is idempotent: planning the same observation again reuses the queued items and never adds duplicates", async () => {
    const ctx = context(observations(field("f1", { moisture: 0.4, pest: 0.55 })));
    const first = await planFieldActions(ctx, [{ fieldId: "f1", kind: "irrigate", reason: "dry" }, { fieldId: "f1", kind: "pest_treatment", reason: "pests" }]);
    ctx.queue.push(...first.queued);
    const second = await planFieldActions(ctx, [{ fieldId: "f1", kind: "irrigate", reason: "dry" }, { fieldId: "f1", kind: "pest_treatment", reason: "pests" }]);
    expect(second.queued).toHaveLength(0);
    expect(second.reused.map((i) => i.id).sort()).toEqual(first.queued.map((i) => i.id).sort());
  });
});

describe("pest treatment rules", () => {
  it("never plans a treatment below the pressure threshold, without a newer observation, or inside the interval; and never stacks", async () => {
    const low = await planFieldActions(context(observations(field("f", { pest: 0.1 }))), [{ fieldId: "f", kind: "pest_treatment", reason: "x" }]);
    expect(low.rejected[0]!.code).toBe("pressure_below_threshold");

    const treated = { type: "applyTreatment", status: "completed", target: "f", finishedAtS: NOW - 5 };
    const sameReading = await planFieldActions(context(observations(field("f", { pest: 0.6, at: NOW - 20 })), { actions: [treated] }), [{ fieldId: "f", kind: "pest_treatment", reason: "x" }]);
    expect(sameReading.rejected[0]!.code).toBe("observation_predates_treatment");

    const tooSoon = await planFieldActions(context(observations(field("f", { pest: 0.6, at: NOW - 1 })), { actions: [{ ...treated, finishedAtS: NOW - 3 }] }), [{ fieldId: "f", kind: "pest_treatment", reason: "x" }]);
    expect(tooSoon.rejected[0]!.code).toBe("treatment_interval");

    // A newer reading taken a day after the treatment that still shows pests justifies exactly one more treatment.
    const later = await planFieldActions(context(observations(field("f", { pest: 0.6, at: NOW - 1 })), { actions: [{ ...treated, finishedAtS: NOW - 61 }] }), [{ fieldId: "f", kind: "pest_treatment", reason: "x" }]);
    expect(later.queued).toHaveLength(1);
  });
});

describe("economics and resources", () => {
  it("rejects an operation above the per-operation spending policy and an unusable observation", async () => {
    const pricey = await planFieldActions(context(observations(field("f", { pest: 0.6 })), { preview: async () => ({ ok: true, credits: 900, durationS: 1, errors: [] }) }), [{ fieldId: "f", kind: "pest_treatment", reason: "x" }]);
    expect(pricey.rejected[0]!.code).toBe("cost_above_policy");
    const old = await planFieldActions(context(observations(field("f", { moisture: 0.3, at: NOW - 400 }))), [{ fieldId: "f", kind: "irrigate", reason: "x" }]);
    expect(old.rejected[0]!.code).toBe("needs_observation");
  });

  it("surfaces the simulator's own refusal (for example not enough water) instead of queueing an impossible operation", async () => {
    const refused = await planFieldActions(context(observations(field("f", { moisture: 0.3 })), { preview: async () => ({ ok: false, credits: null, durationS: null, errors: [{ code: "insufficient_water" }] }) }), [{ fieldId: "f", kind: "irrigate", reason: "x" }]);
    expect(refused.queued).toHaveLength(0);
    expect(refused.rejected[0]!.code).toBe("simulator_rejected:insufficient_water");
  });

  it("shares limited credits across fields in priority order", async () => {
    const ctx = context(observations(field("a", { pest: 0.6 }), field("b", { moisture: 0.4 })), { credits: 250 });
    const plan = await planFieldActions(ctx, [
      { fieldId: "b", kind: "irrigate", reason: "dry", priority: 3 },
      { fieldId: "a", kind: "pest_treatment", reason: "pests", priority: 1 },
    ]);
    expect(plan.queued.map((i) => i.fieldId)).toEqual(["a"]);
    expect(plan.rejected.map((r) => `${r.fieldId}:${r.code}`)).toEqual(["b:insufficient_credits"]);
  });
});

describe("stale plans, dependencies and failures", () => {
  const item = async (): Promise<{ ctx: PlanContext; item: QueueItem }> => {
    const ctx = context(observations(field("f", { moisture: 0.4, pest: 0.6 })));
    const plan = await planFieldActions(ctx, [{ fieldId: "f", kind: "irrigate", reason: "dry" }]);
    return { ctx, item: plan.queued[0]! };
  };

  it("invalidates a plan when a newer reading shows the soil is much wetter, or the plan is too old", async () => {
    const { item: i } = await item();
    const wetter = observations(field("f", { moisture: 0.58, at: NOW + 5 }));
    expect(staleReason(i, { fields: wetter, nowS: NOW + 5, riskLedger: {}, actions: [] })).toMatch(/wetter/);
    const same = observations(field("f", { moisture: 0.41, at: NOW + 5 }));
    expect(staleReason(i, { fields: same, nowS: NOW + 5, riskLedger: {}, actions: [] })).toBeNull();
    expect(staleReason(i, { fields: same, nowS: NOW + 500, riskLedger: {}, actions: [] })).toMatch(/days old/);
    expect(staleReason(i, { fields: same, nowS: NOW + 5, riskLedger: {}, actions: [{ type: "irrigateField", status: "completed", target: "f", finishedAtS: NOW + 1 }] })).toMatch(/another irrigation/);
  });

  it("runs one item per field, waits for predecessors, and skips busy fields", async () => {
    const ctx = context(observations(field("big", { moisture: 0.1, capacityM3: 3000 }), field("other", { moisture: 0.4 })));
    const plan = await planFieldActions(ctx, [{ fieldId: "big", kind: "irrigate", reason: "dry" }, { fieldId: "other", kind: "irrigate", reason: "dry" }]);
    const base = { fields: ctx.fields, nowS: NOW, riskLedger: {}, actions: [] };
    const first = runnableItems(plan.queued, { ...base, busyFields: new Set() });
    expect(first.run.map((i) => i.fieldId).sort()).toEqual(["big", "other"]);
    expect(first.run.filter((i) => i.fieldId === "big")).toHaveLength(1);
    expect(runnableItems(plan.queued, { ...base, busyFields: new Set(["other"]) }).run.map((i) => i.fieldId)).toEqual(["big"]);
  });

  it("a failed part cancels its dependents but keeps unrelated fields' operations", async () => {
    const ctx = context(observations(field("big", { moisture: 0.1, capacityM3: 3000 }), field("other", { moisture: 0.4 })));
    const plan = await planFieldActions(ctx, [{ fieldId: "big", kind: "irrigate", reason: "dry" }, { fieldId: "other", kind: "irrigate", reason: "dry" }]);
    const queue = plan.queued;
    const first = queue.find((i) => i.fieldId === "big" && i.dependsOn.length === 0)!;
    first.status = "running";
    first.idempotencyKey = "k-1";
    reconcileQueue(queue, [{ idempotencyKey: "k-1", actionId: "a1", status: "failed", consumedWaterM3: null, failure: "insufficient_water", outcome: null }], [], NOW);
    expect(first.status).toBe("failed");
    expect(queue.find((i) => i.fieldId === "big" && i.dependsOn.length > 0)!.status).toBe("cancelled");
    expect(queue.find((i) => i.fieldId === "other")!.status).toBe("queued");
  });
});

describe("observation freshness", () => {
  const stateWith = (over: Record<string, unknown>) => ({ riskLedger: { f: { alertLevel: null, alertSinceS: null, lastObservedAtS: 500, ...over } } as never, actions: [] as never[] });

  it("reuses a valid reading, then lets it age out", () => {
    const state = stateWith({});
    const fresh = fieldFreshness(state, "f", 560);
    expect(fresh.verdict).toBe("reusable");
    expect(inspectionRefusal(fresh, 560)?.code).toBe("observation_still_valid");
    expect(inspectionRefusal(fieldFreshness(state, "f", 500 + 190), 690)).toBeNull();
  });

  it("is invalidated by a new warning and by an intervention, and reevaluation waits for the effect", () => {
    expect(fieldFreshness(stateWith({ alertLevel: 1, alertSinceS: 540 }), "f", 560).verdict).toBe("new_alert");
    const treated = { riskLedger: stateWith({}).riskLedger, actions: [{ type: "applyTreatment", status: "completed", target: "f", startedAtS: 520, finishedAtS: 530 }] };
    const f = fieldFreshness(treated, "f", 540);
    expect(f.verdict).toBe("intervention_since");
    expect(inspectionRefusal(f, 540)?.code).toBe("reevaluation_not_due");
    expect(inspectionRefusal(fieldFreshness(treated, "f", 530 + 61), 591)).toBeNull();
  });

  it("never trusts a field that was never observed", () => {
    expect(inspectionRefusal(fieldFreshness({ riskLedger: {}, actions: [] }, "f", 10), 10)).toBeNull();
  });
});

describe("persistence compatibility", () => {
  it("loads a session saved before the queue existed, with an empty queue", () => {
    const state = newSessionState({ sessionId: "old", gameId: GAME_ID, modelId: "mock", mutationsEnabled: true, scenario: { startSimTimeS: 0 } });
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    delete legacy.queue;
    expect(SessionState.parse(legacy).queue).toEqual([]);
  });

  it("round-trips queue items through JSON unchanged", async () => {
    const plan = await planFieldActions(context(observations(field("f", { moisture: 0.4, pest: 0.6 }))), [{ fieldId: "f", kind: "irrigate", reason: "dry" }, { fieldId: "f", kind: "pest_treatment", reason: "pests" }]);
    const state = newSessionState({ sessionId: "rt", gameId: GAME_ID, modelId: "mock", mutationsEnabled: true, scenario: { startSimTimeS: 0 } });
    state.queue.push(...plan.queued);
    expect(SessionState.parse(JSON.parse(JSON.stringify(state))).queue).toEqual(plan.queued);
  });
});
