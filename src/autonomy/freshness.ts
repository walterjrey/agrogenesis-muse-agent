import type { RiskLedger } from "./riskLedger.js";

const DAY_S = 60;

/** How long an authorized field observation stays usable before the agent should doubt it (simulated days). */
export const OBSERVATION_VALIDITY_DAYS = 3;
/** With a severe (level >= 2) warning active, conditions move quickly, so a reading is trusted for less time. */
export const SEVERE_OBSERVATION_VALIDITY_DAYS = 1;
/** Earliest meaningful reevaluation after this session's own intervention finished on a field. */
export const REEVALUATION_DELAY_DAYS = 1;

const INTERVENTIONS: ReadonlySet<string> = new Set(["irrigateField", "applyTreatment"]);

export interface FreshnessAction {
  type: string;
  status: string;
  target: string | null;
  startedAtS: number | null;
  finishedAtS: number | null;
}

export type FreshnessVerdict =
  | "reusable"
  | "never_observed"
  | "aged"
  | "new_alert"
  | "intervention_since"
  | "operation_in_progress"
  | "inspection_in_flight";

export interface FieldFreshness {
  fieldId: string;
  verdict: FreshnessVerdict;
  observedAtS: number | null;
  ageDays: number | null;
  /** The reading may be reused (no new inspection is justified) until this simulated time. */
  reuseUntilS: number | null;
  /** A new inspection is not meaningful before this time (an intervention needs time to show its effect). */
  reevaluateNotBeforeS: number | null;
}

const isTerminal = (status: string): boolean => status === "completed" || status === "failed" || status === "cancelled" || status === "rejected";

/**
 * Per-field validity of the newest authorized observation. It depends on elapsed simulated time, active warnings and this
 * session's own interventions, never on ground truth: a reading stays useful until something gives a reason to doubt it.
 */
export function fieldFreshness(
  state: { riskLedger: RiskLedger; actions: ReadonlyArray<FreshnessAction> },
  fieldId: string,
  nowS: number,
): FieldFreshness {
  const risk = state.riskLedger[fieldId];
  const own = state.actions.filter((a) => a.target === fieldId);
  const inspections = own.filter((a) => a.type === "inspectField");
  if (inspections.some((a) => !isTerminal(a.status))) {
    return { fieldId, verdict: "inspection_in_flight", observedAtS: risk?.lastObservedAtS ?? null, ageDays: null, reuseUntilS: null, reevaluateNotBeforeS: null };
  }
  const inspectedAtS = inspections.reduce<number | null>((m, a) => {
    const at = a.status === "completed" ? (a.finishedAtS ?? a.startedAtS) : null;
    return at !== null && (m === null || at > m) ? at : m;
  }, null);
  const observedAtS = Math.max(risk?.lastObservedAtS ?? -Infinity, inspectedAtS ?? -Infinity);
  if (!Number.isFinite(observedAtS)) return { fieldId, verdict: "never_observed", observedAtS: null, ageDays: null, reuseUntilS: null, reevaluateNotBeforeS: null };
  const ageDays = (nowS - observedAtS) / DAY_S;
  const base = { fieldId, observedAtS, ageDays: Math.round(ageDays * 100) / 100 };

  const running = own.some((a) => INTERVENTIONS.has(a.type) && !isTerminal(a.status));
  if (running) return { ...base, verdict: "operation_in_progress", reuseUntilS: null, reevaluateNotBeforeS: null };
  const sinceObs = own.filter((a) => INTERVENTIONS.has(a.type) && a.status === "completed" && (a.finishedAtS ?? -Infinity) > observedAtS);
  if (sinceObs.length > 0) {
    const last = Math.max(...sinceObs.map((a) => a.finishedAtS ?? 0));
    return { ...base, verdict: "intervention_since", reuseUntilS: null, reevaluateNotBeforeS: last + REEVALUATION_DELAY_DAYS * DAY_S };
  }
  if (risk && risk.alertSinceS !== null && risk.alertSinceS > observedAtS) return { ...base, verdict: "new_alert", reuseUntilS: null, reevaluateNotBeforeS: null };
  const severe = risk?.alertLevel !== null && risk?.alertLevel !== undefined && risk.alertLevel >= 2;
  const reuseUntilS = observedAtS + (severe ? SEVERE_OBSERVATION_VALIDITY_DAYS : OBSERVATION_VALIDITY_DAYS) * DAY_S;
  if (nowS <= reuseUntilS + 1e-9) return { ...base, verdict: "reusable", reuseUntilS, reevaluateNotBeforeS: null };
  return { ...base, verdict: "aged", reuseUntilS, reevaluateNotBeforeS: null };
}

/**
 * Whether paying for another inspection of the field is justified now. Returns a refusal when the existing observation is
 * still valid, when an operation or inspection is already in flight, or when the last intervention has not had time to show
 * an effect. Missing, aged, or alert-invalidated observations are always allowed.
 */
export function inspectionRefusal(freshness: FieldFreshness, nowS: number): { code: string; message: string } | null {
  switch (freshness.verdict) {
    case "reusable":
      return {
        code: "observation_still_valid",
        message: `The reading from simulated time ${freshness.observedAtS} is only ${freshness.ageDays} days old and nothing has changed on this field since (no intervention, no new warning). Reuse it instead of paying for another inspection; it stays valid until simulated time ${freshness.reuseUntilS}.`,
      };
    case "inspection_in_flight":
      return { code: "inspection_in_flight", message: "An inspection of this field is already running; wait for its result instead of ordering another." };
    case "operation_in_progress":
      return { code: "operation_in_progress", message: "An operation on this field is still running; inspect after it finishes and its effect has had time to show." };
    case "intervention_since":
      if (freshness.reevaluateNotBeforeS !== null && nowS < freshness.reevaluateNotBeforeS - 1e-9) {
        return { code: "reevaluation_not_due", message: `Your last intervention on this field finished recently; its effect is not meaningful to re-measure before simulated time ${freshness.reevaluateNotBeforeS}.` };
      }
      return null;
    default:
      return null;
  }
}
