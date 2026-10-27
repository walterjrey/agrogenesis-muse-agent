import { z } from "zod";
import { Fraction, GameId, Id, SimulationClock, SimTimeS } from "./common.js";

/** Games the agent token is authorized for. Never includes snapshots. */
export const AuthorizedGames = z.strictObject({
  games: z.array(z.strictObject({
    gameId: GameId,
    name: z.string(),
    managementMode: z.enum(["manual", "muse_ai", "hybrid"]),
    lifecycle: z.enum(["created", "running", "paused", "saved", "failed"]),
    scopes: z.array(z.enum(["observe", "act", "advance"])),
  })),
});
export type AuthorizedGames = z.infer<typeof AuthorizedGames>;

const WeatherObservation = z.strictObject({
  observedAtSimTimeS: SimTimeS.nullable(),
  ageS: z.number().nonnegative().nullable(),
  temperatureC: z.number().nullable(),
  precipitationMmPerDay: z.number().nullable(),
  windSpeedMs: z.number().nullable(),
  source: z.string().nullable(),
  confidence: Fraction.nullable(),
});

const ResourceLevel = z.strictObject({
  kind: z.string(),
  id: Id,
  label: z.string(),
  quantity: z.number(),
  unit: z.string(),
});

const EquipmentItem = z.strictObject({
  id: Id,
  kind: z.string(),
  label: z.string(),
  status: z.enum(["idle", "busy", "charging", "under_repair", "unavailable", "unknown"]),
  batteryFraction: Fraction.nullable(),
  currentActionId: z.string().nullable(),
});

const Finance = z.discriminatedUnion("authorized", [
  z.strictObject({ authorized: z.literal(false) }),
  z.strictObject({
    authorized: z.literal(true),
    credits: z.number(),
    realizedRevenue: z.number(),
    realizedCosts: z.number(),
    // Optional: older simulators do not publish the configured market.
    marketPricesPerKg: z.record(z.string(), z.number().nonnegative()).optional(),
    priceConfigVersion: z.number().int().optional(),
  }),
]);

export const FarmOverview = z.strictObject({
  gameId: GameId,
  revision: z.number().int().positive(),
  clock: SimulationClock,
  weather: WeatherObservation,
  resources: z.array(ResourceLevel),
  equipment: z.array(EquipmentItem),
  status: z.strictObject({
    fieldCount: z.number().int().nonnegative(),
    pastureCount: z.number().int().nonnegative(),
    activeActionCount: z.number().int().nonnegative(),
    summary: z.string(),
  }),
  finance: Finance,
});
export type FarmOverview = z.infer<typeof FarmOverview>;
