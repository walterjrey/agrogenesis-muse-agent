import { describe, expect, it } from "vitest";
import { AUTONOMOUS_SYSTEM_PROMPT, buildBriefSections, cycleBrief, promptOperationalRecord } from "../../src/autonomy/prompt.js";
import { buildPlanningContext } from "../../src/autonomy/planning.js";
import { measureCycleBrief, estimateTokens } from "../../src/autonomy/promptMetrics.js";
import { buildProgress } from "../../src/autonomy/progress.js";
import { buildEconomics } from "../../src/autonomy/economics.js";
import { newSessionState } from "../../src/autonomy/controller.js";
import { summarizeSnapshot, type Snapshot } from "../../src/autonomy/observation.js";
import { TrackedAction } from "../../src/autonomy/types.js";
import { AvailableAction as AvailableActionSchema, AvailableActions } from "../../src/contracts/actions.js";
import { FarmOverview } from "../../src/contracts/overview.js";
import { FieldObservations } from "../../src/contracts/fieldObservations.js";
import { availableActions, clock, fieldObservations, GAME_ID, overview } from "../fixtures.js";

/**
 * Builds a consistent, multi-field snapshot (2 fields, one planted, one not) so dedup/regression assertions have
 * real cross-section data to check against (a single-field fixture would hide duplication between sections).
 */
function snapshotAt(simTimeS = 150 * 60): Snapshot {
  const plantAction = AvailableActionSchema.parse({
    ...availableActions.actions[0]!,
    type: "plantField",
    label: "Plant field",
    target: { kind: "field", id: "field-2", label: "Field 2" },
    parametersSchema: { type: "object", properties: { crop: { type: "string", enum: ["corn", "soybean", "wheat"] } }, required: ["crop"], additionalProperties: false },
    eligibility: { eligible: true, issues: [] },
    estimate: { resources: { credits: 4, waterM3: 0, feedKg: 0, energyWh: 0, fuelL: 3, seedKg: 30 }, durationS: 1 },
  });
  const simOverview = FarmOverview.parse({
    ...overview,
    clock: { ...clock, simTimeS, simDay: Math.floor(simTimeS / 60) },
    resources: [
      ...overview.resources,
      { kind: "seed", id: "seed-corn", label: "Corn seed", quantity: 800, unit: "kg" },
      { kind: "grain", id: "grain-corn", label: "Corn", quantity: 12, unit: "kg" },
    ],
    finance: { authorized: true as const, credits: 2500, realizedRevenue: 120, realizedCosts: 45, marketPricesPerKg: { corn: 0.2, soybean: 0.45, wheat: 0.25, hay: 0.1 }, priceConfigVersion: 1 },
  });
  const baseField = fieldObservations.fields[0]!;
  const fields = FieldObservations.parse({
    ...fieldObservations,
    simTimeS,
    fields: ["field-1", "field-2"].map((fieldId, i) => ({
      ...baseField,
      fieldId,
      label: `Field ${i + 1}`,
      knownCrop: { value: "corn", observedAtSimTimeS: 100_000, ageS: 72_800, freshness: "stale" as const, confidence: 0.7 },
    })),
  });
  return {
    gameId: GAME_ID, revision: 4, simTimeS, overview: simOverview, fields,
    actions: AvailableActions.parse({ ...availableActions, actions: [plantAction] }),
    rounds: 1, mixedRevisionsDetected: 0,
  };
}

function stateAt(simTimeS: number, plantedField = "field-1", plantedAtS = 10 * 60) {
  const state = newSessionState({ sessionId: "prompt-test", gameId: GAME_ID, modelId: "mock", mutationsEnabled: true, planning: { horizonDays: 200 }, scenario: { startSimTimeS: 0 } });
  state.cycle = 3;
  state.lastSimTimeS = simTimeS;
  state.metrics.baseline = summarizeSnapshot(snapshotAt(0));
  state.metrics.latest = summarizeSnapshot(snapshotAt(simTimeS));
  state.plan = { summary: "", objective: null, priorities: ["Monitor corn"], constraints: [], missingObservations: [], pendingOperations: [], nextReviewSimSeconds: null, nextStep: "continue", stopReason: null };
  state.actions.push(TrackedAction.parse({
    actionId: "plant-1", type: "plantField", status: "completed", submittedAtRevision: 1, idempotencyKey: "test-key",
    lastCheckedAt: null, target: plantedField, startedAtS: plantedAtS, estimatedCompletionS: null, finishedAtS: plantedAtS,
    progress: null, consumedCredits: 1, outcome: "completed", failure: null, params: { crop: "corn" },
    consumedWaterM3: null, consumedSeedKg: 1, consumedFuelL: null, measurements: {},
  }));
  return state;
}

describe("cycle brief deduplication (regression: previously-removed duplicates must not come back)", () => {
  it("does not repeat resourceInventory, currentCashCredits, marketPricesPerKg, economicLedger or pendingOperations in the planning block", () => {
    const state = stateAt(150 * 60);
    const context = buildPlanningContext(state, snapshotAt(150 * 60), []);
    for (const removedKey of ["resourceInventory", "currentCashCredits", "marketPricesPerKg", "economicLedger", "pendingOperations", "uncertainty"]) {
      expect(context).not.toHaveProperty(removedKey);
    }
  });

  it("drops duplicated objective/simTimeS from the operational record (kept once at the top of the brief)", () => {
    const progress = buildProgress(stateAt(150 * 60));
    const prompted = promptOperationalRecord(progress);
    expect(prompted).not.toHaveProperty("objective");
    expect(prompted).not.toHaveProperty("simTimeS");
    // The real, persisted ProgressRecord (used for resume/reporting) must be untouched.
    expect(progress.objective).toBeTruthy();
    expect(progress.simTimeS).toBe(150 * 60);
  });

  it("drops duplicated knownCrop/knownGrowthStage per field from the operational record (already in snapshot.fields)", () => {
    const progress = buildProgress(stateAt(150 * 60, "field-1"));
    const prompted = promptOperationalRecord(progress);
    for (const field of prompted.fields) {
      expect(field).not.toHaveProperty("knownCrop");
      expect(field).not.toHaveProperty("knownGrowthStage");
    }
    // The real ProgressRecord keeps both.
    expect(progress.fields[0]).toHaveProperty("knownCrop");
  });

  it("drops the nested revision/simTimeS from the per-cycle embedded field observations (duplicated by snapshot.revision/snapshot.simTimeS)", () => {
    const sections = buildBriefSections({ state: stateAt(150 * 60), snapshot: snapshotAt(150 * 60), events: [], progress: buildProgress(stateAt(150 * 60)), economics: null });
    expect(sections.snapshot.fields).not.toHaveProperty("revision");
    expect(sections.snapshot.fields).not.toHaveProperty("simTimeS");
    expect(sections.snapshot).toHaveProperty("revision");
    expect(sections.snapshot).toHaveProperty("simTimeS");
  });

  it("drops asOfSimTimeS/credits from the embedded economy block (duplicated by snapshot.simTimeS/snapshot.overview.finance.credits)", () => {
    const state = stateAt(150 * 60);
    const sections = buildBriefSections({ state, snapshot: snapshotAt(150 * 60), events: [], progress: buildProgress(state), economics: buildEconomics(state) });
    expect(sections.economy).not.toHaveProperty("asOfSimTimeS");
    expect(sections.economy).not.toHaveProperty("credits");
    // buildEconomics() itself is untouched; the full EconomicSummary still carries both.
    expect(buildEconomics(state)).toHaveProperty("asOfSimTimeS");
    expect(buildEconomics(state)).toHaveProperty("credits");
  });

  it("drops the always-null agronomic fields and the per-preview static note from the auto-embedded crop comparison, but keeps it on the on-demand tool", () => {
    const state = stateAt(150 * 60);
    const context = buildPlanningContext(state, snapshotAt(150 * 60), []);
    for (const crop of context.cropOptions.crops) {
      expect(crop).not.toHaveProperty("expectedYieldKgPerHa");
      expect(crop).not.toHaveProperty("cropSpecificDurationDays");
    }
    for (const preview of context.cropOptions.plantActionPreviews) expect(preview).not.toHaveProperty("note");
    expect(context.cropOptions).not.toHaveProperty("asOf");
  });
});

describe("cycle brief decision-critical information is preserved after dedup", () => {
  const state = stateAt(150 * 60, "field-1");
  const snapshot = snapshotAt(150 * 60);
  const progress = buildProgress(state);
  const economics = buildEconomics(state);
  const sections = buildBriefSections({ state, snapshot, events: [], progress, economics });

  it("keeps field conditions and measurements (values, uncertainty, freshness, confidence)", () => {
    expect(sections.snapshot.fields.fields).toHaveLength(2);
    const field = sections.snapshot.fields.fields.find((f: { id: string }) => f.id === "field-1")!;
    expect(field.m.soilMoisture).toMatchObject({ v: expect.any(Number), fresh: expect.any(String), c: expect.any(Number) });
  });

  it("keeps crop identity/growth-stage facts once, from the operational record (plantedCrop, simDaysSincePlanting)", () => {
    const field = sections.operationalRecord.fields.find((f: { fieldId: string }) => f.fieldId === "field-1")!;
    expect(field.plantedCrop).toBe("corn");
    expect(field.simDaysSincePlanting).toBeGreaterThan(0);
  });

  it("keeps resources, weather and finance in the raw overview", () => {
    expect(sections.snapshot.overview.resources.length).toBeGreaterThan(0);
    expect(sections.snapshot.overview.weather).toBeDefined();
    expect(sections.snapshot.overview.finance).toMatchObject({ authorized: true, credits: expect.any(Number) });
  });

  it("keeps available actions and eligibility (terse catalog)", () => {
    expect(sections.snapshot.actions.eligible).toHaveProperty("plantField");
  });

  it("keeps action cost/duration constraints for a plantable field via the crop comparison", () => {
    const preview = sections.planning.cropOptions.plantActionPreviews.find((p: { fieldId: string | null }) => p.fieldId === "field-2")!;
    expect(preview).toMatchObject({ eligible: true, estimate: { resources: { credits: 4, seedKg: 30 } } });
  });

  it("keeps the current objective and horizon/planning facts", () => {
    expect(sections.objective).toBeTruthy();
    expect(sections.planning.horizon).toMatchObject({ configuredHorizonDays: 200 });
    expect(sections.planning.knownCropCommitments.length).toBeGreaterThan(0);
  });
});

describe("tool-usage guidance and inspection visibility", () => {
  const input = (mutationsEnabled: boolean, acceptedInspections = 0) => {
    const state = stateAt(150 * 60);
    state.config.mutationsEnabled = mutationsEnabled;
    state.config.limits = { ...state.config.limits, maxInspections: 6 };
    state.budgets.acceptedInspections = acceptedInspections;
    return { state, snapshot: snapshotAt(150 * 60), events: [], progress: buildProgress(state), economics: buildEconomics(state) };
  };

  it("exposes the remaining inspection budget independently of mutations, and 0 when observe-only", () => {
    expect(buildBriefSections(input(true)).remainingBudgets).toMatchObject({ inspections: 6 });
    expect(buildBriefSections(input(true, 4)).remainingBudgets).toMatchObject({ inspections: 2 });
    expect(buildBriefSections(input(true, 9)).remainingBudgets).toMatchObject({ inspections: 0 });
    expect(buildBriefSections(input(false)).remainingBudgets).toMatchObject({ inspections: 0 });
  });

  it("does not instruct the model to inspect, only that an allowance is not a reason to use it", () => {
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("Having an allowance is not a reason to use it");
    expect(AUTONOMOUS_SYSTEM_PROMPT).not.toMatch(/(always|must) (inspect|survey|irrigate)/i);
  });

  it("keeps wait_for_operation available but points at automatic supervision, and keeps mandatory re-observation", () => {
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("wait_for_operation remains available");
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("automatically supervises a pending operation");
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("call observe_snapshot again before the next mutation");
  });

  it("asks for describe_action once per type while still allowing it when needed", () => {
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("only once per action type");
    expect(AUTONOMOUS_SYSTEM_PROMPT).toContain("call describe_action again only when");
  });
});

describe("golden prompt construction", () => {
  it("builds the expected top-level shape for a known fixture (regression against accidental section renames/removals)", () => {
    const state = stateAt(150 * 60);
    const snapshot = snapshotAt(150 * 60);
    const sections = buildBriefSections({ state, snapshot, events: [], progress: buildProgress(state), economics: buildEconomics(state) });
    expect(Object.keys(sections)).toEqual([
      "objective", "mode", "cycle", "remainingBudgets", "previousPlan", "recentDecisions",
      "operationalRecord", "economy", "planning", "eventsSinceLastCycle", "snapshot",
    ]);
    expect(Object.keys(sections.planning)).toEqual([
      "policyVersion", "horizon", "cropOptions", "genericCropWindow", "knownCropCommitments",
      "criticalObservationFreshness", "missingCriticalObservations", "relevantRecentEvents",
    ]);
  });

  it("cycleBrief() stringifies buildBriefSections() under one short wrapper sentence", () => {
    const state = stateAt(150 * 60);
    const snapshot = snapshotAt(150 * 60);
    const input = { state, snapshot, events: [], progress: buildProgress(state), economics: buildEconomics(state) };
    const brief = cycleBrief(input);
    expect(brief.startsWith(`Decision cycle ${state.cycle}.`)).toBe(true);
    expect(JSON.parse(brief.slice(brief.indexOf("\n") + 1))).toEqual(buildBriefSections(input));
  });
});

describe("prompt token instrumentation", () => {
  it("estimateTokens applies the documented chars-per-token heuristic and rounds up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });

  it("measureCycleBrief reports one entry per top-level brief section, the cycle number, and the system prompt separately", () => {
    const state = stateAt(150 * 60);
    const snapshot = snapshotAt(150 * 60);
    const input = { state, snapshot, events: [], progress: buildProgress(state), economics: buildEconomics(state) };
    const report = measureCycleBrief(input);
    expect(report.cycle).toBe(state.cycle);
    expect(report.sections.map((s) => s.section)).toEqual(Object.keys(buildBriefSections(input)));
    expect(report.briefChars).toBe(report.sections.reduce((sum, s) => sum + s.chars, 0));
    expect(report.systemPromptChars).toBeGreaterThan(0);
    expect(report.totalEstimatedTokens).toBe(report.briefEstimatedTokens + report.systemPromptEstimatedTokens);
  });
});
