import { z } from "zod";

/** Payload schemas are strict: any field the contract does not name (e.g. leaked ground truth) fails parsing. */
export const Id = z.string().min(1).max(64);
export const GameId = z.string().uuid();
export const SimTimeS = z.number().finite().nonnegative();
export const Fraction = z.number().min(0).max(1);

export const ValidationIssue = z.strictObject({
  code: z.string().min(1),
  detail: z.string(),
  resource: z.strictObject({ kind: z.string(), id: z.string() }).optional(),
  holderActionId: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ResourceEstimate = z.strictObject({
  credits: z.number(),
  waterM3: z.number(),
  feedKg: z.number(),
  energyWh: z.number(),
  fuelL: z.number(),
  seedKg: z.number(),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimate>;

export const TargetRef = z.strictObject({ kind: z.string(), id: z.string(), label: z.string() });
export type TargetRef = z.infer<typeof TargetRef>;

export const SimulationClock = z.strictObject({
  simTimeS: SimTimeS,
  simDay: z.number().int().nonnegative(),
  tickCount: z.number().int().nonnegative(),
  paused: z.boolean(),
});
export type SimulationClock = z.infer<typeof SimulationClock>;

export const ApiErrorBody = z.object({
  error: z.string(),
  code: z.string().optional(),
  currentRevision: z.number().int().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
