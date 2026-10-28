import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/runtime.js";
import { toolSpecs } from "../../src/agent/tools.js";
import {
  adaptReviewWindow,
  buildCropEconomics,
  buildPlanningContext,
  GENERIC_CROP_DURATION_ESTIMATE_DAYS,
  GENERIC_CROP_WINDOW_END_DAYS,
  GENERIC_CROP_WINDOW_START_DAYS,
} from "../../src/autonomy/planning.js";
import { createAutonomousTools, SnapshotProvider } from "../../src/autonomy/tools.js";
import { newSessionState } from "../../src/autonomy/controller.js";
import { summarizeSnapshot } from "../../src/autonomy/observation.js";
import { SessionStore } from "../../src/autonomy/store.js";
import type { Snapshot } from "../../src/autonomy/observation.js";
import { PLANNING_POLICY_VERSION, TrackedAction } from "../../src/autonomy/types.js";
import { AvailableAction as AvailableActionSchema, AvailableActions } from "../../src/contracts/actions.js";
import { FarmOverview } from "../../src/contracts/overview.js";
import { FieldObservations } from "../../src/contracts/fieldObservations.js";
import type { GameEvent } from "../../src/contracts/time.js";
import { availableActions, clock, fieldObservations, GAME_ID, overview } from "../fixtures.js";
import { fakeSimulator, scriptedModel } from "../agent/harness.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshotAt(simTimeS = 0, freshness: "fresh" | "stale" | "expired" = "fresh"): Snapshot {
  const plantAction = AvailableActionSchema.parse({
    ...availableActions.actions[0]!,
    type: "plantField",
    label: "Plant field",
    target: { kind: "field", id: "field-1", label: "Field 1" },
    parametersSchema: {
      type: "object",
      properties: { crop: { type: "string", enum: ["corn", "soybean", "wheat"] } },
      required: ["crop"],
      additionalProperties: false,
    },
    eligibility: { eligible: true, issues: [] },
    estimate: { resources: { credits: 4, waterM3: 0, feedKg: 0, energyWh: 0, fuelL: 3, seedKg: 30 }, durationS: 1 },
  });
  const simClock = { ...clock, simTimeS, simDay: Math.floor(simTimeS / 60) };
  const simOverview = FarmOverview.parse({
    ...overview,
    clock: simClock,
    resources: [
      ...overview.resources,
      { kind: "seed", id: "seed-corn", label: "Corn seed", quantity: 800, unit: "kg" },
      { kind: "seed", id: "seed-soybean", label: "Soybean seed", quantity: 1500, unit: "kg" },
      { kind: "seed", id: "seed-wheat", label: "Wheat seed", quantity: 3000, unit: "kg" },
      { kind: "grain", id: "grain-corn", label: "Corn", quantity: 12, unit: "kg" },
      { kind: "grain", id: "grain-soybean", label: "Soybean", quantity: 0, unit: "kg" },
      { kind: "grain", id: "grain-wheat", label: "Wheat", quantity: 0, unit: "kg" },
    ],
    finance: {
      authorized: true as const,
      credits: 2500,
      realizedRevenue: 120,
      realizedCosts: 45,
      marketPricesPerKg: { corn: 0.2, soybean: 0.45, wheat: 0.25, hay: 0.1 },
      priceConfigVersion: 1,
    },
  });
  const fields = FieldObservations.parse({
    ...fieldObservations,
    simTimeS,
    fields: fieldObservations.fields.map((field) => ({
      ...field,
      measurements: Object.fromEntries(Object.entries(field.measurements).map(([name, value]) => [name, { ...value, freshness, ageS: freshness === "fresh" ? 5 : 10_000 }])),
    })),
  });
  return {
    gameId: GAME_ID,
    revision: 4,
    simTimeS,
    overview: simOverview,
    fields,
    actions: AvailableActions.parse({ ...availableActions, actions: [plantAction] }),
    rounds: 1,
    mixedRevisionsDetected: 0,
  };
}

function stateAt(simTimeS: number, horizonDays: number | null = 200, plantedAtS?: number) {
  const state = newSessionState({
    sessionId: "planning-test",
    gameId: GAME_ID,
    modelId: "mock",
    mutationsEnabled: true,
    planning: { horizonDays },
    scenario: { startSimTimeS: 0 },
  });
  state.lastSimTimeS = simTimeS;
  state.metrics.baseline = summarizeSnapshot(snapshotAt(0));
  state.metrics.latest = summarizeSnapshot(snapshotAt(simTimeS));
  if (plantedAtS !== undefined) {
    state.actions.push(TrackedAction.parse({
      actionId: "plant-1",
      type: "plantField",
      status: "completed",
      submittedAtRevision: 1,
      idempotencyKey: "test-key",
      lastCheckedAt: null,
      target: "field-1",
      startedAtS: plantedAtS,
      estimatedCompletionS: null,
      finishedAtS: plantedAtS,
      progress: null,
      consumedCredits: 1,
      outcome: "completed",
      failure: null,
      params: { crop: "corn" },
      consumedWaterM3: null,
      consumedSeedKg: 1,
      consumedFuelL: null,
      measurements: {},
    }));
  }
  return state;
}

const event = (kind: GameEvent["kind"]): GameEvent => ({
  eventId: 1,
  simTimeS: 100,
  kind,
  actionId: null,
  summary: "Reported event",
  data: {},
});

describe("Phase 5C factual planning context", () => {
  it("keeps the versioned policy manifest aligned with the runtime policy", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../config/phase5c-planning-v1.json", import.meta.url), "utf8")) as {
      policyVersion: string;
      time: {
        genericCropDurationEstimateDays: number;
        genericCropReviewWindowStartDaysSincePlanting: number;
        genericCropReviewWindowEndDaysSincePlanting: number;
      };
    };
    expect(manifest.policyVersion).toBe(PLANNING_POLICY_VERSION);
    expect(manifest.time).toMatchObject({
      genericCropDurationEstimateDays: GENERIC_CROP_DURATION_ESTIMATE_DAYS,
      genericCropReviewWindowStartDaysSincePlanting: GENERIC_CROP_WINDOW_START_DAYS,
      genericCropReviewWindowEndDaysSincePlanting: GENERIC_CROP_WINDOW_END_DAYS,
    });
  });

  it("compares only authorized crop quotes, stocks and catalog eligibility; expected agronomics stay unknown", () => {
    const result = buildCropEconomics(snapshotAt());
    expect(result.crops).toEqual([
      expect.objectContaining({ crop: "corn", configuredSalePriceCreditsPerKg: 0.2, seedStockKg: 800, harvestInventoryKg: 12, expectedYieldKgPerHa: null, cropSpecificDurationDays: null, seedRequirementKgPerHa: null, waterRequirement: null }),
      expect.objectContaining({ crop: "soybean", configuredSalePriceCreditsPerKg: 0.45, seedStockKg: 1500, expectedRevenuePerHaCredits: null }),
      expect.objectContaining({ crop: "wheat", configuredSalePriceCreditsPerKg: 0.25, seedStockKg: 3000 }),
    ]);
    expect(result.currentlyEligiblePlantActionTargets).toEqual(["field-1"]);
    expect(result.plantActionPreviews[0]).toMatchObject({ eligible: true, estimate: { resources: { credits: 4, seedKg: 30 } } });
    expect(JSON.stringify(result)).not.toMatch(/maxYield|gddToMaturity|rngCounter|futureWeather|groundTruth/i);
  });

  it("calculates horizon remaining from the first observation and flags late generic estimates without preventing planting", () => {
    const state = stateAt(150 * 60, 200, 150 * 60);
    const context = buildPlanningContext(state, snapshotAt(150 * 60), []);
    expect(context.horizon).toMatchObject({ currentDay: 150, startDay: 0, endDay: 200, daysRemaining: 50, configuredHorizonDays: 200 });
    expect(context.knownCropCommitments[0]).toMatchObject({
      crop: "corn",
      genericMaturityEstimateSimDay: 250,
      genericMaturityEstimateMayFallAfterHorizon: true,
    });
    expect(context.policyVersion).toBe(PLANNING_POLICY_VERSION);
  });

  it("keeps the session's configured horizon across durable save/load for resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase5c-plan-"));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    const state = stateAt(0, 200);
    const lock = store.acquire(state.sessionId);
    lock.save(state);
    lock.release();
    expect(store.load(state.sessionId).config.planning).toEqual({ policyVersion: "phase5c-v1", horizonDays: 200 });
  });
});

describe("Phase 5C adaptive review windows", () => {
  it("preserves model-selected waits away from review windows and clamps days to the horizon", () => {
    const far = adaptReviewWindow(stateAt(20 * 60, 200), snapshotAt(20 * 60), [], 30, 10);
    expect(far).toMatchObject({ requestedMaxDays: 30, effectiveMaxDays: 30, effectiveCheckpointDays: 10 });
    const horizon = adaptReviewWindow(stateAt(197.5 * 60, 200), snapshotAt(197.5 * 60), [], 30, 10);
    expect(horizon.effectiveMaxDays).toBeCloseTo(2.5);
    expect(horizon.reasons.join(" ")).toContain("experiment horizon");
  });

  it("shortens review around a known planting's generic window without inferring maturity", () => {
    const state = stateAt(90 * 60, 200, 0);
    const result = adaptReviewWindow(state, snapshotAt(90 * 60), [], 30, 8);
    expect(result).toMatchObject({ effectiveMaxDays: 5, effectiveCheckpointDays: 2 });
    expect(result.reasons.join(" ")).toContain("not crop-specific");
  });

  it("bounds review by a pending operation completion, stale measurements, and material events", () => {
    const state = stateAt(10 * 60, 200);
    state.actions.push(TrackedAction.parse({
      actionId: "operation-1", type: "prepareSoil", status: "running", submittedAtRevision: 1,
      idempotencyKey: "operation-key", lastCheckedAt: null, target: "field-1", startedAtS: 10 * 60,
      estimatedCompletionS: 11 * 60, finishedAtS: null, progress: null, consumedCredits: null,
      outcome: null, failure: null, params: {}, consumedWaterM3: null, consumedSeedKg: null,
      consumedFuelL: null, measurements: {},
    }));
    const result = adaptReviewWindow(state, snapshotAt(10 * 60, "stale"), [event("weather_alert")], 30, 10);
    expect(result.effectiveMaxDays).toBe(1);
    expect(result.effectiveCheckpointDays).toBe(1);
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons.join(" ")).toMatch(/pending-operation|stale|material event/);
  });

  it("exports the comparison as a native function tool and preserves tool-call/result pairing", async () => {
    const sim = await fakeSimulator((request) => {
      const path = request.url.split("?")[0]!;
      if (request.method !== "GET") return undefined;
      if (path.endsWith("/overview")) return { status: 200, body: { ...snapshotAt(clock.simTimeS).overview, revision: 4 } };
      if (path.endsWith("/fields")) return { status: 200, body: { ...fieldObservations, revision: 4, simTimeS: clock.simTimeS } };
      if (path.endsWith("/actions")) return { status: 200, body: { ...availableActions, actions: [snapshotAt(clock.simTimeS).actions.actions[0]], revision: 4 } };
      return undefined;
    });
    try {
      const provider = new SnapshotProvider(sim.client, GAME_ID);
      const tools = createAutonomousTools(provider, { latest: null, updates: 0 });
      const nativeTool = toolSpecs(tools, () => true).find((tool) => tool.type === "function" && tool.function.name === "compare_crop_options");
      expect(nativeTool).toMatchObject({ type: "function", function: { name: "compare_crop_options", parameters: { type: "object" } } });

      const model = scriptedModel([{ calls: [{ name: "compare_crop_options" }] }, { content: "Comparison received." }]);
      await runAgent({ provider: model, client: sim.client, gameId: GAME_ID, mode: "observe_only", tools, traceDirectory: null });
      const messages = model.requests[1]!.messages;
      const assistant = messages.find((message) => message.role === "assistant" && "tool_calls" in message && message.tool_calls?.length);
      expect(assistant?.role).toBe("assistant");
      if (assistant?.role !== "assistant" || !("tool_calls" in assistant)) throw new Error("native tool call missing");
      const callId = assistant.tool_calls![0]!.id;
      const result = messages.find((message) => message.role === "tool" && message.tool_call_id === callId);
      expect(result?.role).toBe("tool");
      expect(String(result?.content)).toContain('"expectedYieldKgPerHa":null');
      expect(String(result?.content)).toContain('"configuredSalePriceCreditsPerKg":0.45');
    } finally {
      await sim.close();
    }
  });
});
