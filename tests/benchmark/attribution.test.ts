import { describe, expect, it } from "vitest";
import { attributeProduction, type AttributionAction } from "../../src/benchmark/attribution.js";

// Mocked/pure unit tests over hand-written action histories; no simulator involved.
const a = (type: string, fieldId: string, start: number, finish: number, extra: Partial<AttributionAction> = {}): AttributionAction => ({
  type, params: { fieldId, ...(type === "plantField" ? { crop: "soybean" } : {}) }, status: "completed", startedAtS: start, finishedAtS: finish, measurements: {}, ...extra,
});
const prices = { soybean: 0.45, corn: 0.2 };

describe("attributeProduction", () => {
  it("does not credit harvests of fields the strategy never planted", () => {
    const r = attributeProduction([a("harvestField", "field-3", 100, 110, { measurements: { grainKg: 2000, hayKg: 10 } })], prices);
    expect(r.plantedByStrategy.harvests).toBe(0);
    expect(r.notPlantedByStrategy).toMatchObject({ harvests: 1, grainKg: 2000, hayKg: 10 });
    expect(r.harvests[0]).toMatchObject({ provenance: "not_planted_by_strategy", crop: null });
  });

  it("credits a harvest only after the strategy's own planting, once", () => {
    const r = attributeProduction([
      a("plantField", "field-4", 0, 5),
      a("harvestField", "field-4", 100, 110, { measurements: { grainKg: 800 } }),
      a("harvestField", "field-4", 200, 210, { measurements: { grainKg: 50 } }),
    ], prices);
    expect(r.plantedByStrategy).toMatchObject({ harvests: 1, grainKg: 800, grainKgByCrop: { soybean: 800 }, valueAtKnownPrices: 360 });
    expect(r.notPlantedByStrategy.harvests).toBe(1);
  });

  it("ignores failed actions and leaves value unknown without a price", () => {
    const r = attributeProduction([
      a("plantField", "field-1", 0, 5, { status: "failed" }),
      a("harvestField", "field-1", 50, 60, { measurements: { grainKg: 10 } }),
      a("plantField", "field-2", 0, 5),
      a("harvestField", "field-2", 50, 60, { measurements: { grainKg: 10 } }),
    ], {});
    expect(r.harvests.map((h) => h.provenance)).toEqual(["not_planted_by_strategy", "planted_by_strategy"]);
    expect(r.plantedByStrategy.valueAtKnownPrices).toBeNull();
    expect(r.revenueAttribution).toBe("aggregate_only");
  });
});
