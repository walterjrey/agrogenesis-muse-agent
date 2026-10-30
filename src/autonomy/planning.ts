import type { GameEvent } from "../contracts/time.js";
import type { Snapshot } from "./observation.js";
import { buildProgress } from "./progress.js";
import type { ProgressRecord, SessionState } from "./types.js";

export const GENERIC_CROP_DURATION_ESTIMATE_DAYS = 100;
export const GENERIC_CROP_WINDOW_START_DAYS = 75;
export const GENERIC_CROP_WINDOW_END_DAYS = 115;

const DAY_SECONDS = 60;
const MAX_WAIT_DAYS = 30;
const DEFAULT_REVIEW_CHECKPOINT_DAYS = 5;
const FAR_REVIEW_CHECKPOINT_DAYS = 10;
const NEAR_WINDOW_CHECKPOINT_DAYS = 2;
const NEAR_WINDOW_MAX_WAIT_DAYS = 5;
const UNCERTAIN_OBSERVATION_MAX_WAIT_DAYS = 5;
const RECENT_EVENT_MAX_WAIT_DAYS = 5;
const MIN_OPERATION_REVIEW_DAYS = 0.5;
const CRITICAL_MEASUREMENTS = new Set(["soilMoisture", "cropHealth", "pestPressure"]);
const MATERIAL_EVENT_KINDS = new Set(["action_failed", "action_cancelled", "weather_alert", "mode_changed", "equipment_status_changed", "action_completed"]);
const SEVERE_ATTENTION_MAX_WAIT_DAYS = 2;
const SEVERE_ATTENTION_CHECKPOINT_DAYS = 1;
const ATTENTION_MAX_WAIT_DAYS = 3;

/** A resolved warning is information; a new or escalated active one is a material planning signal. */
function isMaterialEvent(event: GameEvent): boolean {
  return MATERIAL_EVENT_KINDS.has(event.kind) || (event.kind === "field_attention" && event.data.status !== "resolved");
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CropOptionFacts {
  crop: string;
  configuredSalePriceCreditsPerKg: number | null;
  seedStockKg: number | null;
  harvestInventoryKg: number | null;
  /** Not published as crop-specific expectations by the authorized agent API. */
  expectedYieldKgPerHa: null;
  expectedRevenuePerHaCredits: null;
  cropSpecificDurationDays: null;
  seedRequirementKgPerHa: null;
  waterRequirement: null;
}

/**
 * Crop comparison made only from one consistent, authorized agent snapshot.
 * The simulator action preview is reported separately because it is not parameterized by crop.
 */
export function buildCropEconomics(snapshot: Snapshot) {
  const planting = snapshot.actions.actions.filter((action) => action.type === "plantField");
  const schema = planting.map((action) => action.parametersSchema).find((candidate) => {
    const properties = candidate.properties;
    if (!properties || typeof properties !== "object") return false;
    const crop = (properties as Record<string, unknown>).crop;
    return !!crop && typeof crop === "object" && Array.isArray((crop as { enum?: unknown }).enum);
  });
  const properties = schema?.properties;
  const cropNode = properties && typeof properties === "object" ? (properties as Record<string, unknown>).crop : undefined;
  const cropValues = cropNode && typeof cropNode === "object" ? (cropNode as { enum?: unknown }).enum : undefined;
  const crops = Array.isArray(cropValues) ? cropValues.filter((crop): crop is string => typeof crop === "string") : [];

  const resource = (kind: string, id: string): number | null =>
    snapshot.overview.resources.find((entry) => entry.kind === kind && entry.id === id)?.quantity ?? null;
  const finance = snapshot.overview.finance;
  const prices = finance.authorized ? finance.marketPricesPerKg : undefined;
  const cropOptions: CropOptionFacts[] = crops.map((crop) => ({
    crop,
    configuredSalePriceCreditsPerKg: prices?.[crop] ?? null,
    seedStockKg: resource("seed", `seed-${crop}`),
    harvestInventoryKg: resource("grain", `grain-${crop}`),
    expectedYieldKgPerHa: null,
    expectedRevenuePerHaCredits: null,
    cropSpecificDurationDays: null,
    seedRequirementKgPerHa: null,
    waterRequirement: null,
  }));
  const plantActionPreviews = planting.map((entry) => ({
    fieldId: entry.target?.id ?? null,
    eligible: entry.eligibility.eligible,
    reason: entry.eligibility.issues.map((issue) => issue.code).join(",") || null,
    estimate: entry.estimate,
    note: "Simulator action preview for this target; the agent API does not expose a crop-specific estimate here.",
  }));

  return {
    asOf: { revision: snapshot.revision, simTimeS: snapshot.simTimeS },
    currency: finance.authorized ? "simulator credits" : "unknown",
    crops: cropOptions,
    currentlyEligiblePlantActionTargets: [...new Set(planting.filter((entry) => entry.eligibility.eligible && entry.target?.id).map((entry) => entry.target!.id))].sort(),
    plantActionPreviews,
    unknowns: [
      "Expected yield, expected revenue per area, crop-specific duration, seed rate and crop-specific water requirement are not published by the authorized agent API.",
      "The configured sale quote is not a forecast and does not establish profitability.",
      "Field suitability is only the simulator's current action eligibility; no crop-specific suitability score is published.",
    ],
  };
}

function currentCropDays(snapshot: Snapshot, state: SessionState): number {
  return state.config.scenario.startSimTimeS === null
    ? snapshot.simTimeS / DAY_SECONDS
    : (snapshot.simTimeS - state.config.scenario.startSimTimeS) / DAY_SECONDS;
}

/**
 * Per-cycle embedding of the crop comparison: drops the always-null agronomic fields (never published by the
 * agent API; the `unknowns` note already says so once) and the `asOf` stamp (the snapshot revision/simTimeS are
 * already at the top of this same brief). Also drops the per-preview `note` (static boilerplate repeated once per
 * plantable field, every cycle; the same fact is already covered once by `unknowns`). The full detail, including
 * explicit nulls and the per-preview note, stays available on demand via the compare_crop_options tool, which
 * calls buildCropEconomics directly and is unaffected by this.
 */
function compactCropOptions(facts: ReturnType<typeof buildCropEconomics>) {
  return {
    currency: facts.currency,
    crops: facts.crops.map(({ crop, configuredSalePriceCreditsPerKg, seedStockKg, harvestInventoryKg }) => ({ crop, configuredSalePriceCreditsPerKg, seedStockKg, harvestInventoryKg })),
    currentlyEligiblePlantActionTargets: facts.currentlyEligiblePlantActionTargets,
    plantActionPreviews: facts.plantActionPreviews.map(({ note: _note, ...rest }) => { void _note; return rest; }),
    unknowns: facts.unknowns,
  };
}

/**
 * Compact planning facts: estimates remain explicitly generic, while all farm facts come from authorized API data.
 * `progress` may be supplied by the caller to avoid recomputing it (it is already built once per cycle); omitting
 * it keeps this function usable on its own.
 */
export function buildPlanningContext(state: SessionState, snapshot: Snapshot, events: GameEvent[], progress: ProgressRecord = buildProgress(state)) {
  const currentDay = snapshot.simTimeS / DAY_SECONDS;
  const reportedWholeDay = snapshot.overview.clock.simDay;
  const startSimTimeS = state.config.scenario.startSimTimeS ?? snapshot.simTimeS;
  const horizonEndDay = state.config.planning.horizonDays === null ? null : startSimTimeS / DAY_SECONDS + state.config.planning.horizonDays;
  const daysRemaining = horizonEndDay === null ? null : Math.max(0, horizonEndDay - currentDay);
  const elapsedSessionDays = currentCropDays(snapshot, state);
  // Numeric guidance only; the rationale (generic, not crop-specific, not a maturity observation) lives once in
  // the system prompt instead of being restated in every cycle's brief.
  const cropWindow = {
    estimateDays: GENERIC_CROP_DURATION_ESTIMATE_DAYS,
    reviewWindowDaysSincePlanting: [GENERIC_CROP_WINDOW_START_DAYS, GENERIC_CROP_WINDOW_END_DAYS],
  };
  const commitments = progress.fields
    .filter((field) => field.plantedCrop !== null && field.plantedAtSimTimeS !== null)
    .map((field) => {
      const ageDays = field.simDaysSincePlanting;
      const estimatedDaysUntilGenericWindow = ageDays === null ? null : Math.max(0, GENERIC_CROP_DURATION_ESTIMATE_DAYS - ageDays);
      return {
        fieldId: field.fieldId,
        crop: field.plantedCrop,
        plantedAtSimDay: field.plantedAtSimTimeS! / DAY_SECONDS,
        ageDays,
        genericMaturityEstimateSimDay: field.plantedAtSimTimeS! / DAY_SECONDS + GENERIC_CROP_DURATION_ESTIMATE_DAYS,
        estimatedDaysUntilGenericWindow,
        genericMaturityEstimateMayFallAfterHorizon: horizonEndDay === null
          ? null
          : field.plantedAtSimTimeS! / DAY_SECONDS + GENERIC_CROP_DURATION_ESTIMATE_DAYS > horizonEndDay,
      };
    });
  const criticalFreshness = snapshot.fields.fields.flatMap((field) =>
    [...CRITICAL_MEASUREMENTS].flatMap((measurement) => {
      const value = field.measurements[measurement];
      return value ? [{ fieldId: field.fieldId, measurement, freshness: value.freshness, ageS: value.ageS }] : [];
    }),
  );
  const relevantEvents = events.filter(isMaterialEvent);

  return {
    policyVersion: state.config.planning.policyVersion,
    horizon: {
      currentDay,
      reportedWholeDay,
      startDay: startSimTimeS / DAY_SECONDS,
      endDay: horizonEndDay,
      daysRemaining,
      configuredHorizonDays: state.config.planning.horizonDays,
      /** Does not reveal crop maturity; see knownCropCommitments for per-field generic maturity estimates. */
      elapsedSessionDays: round2(Math.max(0, elapsedSessionDays)),
      note: horizonEndDay === null ? "Evaluation horizon not configured; session time budget remains a separate hard limit." : "Horizon is measured from the first authorized observation; it informs planning but does not prohibit any action.",
    },
    // currentCashCredits, resourceInventory and marketPricesPerKg are not repeated here: they are already in
    // this same brief's snapshot.overview (finance.credits, resources, finance.marketPricesPerKg).
    cropOptions: compactCropOptions(buildCropEconomics(snapshot)),
    genericCropWindow: cropWindow,
    knownCropCommitments: commitments,
    // pendingOperations is not repeated here: it is already in operationalRecord.pendingOperations.
    criticalObservationFreshness: criticalFreshness,
    missingCriticalObservations: snapshot.fields.fields.map((field) => ({
      fieldId: field.fieldId,
      missing: field.missing.filter((measurement) => CRITICAL_MEASUREMENTS.has(measurement)),
    })).filter((field) => field.missing.length > 0),
    relevantRecentEvents: relevantEvents.map(({ eventId, simTimeS, kind, actionId, summary }) => ({ eventId, simTimeS, kind, actionId, summary })),
  };
}

export interface AdaptiveReviewWindow {
  requestedMaxDays: number;
  requestedCheckpointDays: number;
  effectiveMaxDays: number;
  effectiveCheckpointDays: number;
  reasons: string[];
}

/** Bound a model-chosen wait using only the known horizon, session actions, observed freshness and reported events. */
export function adaptReviewWindow(
  state: SessionState,
  snapshot: Snapshot,
  events: GameEvent[],
  requestedMaxDays: number,
  requestedCheckpointDays?: number,
): AdaptiveReviewWindow {
  const requestedMax = Math.min(MAX_WAIT_DAYS, requestedMaxDays);
  const requestedCheckpoint = Math.min(10, Math.max(0.5, requestedCheckpointDays ?? DEFAULT_REVIEW_CHECKPOINT_DAYS));
  let effectiveMaxDays = requestedMax;
  let effectiveCheckpointDays = requestedCheckpoint;
  const reasons: string[] = [];

  const start = state.config.scenario.startSimTimeS;
  const horizonDays = state.config.planning.horizonDays;
  if (horizonDays !== null && start !== null) {
    const remaining = Math.max(0, (start + horizonDays * DAY_SECONDS - snapshot.simTimeS) / DAY_SECONDS);
    if (remaining < effectiveMaxDays) {
      effectiveMaxDays = remaining;
      reasons.push("clamped to configured experiment horizon");
    }
  }

  const plantedAges = buildProgress(state).fields.flatMap((field) => {
    const age = field.simDaysSincePlanting;
    return field.plantedCrop !== null && age !== null ? [age] : [];
  });
  const inGenericWindow = plantedAges.some((age) => age >= GENERIC_CROP_WINDOW_START_DAYS && age <= GENERIC_CROP_WINDOW_END_DAYS);
  const beyondGenericWindow = plantedAges.some((age) => age > GENERIC_CROP_WINDOW_END_DAYS);
  if (inGenericWindow || beyondGenericWindow) {
    effectiveMaxDays = Math.min(effectiveMaxDays, NEAR_WINDOW_MAX_WAIT_DAYS);
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, NEAR_WINDOW_CHECKPOINT_DAYS);
    reasons.push(`known planting is ${inGenericWindow ? "within" : "past"} the generic review window; estimate is not crop-specific and does not indicate maturity`);
  } else {
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, FAR_REVIEW_CHECKPOINT_DAYS);
  }

  const pendingCompletionDays = state.actions
    .filter((action) => !["completed", "failed", "cancelled", "rejected"].includes(action.status))
    .map((action) => action.estimatedCompletionS)
    .filter((completion): completion is number => completion !== null && completion > snapshot.simTimeS)
    .map((completion) => Math.max(MIN_OPERATION_REVIEW_DAYS, (completion - snapshot.simTimeS) / DAY_SECONDS))
    .sort((a, b) => a - b)[0];
  if (pendingCompletionDays !== undefined && pendingCompletionDays < effectiveMaxDays) {
    effectiveMaxDays = pendingCompletionDays;
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, pendingCompletionDays);
    reasons.push("bounded by a simulator-reported pending-operation completion estimate");
  }

  const staleCriticalMeasurement = snapshot.fields.fields.some((field) =>
    [...CRITICAL_MEASUREMENTS].some((measurement) => {
      const freshness = field.measurements[measurement]?.freshness;
      return freshness === "stale" || freshness === "expired";
    }),
  );
  if (staleCriticalMeasurement) {
    effectiveMaxDays = Math.min(effectiveMaxDays, UNCERTAIN_OBSERVATION_MAX_WAIT_DAYS);
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, NEAR_WINDOW_CHECKPOINT_DAYS);
    reasons.push("critical sensor evidence is stale; review sooner without treating stale values as current");
  }

  // A planted field with a critical quantity that was never observed is entirely unmonitored.
  const plantedIds = new Set(buildProgress(state).fields.filter((field) => field.plantedCrop !== null).map((field) => field.fieldId));
  const plantedUnmonitored = snapshot.fields.fields.some((field) =>
    plantedIds.has(field.fieldId) && [...CRITICAL_MEASUREMENTS].some((measurement) => !field.measurements[measurement]),
  );
  if (plantedUnmonitored) {
    effectiveMaxDays = Math.min(effectiveMaxDays, UNCERTAIN_OBSERVATION_MAX_WAIT_DAYS);
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, NEAR_WINDOW_CHECKPOINT_DAYS);
    reasons.push("a planted field has never had its critical quantities observed; review sooner (this does not require an inspection)");
  }

  const attentionLevels = snapshot.fields.fields.flatMap((field) => (plantedIds.has(field.fieldId) ? (field.attention ?? []).map((alert) => alert.level) : []));
  if (attentionLevels.length > 0) {
    const severe = Math.max(...attentionLevels) >= 2;
    effectiveMaxDays = Math.min(effectiveMaxDays, severe ? SEVERE_ATTENTION_MAX_WAIT_DAYS : ATTENTION_MAX_WAIT_DAYS);
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, severe ? SEVERE_ATTENTION_CHECKPOINT_DAYS : NEAR_WINDOW_CHECKPOINT_DAYS);
    reasons.push(`a planted field has an active level ${severe ? "2+" : "1"} environmental warning; review sooner without assuming its cause`);
  }

  if (events.some(isMaterialEvent)) {
    effectiveMaxDays = Math.min(effectiveMaxDays, RECENT_EVENT_MAX_WAIT_DAYS);
    effectiveCheckpointDays = Math.min(effectiveCheckpointDays, NEAR_WINDOW_CHECKPOINT_DAYS);
    reasons.push("recent material event warrants a shorter follow-up review");
  }

  return {
    requestedMaxDays: requestedMax,
    requestedCheckpointDays: requestedCheckpoint,
    effectiveMaxDays: Math.max(0, effectiveMaxDays),
    effectiveCheckpointDays: Math.max(0.5, Math.min(effectiveCheckpointDays, Math.max(0.5, effectiveMaxDays))),
    reasons: reasons.length ? reasons : ["no near-term operation, maturity review window, stale critical measurement or material event; retain bounded requested interval"],
  };
}
