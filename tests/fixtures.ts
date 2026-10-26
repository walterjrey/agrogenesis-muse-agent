/** Hand-written MOCK payloads that follow the agent contracts. They are not real simulator output. */
export const GAME_ID = "7b0f5c0e-2f7e-4c1c-9d7a-0d1b2c3d4e5f";

export const clock = { simTimeS: 172_800, simDay: 2, tickCount: 3456, paused: false };

export const games = {
  games: [{ gameId: GAME_ID, name: "Mock farm", managementMode: "manual", lifecycle: "running", scopes: ["observe"] }],
};

export const overview = {
  gameId: GAME_ID,
  revision: 4,
  clock,
  weather: { observedAtSimTimeS: 172_000, ageS: 800, temperatureC: 18.5, precipitationMmPerDay: 0, windSpeedMs: 3.1, source: "station", confidence: 0.9 },
  resources: [{ kind: "water", id: "reservoir", label: "Reservoir", quantity: 820, unit: "m3" }],
  equipment: [{ id: "tractor-1", kind: "tractor", label: "Tractor 1", status: "idle", batteryFraction: null, currentActionId: null }],
  status: { fieldCount: 1, pastureCount: 0, activeActionCount: 0, summary: "Mock status" },
  finance: { authorized: true, credits: 12_000, realizedRevenue: 0, realizedCosts: 300 },
};

export const fieldObservations = {
  gameId: GAME_ID,
  revision: 4,
  simTimeS: clock.simTimeS,
  fields: [{
    fieldId: "field-1",
    label: "North field",
    areaHa: 4.2,
    knownCrop: { value: "corn", observedAtSimTimeS: 100_000, ageS: 72_800, freshness: "stale", confidence: 0.7 },
    knownGrowthStage: null,
    measurements: {
      soilMoisture: { value: 0.27, unit: "m3/m3", uncertainty: 0.03, observedAtSimTimeS: 100_000, ageS: 72_800, freshness: "stale", confidence: 0.7, sensorType: "rover_soil_profiler", coverage: 0.2 },
    },
    lastObservedAtSimTimeS: 100_000,
    missing: ["soilFertility", "pestPressure"],
    activeOperationActionId: null,
  }],
};

export const availableActions = {
  gameId: GAME_ID,
  revision: 4,
  simTimeS: clock.simTimeS,
  actions: [{
    type: "inspectField",
    label: "Remote field inspection",
    category: "agriculture",
    description: "Adds noisy observations of the whole field to agent knowledge.",
    target: { kind: "field", id: "field-1", label: "North field" },
    parametersSchema: { type: "object", properties: { fieldId: { type: "string" } }, required: ["fieldId"], additionalProperties: false },
    preconditions: ["Field exists", "Enough credits"],
    constraints: [],
    requiredEquipment: [],
    estimate: { resources: { credits: 20, waterM3: 0, feedKg: 0, energyWh: 0, fuelL: 0, seedKg: 0 }, durationS: 0 },
    eligibility: { eligible: true, issues: [] },
    asynchronous: false,
    approvalRequired: false,
    cancellation: "never",
  }],
};

const zeroResources = { credits: 0, waterM3: 0, feedKg: 0, energyWh: 0, fuelL: 0, seedKg: 0 };

export const executeAccepted = {
  gameId: GAME_ID,
  revision: 5,
  accepted: true,
  dryRun: false,
  action: {
    actionId: "act-1", type: "irrigateField", status: "scheduled", target: { kind: "field", id: "field-1", label: "North field" },
    requestedAtS: 172_800, startAtS: 172_800, startedAtS: null, finishedAtS: null, estimatedCompletionS: 190_000, progress: null,
    reserved: { ...zeroResources, credits: 40, waterM3: 50 }, consumed: zeroResources, outcome: null, failure: null,
  },
  errors: [],
  asynchronous: true,
};
