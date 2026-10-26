import { describe, expect, it } from "vitest";
import { ActionStatusResponse, AvailableActions, ExecuteActionResponse, FarmOverview, FieldObservations } from "../src/contracts/index.js";
import { availableActions, executeAccepted, fieldObservations, overview } from "./fixtures.js";

describe("contracts (mocked fixtures)", () => {
  it("accepts well-formed payloads", () => {
    expect(FarmOverview.safeParse(overview).success).toBe(true);
    expect(FieldObservations.safeParse(fieldObservations).success).toBe(true);
    expect(AvailableActions.safeParse(availableActions).success).toBe(true);
    expect(ExecuteActionResponse.safeParse(executeAccepted).success).toBe(true);
    expect(ActionStatusResponse.safeParse({ gameId: executeAccepted.gameId, action: executeAccepted.action }).success).toBe(true);
  });

  it("rejects leaked ground-truth fields in observations", () => {
    const leaked = structuredClone(fieldObservations) as Record<string, unknown>;
    (leaked.fields as Record<string, unknown>[])[0]!.trueSoilMoisture = 0.31;
    expect(FieldObservations.safeParse(leaked).success).toBe(false);

    const leakedMeasurement = structuredClone(fieldObservations);
    (leakedMeasurement.fields[0]!.measurements.soilMoisture as Record<string, unknown>).trueValue = 0.31;
    expect(FieldObservations.safeParse(leakedMeasurement).success).toBe(false);

    expect(FarmOverview.safeParse({ ...overview, snapshot: {} }).success).toBe(false);
  });

  it("requires rejected executions to explain why and accepted ones to be error-free", () => {
    expect(ExecuteActionResponse.safeParse({ ...executeAccepted, accepted: false, errors: [] }).success).toBe(false);
    expect(ExecuteActionResponse.safeParse({ ...executeAccepted, errors: [{ code: "x", detail: "y" }] }).success).toBe(false);
    expect(ExecuteActionResponse.safeParse({ ...executeAccepted, accepted: false, action: null, errors: [{ code: "insufficient_credits", detail: "Not enough credits." }] }).success).toBe(true);
  });
});
