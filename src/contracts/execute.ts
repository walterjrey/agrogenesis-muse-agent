import { z } from "zod";
import { GameId, ResourceEstimate, SimTimeS, TargetRef, ValidationIssue } from "./common.js";

export const ActionStatus = z.enum(["scheduled", "running", "completed", "failed", "cancelled", "rejected"]);
export type ActionStatus = z.infer<typeof ActionStatus>;

/** The server stamps origin "ai" and the actor id from the token; the agent cannot choose them. */
export const ExecuteActionRequest = z.strictObject({
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  /** Retried requests with the same key must not execute twice. */
  idempotencyKey: z.string().uuid(),
  /** Reject if the game changed since the agent observed it. */
  expectedRevision: z.number().int().positive().optional(),
  /** Validate and estimate only; commits nothing. */
  dryRun: z.boolean().default(false),
  startAfterS: z.number().nonnegative().optional(),
});
export type ExecuteActionRequest = z.input<typeof ExecuteActionRequest>;

const ActionOutcome = z.strictObject({ summary: z.string(), measurements: z.record(z.string(), z.number()) });

export const ActionRecordView = z.strictObject({
  actionId: z.string().min(1),
  type: z.string(),
  status: ActionStatus,
  target: TargetRef.nullable(),
  requestedAtS: SimTimeS,
  startAtS: SimTimeS,
  startedAtS: SimTimeS.nullable(),
  finishedAtS: SimTimeS.nullable(),
  estimatedCompletionS: SimTimeS.nullable(),
  progress: z.number().min(0).max(1).nullable(),
  reserved: ResourceEstimate,
  consumed: ResourceEstimate,
  outcome: ActionOutcome.nullable(),
  failure: ValidationIssue.nullable(),
});
export type ActionRecordView = z.infer<typeof ActionRecordView>;

export const ExecuteActionResponse = z.strictObject({
  gameId: GameId,
  revision: z.number().int().positive(),
  accepted: z.boolean(),
  dryRun: z.boolean(),
  /** Null when a request is rejected before an action record exists, or when dryRun is true. */
  action: ActionRecordView.nullable(),
  errors: z.array(ValidationIssue),
  /** Actions finish asynchronously on the simulation clock; poll or advance to observe completion. */
  asynchronous: z.boolean(),
}).refine((r) => (r.accepted ? r.errors.length === 0 : r.errors.length > 0), {
  message: "accepted responses must have no errors; rejected responses must explain why",
});
export type ExecuteActionResponse = z.infer<typeof ExecuteActionResponse>;

export const ActionStatusResponse = z.strictObject({ gameId: GameId, action: ActionRecordView });
export type ActionStatusResponse = z.infer<typeof ActionStatusResponse>;
