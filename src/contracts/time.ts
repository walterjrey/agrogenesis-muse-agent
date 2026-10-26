import { z } from "zod";
import { GameId, SimulationClock } from "./common.js";

export const GameEvent = z.strictObject({
  /** Monotonic per game; use as the `cursor` for the next poll. */
  eventId: z.number().int().nonnegative(),
  simTimeS: z.number().nonnegative(),
  kind: z.enum([
    "action_started",
    "action_completed",
    "action_failed",
    "action_cancelled",
    "observation_delivered",
    "weather_alert",
    "equipment_status_changed",
    "mode_changed",
  ]),
  actionId: z.string().nullable(),
  summary: z.string(),
  /** Only agent-visible facts. */
  data: z.record(z.string(), z.unknown()),
});
export type GameEvent = z.infer<typeof GameEvent>;

export const EventsResponse = z.strictObject({
  gameId: GameId,
  clock: SimulationClock,
  events: z.array(GameEvent),
  nextCursor: z.number().int().nonnegative(),
});
export type EventsResponse = z.infer<typeof EventsResponse>;

/**
 * The agent may only *request* time progression; the simulator owns the clock and decides how much
 * (if any) to grant, bounded by its own per-call and per-day limits.
 */
export const AdvanceRequest = z.strictObject({
  requestedSeconds: z.number().positive().max(7 * 86_400),
  stopOn: z.array(z.enum(["action_completion", "new_observation", "any_event"])).default(["any_event"]),
  cursor: z.number().int().nonnegative().default(0),
  idempotencyKey: z.string().uuid(),
});
export type AdvanceRequest = z.input<typeof AdvanceRequest>;

export const AdvanceResponse = z.strictObject({
  gameId: GameId,
  clockBefore: SimulationClock,
  clockAfter: SimulationClock,
  requestedSeconds: z.number().positive(),
  grantedSeconds: z.number().nonnegative(),
  stoppedBecause: z.enum(["requested_time_reached", "granted_limit_reached", "action_completion", "new_observation", "event"]),
  events: z.array(GameEvent),
  nextCursor: z.number().int().nonnegative(),
});
export type AdvanceResponse = z.infer<typeof AdvanceResponse>;
