import { z } from "zod";

/**
 * Session-wide budgets. They are cumulative across cycles and across resumes and are never raised automatically:
 * a session that exhausts one stops, and resuming it does not reset the counters.
 */
export const SessionLimits = z.strictObject({
  maxCostUsd: z.number().positive(),
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  /** Accepted state-changing farm actions. */
  maxMutations: z.number().int().nonnegative(),
  /** Simulated seconds the agent may advance in total. */
  maxSimSeconds: z.number().nonnegative(),
  /** Active wall-clock milliseconds, accumulated over all controller runs. */
  maxWallClockMs: z.number().positive(),
  maxCycles: z.number().int().positive(),
  maxConsecutiveErrors: z.number().int().positive(),
  maxConsecutiveNoProgress: z.number().int().positive(),
  maxConsecutiveRejections: z.number().int().positive(),
  maxModelCallsPerCycle: z.number().int().positive(),
  maxToolCallsPerCycle: z.number().int().positive(),
  maxAdvanceSecondsPerCall: z.number().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostPerRequestUsd: z.number().positive(),
  /** HTTP advance requests (agent-requested or supervised) in total. */
  maxAdvanceRequests: z.number().int().positive().default(60),
  /** Advance requests in a row without an accepted farm action in between. */
  maxConsecutiveAdvances: z.number().int().positive().default(12),
  /** HTTP 409 stale-revision conflicts tolerated in total. */
  maxConflicts: z.number().int().positive().default(5),
  /** Credits the farm may spend (growth of realizedCosts since the session baseline); checked between cycles and after each supervised wait. */
  maxFarmSpendCredits: z.number().nonnegative().default(1_000),
  /** Largest single advance a supervised wait requests (simulated seconds; one simulated day is 60 s). */
  maxWaitChunkSeconds: z.number().positive().default(600),
});
export type SessionLimits = z.infer<typeof SessionLimits>;

export const DEFAULT_SESSION_LIMITS: Readonly<SessionLimits> = {
  maxCostUsd: 1,
  maxModelCalls: 20,
  maxToolCalls: 60,
  maxMutations: 3,
  maxSimSeconds: 86_400,
  maxWallClockMs: 15 * 60_000,
  maxCycles: 8,
  maxConsecutiveErrors: 3,
  maxConsecutiveNoProgress: 3,
  maxConsecutiveRejections: 3,
  maxModelCallsPerCycle: 6,
  maxToolCallsPerCycle: 12,
  maxAdvanceSecondsPerCall: 3_600,
  maxOutputTokens: 2_048,
  maxCostPerRequestUsd: 0.1,
  maxAdvanceRequests: 60,
  maxConsecutiveAdvances: 12,
  maxConflicts: 5,
  maxFarmSpendCredits: 1_000,
  maxWaitChunkSeconds: 600,
};

export const Plan = z.strictObject({
  summary: z.string(),
  objective: z.string().nullable(),
  priorities: z.array(z.string()),
  constraints: z.array(z.string()),
  missingObservations: z.array(z.string()),
  pendingOperations: z.array(z.string()),
  nextReviewSimSeconds: z.number().nonnegative().nullable(),
  nextStep: z.enum(["continue", "wait_for_actions", "stop"]),
  stopReason: z.string().nullable(),
});
export type Plan = z.infer<typeof Plan>;

export const TrackedAction = z.strictObject({
  actionId: z.string(),
  type: z.string(),
  status: z.enum(["scheduled", "running", "completed", "failed", "cancelled", "rejected"]),
  submittedAtRevision: z.number().int(),
  idempotencyKey: z.string(),
  lastCheckedAt: z.string().nullable(),
  /** Facts reported by the simulator for this action (never inferred). */
  target: z.string().nullable().default(null),
  startedAtS: z.number().nullable().default(null),
  estimatedCompletionS: z.number().nullable().default(null),
  finishedAtS: z.number().nullable().default(null),
  progress: z.number().nullable().default(null),
  consumedCredits: z.number().nullable().default(null),
  outcome: z.string().nullable().default(null),
  failure: z.string().nullable().default(null),
  /** Primitive parameters the model requested (e.g. crop, volumeM3, kg); never authoritative simulation values. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  consumedWaterM3: z.number().nullable().default(null),
  consumedSeedKg: z.number().nullable().default(null),
  consumedFuelL: z.number().nullable().default(null),
  /** Measurements reported by the simulator when the action finished (e.g. kg sold, revenue); never inferred. */
  measurements: z.record(z.string(), z.number()).default({}),
});
export type TrackedAction = z.infer<typeof TrackedAction>;

/** One supervised wait on an already-authorized operation; every value comes from simulator responses. */
export const WaitRecord = z.strictObject({
  cycle: z.number().int(),
  actionId: z.string(),
  trigger: z.enum(["model_tool", "controller"]),
  outcome: z.string(),
  actionStatus: z.string().nullable(),
  advanceRequests: z.number().int(),
  advancedSeconds: z.number(),
  simTimeStartS: z.number().nullable(),
  simTimeEndS: z.number().nullable(),
  events: z.array(z.string()),
  detail: z.string().nullable(),
});
export type WaitRecord = z.infer<typeof WaitRecord>;

/** Operational bookkeeping derived from simulator data. It contains no plan and no model reasoning. */
export const ProgressRecord = z.strictObject({
  objective: z.string(),
  simTimeS: z.number().nullable(),
  fields: z.array(
    z.strictObject({
      fieldId: z.string(),
      knownCrop: z.string().nullable(),
      knownGrowthStage: z.string().nullable(),
      activeOperation: z.string().nullable(),
      lastActionType: z.string().nullable(),
      /** From this session's own completed plantField action (never from a sensor). */
      plantedCrop: z.string().nullable().default(null),
      plantedAtSimTimeS: z.number().nullable().default(null),
      simDaysSincePlanting: z.number().nullable().default(null),
      lastHarvestAtSimTimeS: z.number().nullable().default(null),
      lastInspectionAtSimTimeS: z.number().nullable().default(null),
    }),
  ),
  pendingOperations: z.array(z.strictObject({ actionId: z.string(), type: z.string(), target: z.string().nullable(), status: z.string(), progress: z.number().nullable(), estimatedCompletionS: z.number().nullable() })),
  completedOperations: z.array(z.strictObject({ actionId: z.string(), type: z.string(), target: z.string().nullable(), status: z.string(), finishedAtS: z.number().nullable(), outcome: z.string().nullable(), failure: z.string().nullable() })),
  blockers: z.array(z.string()),
  nextRequiredDecision: z.string(),
  expenses: z.strictObject({ realizedCostsDelta: z.number().nullable(), creditsDelta: z.number().nullable(), actionConsumedCredits: z.number() }),
});
export type ProgressRecord = z.infer<typeof ProgressRecord>;

export const PendingMutation = z.strictObject({
  tool: z.enum(["execute_action", "advance_time"]),
  idempotencyKey: z.string(),
  expectedRevision: z.number().int(),
  /** The exact request body (it contains the idempotency key, never a credential). */
  request: z.record(z.string(), z.unknown()),
  rationale: z.string().nullable(),
  recordedAt: z.string(),
  cycle: z.number().int(),
});
export type PendingMutation = z.infer<typeof PendingMutation>;

export const CompletedOperation = z.strictObject({
  tool: z.enum(["execute_action", "advance_time"]),
  idempotencyKey: z.string(),
  status: z.enum(["applied", "rejected", "not_applied"]),
  expectedRevision: z.number().int(),
  revisionAfter: z.number().int().nullable(),
  summary: z.record(z.string(), z.unknown()),
  cycle: z.number().int(),
  settledAt: z.string(),
  /** "reconciled" when settled by replaying the same key after an unknown outcome. */
  via: z.enum(["direct", "reconciled"]),
});
export type CompletedOperation = z.infer<typeof CompletedOperation>;

export const DecisionSummary = z.strictObject({
  cycle: z.number().int(),
  at: z.string(),
  simTimeS: z.number().nullable(),
  revision: z.number().int().nullable(),
  /** The model's own explicit summary (update_plan.summary, or its final text). Never hidden reasoning. */
  summary: z.string(),
  plannedStep: z.string().nullable(),
  tools: z.record(z.string(), z.number()),
  actionsSubmitted: z.number().int(),
  actionsAccepted: z.number().int(),
  advancedSeconds: z.number(),
  progress: z.boolean(),
  progressReasons: z.array(z.string()),
  costUsd: z.number(),
  stopReason: z.string(),
});
export type DecisionSummary = z.infer<typeof DecisionSummary>;

export const ObservationSummary = z.strictObject({
  revision: z.number().int(),
  simTimeS: z.number(),
  credits: z.number().nullable(),
  realizedRevenue: z.number().nullable(),
  realizedCosts: z.number().nullable(),
  /** Configured per-kg market quotes published by the simulator; null when the simulator does not publish them. */
  marketPricesPerKg: z.record(z.string(), z.number()).nullable().default(null),
  priceConfigVersion: z.number().int().nullable().default(null),
  resources: z.array(z.strictObject({ id: z.string(), kind: z.string(), quantity: z.number(), unit: z.string() })),
  activeActions: z.number().int(),
  fields: z.array(z.strictObject({ fieldId: z.string(), knownCrop: z.string().nullable(), knownGrowthStage: z.string().nullable(), missingCount: z.number().int() })),
});
export type ObservationSummary = z.infer<typeof ObservationSummary>;

/**
 * Observed economic change between two consecutive authorized observations in which this session's own harvest/sale
 * actions finished. Deltas are pooled over the listed actions (stock is not tracked per harvest).
 */
export const LedgerEntry = z.strictObject({
  fromSimTimeS: z.number(),
  toSimTimeS: z.number(),
  harvestActionIds: z.array(z.string()),
  sellActionIds: z.array(z.string()),
  grainDeltaKg: z.record(z.string(), z.number()),
  creditsDelta: z.number().nullable(),
  revenueDelta: z.number().nullable(),
  costsDelta: z.number().nullable(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Starting-condition identity. The DB hashes are supplied by the operator; the observation hash is computed by the agent from its first authorized observation. */
export const ScenarioManifest = z.strictObject({
  name: z.string().nullable(),
  seed: z.number().nullable(),
  startSnapshotSha256: z.string().nullable(),
  worldConfigSha256: z.string().nullable(),
  startObservationSha256: z.string().nullable(),
  startRevision: z.number().int().nullable(),
  startSimTimeS: z.number().nullable(),
  notes: z.array(z.string()),
});
export type ScenarioManifest = z.infer<typeof ScenarioManifest>;

export const SessionStatus = z.enum(["running", "paused", "stopped", "completed", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionState = z.strictObject({
  version: z.literal(1),
  sessionId: z.string(),
  gameId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: SessionStatus,
  stopReason: z.string().nullable(),
  stopDetail: z.string().nullable(),
  config: z.strictObject({
    modelId: z.string(),
    mutationsEnabled: z.boolean(),
    objective: z.string(),
    limits: SessionLimits,
    /** After a model turn, wait mechanically (no model calls) for operations still in flight. */
    autoWait: z.boolean().default(true),
    /** Identity of the starting conditions, so a run can be reproduced and audited. */
    scenario: ScenarioManifest.default({ name: null, seed: null, startSnapshotSha256: null, worldConfigSha256: null, startObservationSha256: null, startRevision: null, startSimTimeS: null, notes: [] }),
  }),
  cycle: z.number().int(),
  plan: Plan.nullable(),
  decisions: z.array(DecisionSummary),
  actions: z.array(TrackedAction),
  operations: z.array(CompletedOperation),
  pendingMutation: PendingMutation.nullable(),
  waits: z.array(WaitRecord).default([]),
  progress: ProgressRecord.nullable().default(null),
  lastRevision: z.number().int().nullable(),
  lastSimTimeS: z.number().nullable(),
  /** Event cursor the model's tools use. */
  modelEventCursor: z.number().int(),
  /** Event cursor of the controller's own progress reads. */
  progressCursor: z.number().int(),
  budgets: z.strictObject({
    costUsd: z.number(),
    modelCalls: z.number().int(),
    toolCalls: z.number().int(),
    acceptedMutations: z.number().int(),
    mutationAttempts: z.number().int(),
    rejectedActions: z.number().int(),
    advancedSimSeconds: z.number(),
    wallClockMs: z.number(),
    consecutiveErrors: z.number().int(),
    consecutiveNoProgress: z.number().int(),
    consecutiveRejections: z.number().int(),
    advanceRequests: z.number().int().default(0),
    consecutiveAdvances: z.number().int().default(0),
    conflicts: z.number().int().default(0),
  }),
  usage: z.strictObject({ inputTokens: z.number().int(), outputTokens: z.number().int(), cachedTokens: z.number().int() }),
  metrics: z.strictObject({
    baseline: ObservationSummary.nullable(),
    latest: ObservationSummary.nullable(),
    controllerReads: z.number().int(),
    snapshotRefreshes: z.number().int(),
    snapshotCacheHits: z.number().int(),
    mixedRevisionDetections: z.number().int(),
    /** Largest stock of each grain product seen in any authorized observation (kg). */
    grainPeakKg: z.record(z.string(), z.number()).default({}),
    ledger: z.array(LedgerEntry).default([]),
  }),
});
export type SessionState = z.infer<typeof SessionState>;

export const TERMINAL_ACTION_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "rejected"]);
