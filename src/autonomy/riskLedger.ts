import { z } from "zod";
import type { FieldObservations } from "../contracts/fieldObservations.js";

const DAY_S = 60;
/** A Level-1 warning must persist this long before it can wake the model on its own. */
export const PERSISTENT_ALERT_DAYS = 3;
/** Routine (non-severe) notifications are limited to one per simulated day per field. */
export const NOTIFY_MIN_INTERVAL_DAYS = 1;
/** A completed treatment is followed up this long afterwards; a missing observation is escalated at the upper bound. */
export const FOLLOW_UP_DAYS = 1;
export const FOLLOW_UP_MAX_DAYS = 2;
const STALE_FOLLOW_UP_DAYS = 10;
/** Observed drop/rise between two consecutive authorized observations that counts as substantial worsening. */
export const WORSENING_DELTA = 0.1;

const Reading = z.strictObject({ v: z.number(), atS: z.number(), sensor: z.string() });
export type Reading = z.infer<typeof Reading>;

/**
 * Persistent, per-field operational bookkeeping. It stores only (a) the redacted alert status the simulator already
 * publishes, (b) this session's own completed treatments and (c) measurements that were obtained through an authorized
 * observation, each with its observation time. Nothing here is current ground truth.
 */
export const FieldRisk = z.strictObject({
  alertCategory: z.string().nullable().default(null),
  alertLevel: z.number().int().nullable().default(null),
  alertSinceS: z.number().nullable().default(null),
  lastNotifiedDay: z.number().int().nullable().default(null),
  treatments: z.number().int().nonnegative().default(0),
  lastTreatmentAtS: z.number().nullable().default(null),
  followUpPending: z.boolean().default(false),
  lastObservedAtS: z.number().nullable().default(null),
  lastObservedBy: z.string().nullable().default(null),
  pest: Reading.nullable().default(null),
  prevPest: Reading.nullable().default(null),
  health: Reading.nullable().default(null),
  prevHealth: Reading.nullable().default(null),
  worseningFlaggedAtS: z.number().nullable().default(null),
});
export type FieldRisk = z.infer<typeof FieldRisk>;
export const RiskLedger = z.record(z.string(), FieldRisk);
export type RiskLedger = z.infer<typeof RiskLedger>;

export interface LedgerInput {
  riskLedger: RiskLedger;
  actions: ReadonlyArray<{ type: string; status: string; target: string | null; finishedAtS: number | null }>;
}

export type ReviewReason = "persistent_alert" | "treatment_follow_up" | "worsening_observed";
export interface DueReview { fieldId: string; reason: ReviewReason }

const emptyRisk = (): FieldRisk => FieldRisk.parse({});
const day = (simTimeS: number): number => Math.floor(simTimeS / DAY_S + 1e-9);

/** Maps the sensor that produced a reading to the method label the agent understands. */
export function methodOf(sensorType: string): string {
  if (sensorType === "remote_inspection") return "inspectField";
  if (sensorType === "visual_survey") return "drone";
  if (sensorType === "pest_scout" || sensorType === "soil_probe") return "rover";
  return sensorType;
}

/** Folds the latest authorized field observations and this session's completed treatments into the ledger. */
export function refreshLedger(state: LedgerInput, fields: FieldObservations): void {
  const ledger = state.riskLedger;
  for (const field of fields.fields) {
    const risk = (ledger[field.fieldId] ??= emptyRisk());
    const alerts = field.attention ?? [];
    const top = alerts.reduce<(typeof alerts)[number] | null>((best, a) => (best === null || a.level > best.level || (a.level === best.level && a.sinceSimTimeS < best.sinceSimTimeS) ? a : best), null);
    if (top) {
      if (risk.alertSinceS === null || top.sinceSimTimeS !== risk.alertSinceS || top.category !== risk.alertCategory) risk.lastNotifiedDay = null;
      risk.alertCategory = top.category;
      risk.alertLevel = top.level;
      risk.alertSinceS = top.sinceSimTimeS;
    } else {
      // Resolved condition: the alert clears, but treatment history and irreversible-damage context stay.
      risk.alertCategory = null;
      risk.alertLevel = null;
      risk.alertSinceS = null;
      risk.lastNotifiedDay = null;
    }

    const fold = (name: "pestPressure" | "cropHealth", cur: "pest" | "health", prev: "prevPest" | "prevHealth") => {
      const m = field.measurements[name];
      if (!m) return;
      const known = risk[cur];
      if (known && m.observedAtSimTimeS <= known.atS) return;
      risk[prev] = known;
      risk[cur] = { v: m.value, atS: m.observedAtSimTimeS, sensor: m.sensorType };
    };
    fold("pestPressure", "pest", "prevPest");
    fold("cropHealth", "health", "prevHealth");
    const newest = Object.values(field.measurements).reduce<{ at: number; sensor: string } | null>((best, m) => (best === null || m.observedAtSimTimeS > best.at ? { at: m.observedAtSimTimeS, sensor: m.sensorType } : best), null);
    if (newest && (risk.lastObservedAtS === null || newest.at > risk.lastObservedAtS)) {
      risk.lastObservedAtS = newest.at;
      risk.lastObservedBy = methodOf(newest.sensor);
    }

    const treatments = state.actions.filter((a) => a.type === "applyTreatment" && a.status === "completed" && a.target === field.fieldId);
    const last = treatments.reduce<number | null>((m, a) => (a.finishedAtS !== null && (m === null || a.finishedAtS > m) ? a.finishedAtS : m), null);
    if (treatments.length > risk.treatments || (last !== null && (risk.lastTreatmentAtS === null || last > risk.lastTreatmentAtS))) {
      risk.followUpPending = true;
    }
    risk.treatments = Math.max(risk.treatments, treatments.length);
    if (last !== null) risk.lastTreatmentAtS = last;
    // An authorized observation taken after the treatment is the outcome check; it settles the follow-up.
    if (risk.followUpPending && risk.lastTreatmentAtS !== null && risk.lastObservedAtS !== null && risk.lastObservedAtS > risk.lastTreatmentAtS && (risk.pest?.atS ?? 0) > risk.lastTreatmentAtS) {
      risk.followUpPending = false;
    }
  }
}

const dropped = (cur: Reading | null, prev: Reading | null, direction: 1 | -1): boolean => cur !== null && prev !== null && direction * (cur.v - prev.v) >= WORSENING_DELTA;

/**
 * Which fields deserve a new model decision now. Pure policy over the ledger: level >= 2 alerts are NOT handled here (the
 * simulator's own events interrupt for them immediately and without a cap). Each field is notified at most once per
 * simulated day, and a notification is consumed (it is never re-sent for the same condition within that day).
 */
export function dueReviews(state: LedgerInput, simTimeS: number): DueReview[] {
  const today = day(simTimeS);
  const due: DueReview[] = [];
  for (const [fieldId, risk] of Object.entries(state.riskLedger)) {
    if (risk.alertLevel !== null && risk.alertLevel >= 2) continue;
    if (risk.lastNotifiedDay !== null && today - risk.lastNotifiedDay < NOTIFY_MIN_INTERVAL_DAYS) continue;
    let reason: ReviewReason | null = null;
    const worse = dropped(risk.pest, risk.prevPest, 1) || dropped(risk.health, risk.prevHealth, -1);
    const newestAt = Math.max(risk.pest?.atS ?? 0, risk.health?.atS ?? 0);
    if (worse && risk.alertLevel !== null && (risk.worseningFlaggedAtS ?? -1) < newestAt) {
      reason = "worsening_observed";
      risk.worseningFlaggedAtS = newestAt;
    } else if (risk.followUpPending && risk.lastTreatmentAtS !== null && simTimeS - risk.lastTreatmentAtS > STALE_FOLLOW_UP_DAYS * DAY_S) {
      // Too old to be a follow-up (for example treatments from before this ledger existed).
      risk.followUpPending = false;
    } else if (risk.followUpPending && risk.lastTreatmentAtS !== null && simTimeS - risk.lastTreatmentAtS >= FOLLOW_UP_DAYS * DAY_S - 1e-6) {
      reason = "treatment_follow_up";
    } else if (risk.alertLevel === 1 && risk.alertSinceS !== null && simTimeS - risk.alertSinceS >= PERSISTENT_ALERT_DAYS * DAY_S - 1e-6) {
      reason = "persistent_alert";
    }
    if (!reason) continue;
    risk.lastNotifiedDay = today;
    // The follow-up is a one-shot wake; the outcome is then judged on a fresh observation, never assumed.
    if (reason === "treatment_follow_up") risk.followUpPending = false;
    due.push({ fieldId, reason });
  }
  return due;
}

/**
 * One read-only checkpoint review: refreshes the ledger from the simulator's authorized view and returns a short reason
 * only when a field is due. It makes no model call and no mutation, so an internal checkpoint stays cheap.
 */
export async function reviewAtCheckpoint(
  client: { getFieldObservations(gameId: string): Promise<FieldObservations> },
  gameId: string,
  state: LedgerInput,
): Promise<string | null> {
  const fields = await client.getFieldObservations(gameId);
  refreshLedger(state, fields);
  const due = dueReviews(state, fields.simTimeS);
  if (due.length === 0) return null;
  return `review_due: ${due.map((d) => `${d.fieldId} ${d.reason}`).join(", ")}`.slice(0, 160);
}

export interface AttentionEntry {
  id: string;
  why: string;
  alert?: { cat: string; lvl: number; ageDays: number };
  treated?: { count: number; lastDaysAgo: number; outcomeChecked: boolean };
  lastObserved?: { daysAgo: number; by: string };
  lastKnown?: Record<string, { v: number; daysAgo: number; trend: "up" | "down" | "flat" | null; sensor: string }>;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const trend = (cur: Reading | null, prev: Reading | null): "up" | "down" | "flat" | null => (cur && prev ? (Math.abs(cur.v - prev.v) < 0.02 ? "flat" : cur.v > prev.v ? "up" : "down") : null);

/**
 * Cross-field priority queue for the brief. Untreated persistent alerts come first, then treated fields still awaiting
 * an outcome check; a field inspected within the last day is ranked lower so the agent rotates instead of fixating.
 * Values are labelled last-known (with age and sensor); the alert itself is the simulator's current status.
 */
export function attentionQueue(state: LedgerInput, simTimeS: number): AttentionEntry[] {
  const scored: Array<{ score: number; entry: AttentionEntry }> = [];
  for (const [id, risk] of Object.entries(state.riskLedger)) {
    const active = risk.alertLevel !== null;
    if (!active && !risk.followUpPending) continue;
    const ageDays = risk.alertSinceS !== null ? (simTimeS - risk.alertSinceS) / DAY_S : 0;
    const treated = risk.treatments > 0;
    const sinceTreatDays = risk.lastTreatmentAtS !== null ? (simTimeS - risk.lastTreatmentAtS) / DAY_S : null;
    const inspectedAgoDays = risk.lastObservedAtS !== null ? (simTimeS - risk.lastObservedAtS) / DAY_S : null;
    let score = (risk.alertLevel ?? 0) * 10 + Math.min(ageDays, 10);
    let why: string;
    if (active && !treated) { score += 6; why = "untreated_alert"; }
    else if (risk.followUpPending) { score += 5; why = "treated_awaiting_outcome_check"; }
    else if (active) { why = "alert_persists_after_treatment"; score += 2; }
    else why = "outcome_check_pending";
    if (inspectedAgoDays !== null && inspectedAgoDays < 1) score -= 4;
    const lastKnown: NonNullable<AttentionEntry["lastKnown"]> = {};
    if (risk.pest) lastKnown.pestPressure = { v: r2(risk.pest.v), daysAgo: r2((simTimeS - risk.pest.atS) / DAY_S), trend: trend(risk.pest, risk.prevPest), sensor: methodOf(risk.pest.sensor) };
    if (risk.health) lastKnown.cropHealth = { v: r2(risk.health.v), daysAgo: r2((simTimeS - risk.health.atS) / DAY_S), trend: trend(risk.health, risk.prevHealth), sensor: methodOf(risk.health.sensor) };
    scored.push({
      score,
      entry: {
        id,
        why,
        ...(active ? { alert: { cat: risk.alertCategory ?? "unknown", lvl: risk.alertLevel!, ageDays: r2(ageDays) } } : {}),
        ...(treated ? { treated: { count: risk.treatments, lastDaysAgo: r2(sinceTreatDays ?? 0), outcomeChecked: !risk.followUpPending } } : {}),
        ...(inspectedAgoDays !== null ? { lastObserved: { daysAgo: r2(inspectedAgoDays), by: risk.lastObservedBy ?? "unknown" } } : {}),
        ...(Object.keys(lastKnown).length > 0 ? { lastKnown } : {}),
      },
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).map((s) => s.entry);
}
