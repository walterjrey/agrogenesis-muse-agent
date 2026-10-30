import { z } from "zod";
import { Fraction, GameId, Id, SimTimeS } from "./common.js";

export const Freshness = z.enum(["fresh", "stale", "expired", "never_observed"]);
export type Freshness = z.infer<typeof Freshness>;

/** A single quantity as legitimately observed through a sensor; never the simulation's true value. */
export const Measurement = z.strictObject({
  value: z.number(),
  unit: z.string(),
  /** One standard deviation of observation noise, when the sensor reports it. */
  uncertainty: z.number().nonnegative().nullable(),
  observedAtSimTimeS: SimTimeS,
  ageS: z.number().nonnegative(),
  freshness: Freshness,
  confidence: Fraction,
  sensorType: z.string(),
  /** Share of the field this measurement covers. */
  coverage: Fraction,
});
export type Measurement = z.infer<typeof Measurement>;

const KnownLabel = z.strictObject({
  value: z.string(),
  observedAtSimTimeS: SimTimeS,
  ageS: z.number().nonnegative(),
  freshness: Freshness,
  confidence: Fraction,
});

/** Redacted warning that a field has an active environmental alert. Carries no measurement or threshold. */
export const FieldAttention = z.strictObject({
  alertId: z.string(),
  category: z.string(),
  level: z.number().int().min(1).max(3),
  sinceSimTimeS: SimTimeS,
  status: z.literal("active"),
});
export type FieldAttention = z.infer<typeof FieldAttention>;

export const FieldObservation = z.strictObject({
  fieldId: Id,
  label: z.string(),
  areaHa: z.number().positive(),
  knownCrop: KnownLabel.nullable(),
  knownGrowthStage: KnownLabel.nullable(),
  /** Keyed by quantity name, e.g. soilMoisture, soilFertility, pestPressure. Absent keys are listed in `missing`. */
  measurements: z.record(z.string(), Measurement),
  lastObservedAtSimTimeS: SimTimeS.nullable(),
  /** Quantities the agent has no usable observation for; the agent must not assume values for them. */
  missing: z.array(z.string()),
  activeOperationActionId: z.string().nullable(),
  /** Absent on servers that predate redacted alerts. */
  attention: z.array(FieldAttention).optional(),
});
export type FieldObservation = z.infer<typeof FieldObservation>;

export const FieldObservations = z.strictObject({
  gameId: GameId,
  revision: z.number().int().positive(),
  simTimeS: SimTimeS,
  fields: z.array(FieldObservation),
});
export type FieldObservations = z.infer<typeof FieldObservations>;
