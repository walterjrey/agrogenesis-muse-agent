import { describe, expect, it } from "vitest";
import { INSPECTION_ACTION_TYPES, isInspectionActionType } from "../../src/autonomy/actionClassification.js";

describe("action classification", () => {
  it("classifies the reviewed observation-only action types as inspections", () => {
    for (const type of ["inspectField", "surveyField", "inspectLocation", "sampleSoil", "inspectPestPressure"]) {
      expect(isInspectionActionType(type)).toBe(true);
    }
    expect(INSPECTION_ACTION_TYPES.size).toBe(5);
  });

  it("classifies real farm-mutating actions and robot logistics as non-inspections", () => {
    for (const type of ["prepareSoil", "plantField", "irrigateField", "harvestField", "applyTreatment", "sellHarvest", "returnToBase", "rechargeRobot"]) {
      expect(isInspectionActionType(type)).toBe(false);
    }
  });

  it("treats unknown, missing or non-string types as non-inspections rather than guessing", () => {
    expect(isInspectionActionType(undefined)).toBe(false);
    expect(isInspectionActionType(null)).toBe(false);
    expect(isInspectionActionType(42)).toBe(false);
    expect(isInspectionActionType("someFutureActionType")).toBe(false);
  });
});
