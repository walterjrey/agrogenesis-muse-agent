import { z } from "zod";
import type { GameEvent } from "../contracts/time.js";
import { isInspectionActionType } from "./actionClassification.js";
import type { FieldObservations } from "../contracts/fieldObservations.js";

/**
 * Daily farm-management scheduler (continuous sessions).
 *
 * The deterministic simulator owns simulated time; the model only owns decisions. Muse gets ONE primary strategic review
 * per simulated day plus a small, configurable number of event-driven reviews when something important happened.
 * Everything else (routine ticks, in-flight operations, informational events) advances without a model call.
 * This module is pure policy over persisted state: no I/O, no model calls, no simulator access.
 */

export const SchedulerConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** Simulated seconds in one calendar day (the simulator's calendar; never changed by this module). */
  daySeconds: z.number().positive().default(60),
  /** Extra reviews allowed per simulated day after the primary one. */
  eventReviewsPerDay: z.number().int().nonnegative().default(3),
  /** Bounds for a single review (replace the generic per-cycle limits while the scheduler is on). */
  maxModelCallsPerReview: z.number().int().positive().default(4),
  maxToolCallsPerReview: z.number().int().positive().default(10),
  /** A model-planned next review (update_plan.nextReviewSimSeconds) is honoured for at most this many days; 0 disables skipping. */
  maxPlannedSkipDays: z.number().int().nonnegative().default(3),
  /** An identical inspection is refused for this long (in simulated days) unless new evidence arrived. */
  inspectionCooldownDays: z.number().nonnegative().default(1),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = SchedulerConfig.parse({});

export const ReviewKind = z.enum(["daily_review", "event_review", "review_skipped", "blocked"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

export const Trigger = z.strictObject({
  key: z.string(),
  kind: z.string(),
  critical: z.boolean(),
  field: z.string().nullable().default(null),
  simTimeS: z.number(),
  summary: z.string().max(200),
});
export type Trigger = z.infer<typeof Trigger>;

const Counters = z.strictObject({
  dailyReviews: z.number().int().default(0),
  eventReviews: z.number().int().default(0),
  skippedReviews: z.number().int().default(0),
  duplicateInspectionsAvoided: z.number().int().default(0),
  eventBudgetExhausted: z.number().int().default(0),
  triggersCarried: z.number().int().default(0),
});

export const SchedulerState = z.strictObject({
  initialized: z.boolean().default(false),
  /** Calendar day of the last gate decision, and what has been done on it. */
  day: z.number().int().default(-1),
  dailyDone: z.boolean().default(false),
  lastSkipDay: z.number().int().default(-1),
  /** End of the last announced "no review needed" period, so a slice restart inside it does not log it again. */
  skipUntilS: z.number().default(0),
  eventReviewsToday: z.number().int().default(0),
  pending: z.array(Trigger).default([]),
  /** Critical triggers that arrived with no review budget left; surfaced to the next review and never dropped silently. */
  unresolvedCritical: z.array(Trigger).default([]),
  /** The controller's own event cursor, independent of the model's. */
  eventCursor: z.number().int().default(0),
  nextReviewSimS: z.number().nullable().default(null),
  status: z.enum(["idle", "reviewing", "waiting", "blocked"]).default("idle"),
  lastReview: z.strictObject({ kind: ReviewKind, day: z.number().int(), simTimeS: z.number(), triggers: z.array(z.string()) }).nullable().default(null),
  /** Context for the review in progress (what the brief shows the model). */
  current: z.strictObject({ kind: ReviewKind, day: z.number().int(), triggers: z.array(Trigger), carried: z.array(Trigger), eventReviewsLeft: z.number().int() }).nullable().default(null),
  /** Last authorized measurement per field/quantity, used to decide whether a delivered observation is new information. */
  digest: z.record(z.string(), z.record(z.string(), z.strictObject({ v: z.number(), at: z.number() }))).default({}),
  /** Last calendar day a harvest_ready trigger was raised per field, so an eligible harvest is re-raised daily until done, never in a spin. */
  harvestNotified: z.record(z.string(), z.number().int()).default({}),
  /** Bumped whenever the farm gives a reason to look again (new alert, completed operation, new observation). */
  evidenceSeq: z.number().int().default(0),
  inspections: z.record(z.string(), z.strictObject({ simTimeS: z.number(), evidenceSeq: z.number().int() })).default({}),
  counters: Counters.default({ dailyReviews: 0, eventReviews: 0, skippedReviews: 0, duplicateInspectionsAvoided: 0, eventBudgetExhausted: 0, triggersCarried: 0 }),
});
export type SchedulerState = z.infer<typeof SchedulerState>;
export const newSchedulerState = (): SchedulerState => SchedulerState.parse({});

export const dayOf = (simTimeS: number, cfg: SchedulerConfig): number => Math.floor(simTimeS / cfg.daySeconds + 1e-9);
export const nextDayBoundary = (simTimeS: number, cfg: SchedulerConfig): number => (dayOf(simTimeS, cfg) + 1) * cfg.daySeconds;

const MAX_PENDING = 24;

/** Completions that need no new farming decision on their own (the risk ledger schedules treatment follow-ups). */
const QUIET_COMPLETIONS: ReadonlySet<string> = new Set(["irrigateField", "applyTreatment", "returnToBase", "rechargeRobot", "allocateWater", "purchaseFeed", "moveLivestock"]);

export interface EventClassificationContext {
  /** Looks up the type of an action this session started. */
  actionType(actionId: string): string | null;
}

/** An event is a candidate for new observation information (judged for novelty by the caller). */
export function isObservationEvent(event: GameEvent, ctx: EventClassificationContext): boolean {
  if (event.kind === "observation_delivered") return true;
  return event.kind === "action_completed" && event.actionId !== null && isInspectionActionType(ctx.actionType(event.actionId));
}

/**
 * Maps a simulator event to a review trigger. Informational events (routine starts, level-1 warnings, quiet
 * completions) return null: they stay in the event feed the model reads but never wake it.
 * Observation events are handled separately because they only matter when they carry new information.
 */
export function classifyTrigger(event: GameEvent, ctx: EventClassificationContext): Trigger | null {
  const base = { simTimeS: event.simTimeS, summary: event.summary.slice(0, 200) };
  const field = typeof event.data.fieldId === "string" ? event.data.fieldId : null;
  switch (event.kind) {
    case "action_failed":
      return { key: `failed:${event.actionId ?? event.eventId}`, kind: "operation_failed", critical: true, field, ...base };
    case "weather_alert":
      return { key: `weather:${event.eventId}`, kind: "critical_weather", critical: true, field, ...base };
    case "field_attention": {
      const level = typeof event.data.level === "number" ? event.data.level : 2;
      if (event.data.status === "resolved" || level < 2) return null;
      return { key: `attention:${field ?? event.eventId}:${level}`, kind: "field_threshold_crossed", critical: true, field, ...base };
    }
    case "crop_ready":
      return { key: `ready:${field ?? event.eventId}`, kind: "crop_ready", critical: false, field, ...base };
    case "mode_changed":
    case "equipment_status_changed":
    case "action_cancelled":
      return { key: `${event.kind}:${event.eventId}`, kind: event.kind, critical: false, field, ...base };
    case "action_completed": {
      const type = event.actionId ? ctx.actionType(event.actionId) : null;
      if (isInspectionActionType(type) || (type !== null && QUIET_COMPLETIONS.has(type))) return null;
      return { key: `completed:${event.actionId ?? event.eventId}`, kind: "operation_completed", critical: false, field, ...base };
    }
    case "action_started":
    case "observation_delivered":
      return null;
  }
}

export function addTrigger(sch: SchedulerState, trigger: Trigger): boolean {
  if (sch.pending.some((t) => t.key === trigger.key) || sch.unresolvedCritical.some((t) => t.key === trigger.key)) return false;
  sch.pending.push(trigger);
  if (sch.pending.length > MAX_PENDING) sch.pending.splice(0, sch.pending.length - MAX_PENDING);
  sch.evidenceSeq += 1;
  return true;
}

const different = (a: number, b: number): boolean => Math.abs(a - b) >= Math.max(0.05, 0.05 * Math.abs(a));

/**
 * Compares authorized measurements with the last digest and returns the fields whose information is new: a quantity that
 * was unknown, or one re-measured later with a meaningfully different value. Always refreshes the digest so the same
 * reading can never justify two reviews. Only authorized observation data is read; nothing hidden is exposed.
 */
export function absorbObservations(sch: SchedulerState, fields: FieldObservations): string[] {
  const changed: string[] = [];
  for (const field of fields.fields) {
    const known = (sch.digest[field.fieldId] ??= {});
    let novel = false;
    for (const [name, m] of Object.entries(field.measurements)) {
      const prev = known[name];
      if (prev && m.observedAtSimTimeS <= prev.at) continue;
      if (!prev || different(prev.v, m.value)) novel = true;
      known[name] = { v: m.value, at: m.observedAtSimTimeS };
    }
    if (novel) changed.push(field.fieldId);
  }
  return changed;
}

export const inspectionKey = (type: string, params: Record<string, unknown>): string =>
  `${type}:${JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))}`;

export type GateDecision =
  | { kind: "review"; review: "daily_review" | "event_review"; triggers: Trigger[]; carried: Trigger[] }
  | { kind: "skip"; reason: string; waitUntilSimS: number }
  | { kind: "wait"; waitUntilSimS: number; blocked: Trigger[] };

export interface GateInput {
  simTimeS: number;
  /** update_plan.nextReviewSimSeconds from the last review, if any. */
  plannedReviewSimS: number | null;
  /** A review would be redundant while an in-flight operation is the only thing happening and nothing new arrived. */
  hasPendingTriggers?: boolean;
}

/** Moves the scheduler to the simulated calendar day of `simTimeS`: counters reset, noncritical triggers stay pending (carried). */
export function rollDay(sch: SchedulerState, cfg: SchedulerConfig, simTimeS: number): void {
  const day = dayOf(simTimeS, cfg);
  if (day === sch.day) return;
  sch.day = day;
  sch.dailyDone = false;
  sch.eventReviewsToday = 0;
  sch.counters.triggersCarried += sch.pending.filter((t) => !t.critical).length;
}

/**
 * The review gate. Called once per controller iteration, before any model request. Every outcome either runs exactly
 * one bounded review or moves simulated time forward to a strictly later instant (the next day boundary at the latest),
 * so the loop cannot stall or spin.
 */
export function decide(sch: SchedulerState, cfg: SchedulerConfig, input: GateInput): GateDecision {
  rollDay(sch, cfg, input.simTimeS);
  const boundary = nextDayBoundary(input.simTimeS, cfg);

  if (!sch.dailyDone) {
    const planned = input.plannedReviewSimS;
    const noNews = sch.pending.length === 0 && sch.unresolvedCritical.length === 0;
    if (noNews && cfg.maxPlannedSkipDays > 0 && planned !== null && planned >= boundary) {
      // The model asked to wait. Honour it, but never go longer than maxPlannedSkipDays since the last review.
      const lastAt = sch.lastReview?.simTimeS ?? input.simTimeS;
      const until = Math.min(planned, lastAt + cfg.maxPlannedSkipDays * cfg.daySeconds);
      const target = Math.floor(until / cfg.daySeconds + 1e-9) * cfg.daySeconds;
      if (target >= boundary) return { kind: "skip", reason: "Wait until the next review: the plan expects nothing to need a decision before then.", waitUntilSimS: target };
    }
    return takeReview(sch, cfg, "daily_review");
  }

  const eventBudgetLeft = cfg.eventReviewsPerDay - sch.eventReviewsToday;
  if (sch.pending.length > 0 && eventBudgetLeft > 0) return takeReview(sch, cfg, "event_review");
  const blocked: Trigger[] = [];
  if (sch.pending.length > 0) {
    // Budget exhausted: noncritical triggers are carried to the next daily review; critical ones are surfaced explicitly.
    for (const t of sch.pending.filter((p) => p.critical)) {
      if (!sch.unresolvedCritical.some((u) => u.key === t.key)) {
        sch.unresolvedCritical.push(t);
        blocked.push(t);
      }
    }
    sch.pending = sch.pending.filter((p) => !p.critical);
    if (blocked.length > 0) sch.counters.eventBudgetExhausted += 1;
  }
  return { kind: "wait", waitUntilSimS: boundary, blocked };
}

function takeReview(sch: SchedulerState, cfg: SchedulerConfig, review: "daily_review" | "event_review"): GateDecision {
  const triggers = [...sch.unresolvedCritical, ...sch.pending];
  const dayStart = sch.day * cfg.daySeconds;
  // Noncritical triggers that arrived on an earlier day were carried into this review.
  const carried = review === "daily_review" ? sch.pending.filter((t) => !t.critical && t.simTimeS < dayStart) : [];
  return { kind: "review", review, triggers, carried };
}

/** Marks a review as started: consumes the pending triggers it addresses and counts it against the day's budget. */
export function beginReview(sch: SchedulerState, decision: Extract<GateDecision, { kind: "review" }>, simTimeS: number, cfg: SchedulerConfig): void {
  const eventBudgetLeft = cfg.eventReviewsPerDay - sch.eventReviewsToday - (decision.review === "event_review" ? 1 : 0);
  sch.current = { kind: decision.review, day: sch.day, triggers: decision.triggers, carried: decision.carried, eventReviewsLeft: Math.max(0, eventBudgetLeft) };
  sch.lastReview = { kind: decision.review, day: sch.day, simTimeS, triggers: decision.triggers.map((t) => t.kind) };
  if (decision.review === "daily_review") {
    sch.dailyDone = true;
    sch.counters.dailyReviews += 1;
  } else {
    sch.eventReviewsToday += 1;
    sch.counters.eventReviews += 1;
  }
  sch.pending = [];
  sch.unresolvedCritical = [];
  sch.status = "reviewing";
}

export function endReview(sch: SchedulerState, nextReviewSimS: number): void {
  sch.current = null;
  sch.nextReviewSimS = nextReviewSimS;
  sch.status = "waiting";
}

/** Rejects an inspection that repeats a recent identical one without any new evidence. Returns the reason, or null to allow it. */
export function duplicateInspection(sch: SchedulerState, cfg: SchedulerConfig, key: string, simTimeS: number, inFlight: boolean): string | null {
  if (inFlight) return "An identical inspection is already in progress; wait for its observation instead of repeating it.";
  const last = sch.inspections[key];
  if (!last) return null;
  if (sch.evidenceSeq !== last.evidenceSeq) return null;
  if (simTimeS - last.simTimeS >= cfg.inspectionCooldownDays * cfg.daySeconds) return null;
  return "The same inspection was done recently and nothing new has been observed since (no new alert, completed operation or observation). Act on what you already have, choose a different information source, or wait for the next review.";
}

export function recordInspection(sch: SchedulerState, key: string, simTimeS: number): void {
  sch.inspections[key] = { simTimeS, evidenceSeq: sch.evidenceSeq };
  const keys = Object.keys(sch.inspections);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete sch.inspections[k];
}
