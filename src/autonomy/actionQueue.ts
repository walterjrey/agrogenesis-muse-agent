import { createHash } from "node:crypto";
import { z } from "zod";
import type { FieldObservation, FieldObservations } from "../contracts/fieldObservations.js";
import { OBSERVATION_VALIDITY_DAYS } from "./freshness.js";
import type { RiskLedger } from "./riskLedger.js";

const DAY_S = 60;

export const QueueStatus = z.enum(["planned", "queued", "running", "completed", "failed", "cancelled", "superseded"]);
export type QueueStatus = z.infer<typeof QueueStatus>;
export const QueueKind = z.enum(["irrigate", "pest_treatment"]);
export type QueueKind = z.infer<typeof QueueKind>;

const ACTIVE: ReadonlySet<QueueStatus> = new Set(["planned", "queued", "running"]);
export const isActiveQueueStatus = (status: QueueStatus): boolean => ACTIVE.has(status);

/**
 * One durable, idempotent field operation. The model decides WHAT is justified and why; the quantity is computed from the
 * authorized observation and the simulator's rules, and the execution key is persisted before anything is sent.
 */
export const QueueItem = z.strictObject({
  /** Stable operation id: the same field, kind, part and observation always produce the same id (never planned twice). */
  id: z.string(),
  fieldId: z.string(),
  kind: QueueKind,
  status: QueueStatus,
  quantity: z.number().nullable(),
  unit: z.enum(["m3", "application"]),
  expectedCostCredits: z.number().nullable(),
  /** 1 = most urgent. */
  priority: z.number().int().min(1).max(5),
  dependsOn: z.array(z.string()).default([]),
  earliestSimTimeS: z.number(),
  /** The authorized reading this item was planned from (never current ground truth). */
  observationRef: z.strictObject({ atS: z.number(), soilMoisture: z.number().nullable(), pestPressure: z.number().nullable() }),
  reason: z.string(),
  expectedEffect: z.string(),
  completionCriteria: z.string(),
  request: z.strictObject({ type: z.string(), params: z.record(z.string(), z.unknown()) }),
  createdAtS: z.number(),
  updatedAtS: z.number(),
  /** Set (and persisted) before the request is sent, so a restart or retry replays the same key instead of acting twice. */
  idempotencyKey: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});
export type QueueItem = z.infer<typeof QueueItem>;
export const ActionQueue = z.array(QueueItem);
export type ActionQueue = z.infer<typeof ActionQueue>;

export interface QueuePolicy {
  /** Per-operation capacity of the simulator's irrigation action (m3). */
  maxOperationM3: number;
  /** Irrigate up to this share of the field-capacity moisture; more only drains away. */
  irrigationTargetShare: number;
  /** Smaller deficits are not worth the flat service fee. */
  minIrrigationM3: number;
  minIrrigationCapacityShare: number;
  /** Plant-available water share at which the soil counts as sufficiently wet. */
  irrigationSatisfiedAvailable: number;
  /** Pest pressure below this is not worth a treatment. */
  pestPressureThreshold: number;
  /** A treatment is not repeated before this many simulated days and never without a newer observation showing pests. */
  treatmentIntervalDays: number;
  observationValidityDays: number;
  /** A newer reading that moved this much (fraction) invalidates a plan made from the older one. */
  materialMoistureChange: number;
  maxCostPerOperationCredits: number;
  creditReserve: number;
}

export const DEFAULT_QUEUE_POLICY: Readonly<QueuePolicy> = {
  maxOperationM3: 1000,
  irrigationTargetShare: 0.95,
  minIrrigationM3: 20,
  minIrrigationCapacityShare: 0.05,
  irrigationSatisfiedAvailable: 0.85,
  pestPressureThreshold: 0.25,
  treatmentIntervalDays: 1,
  observationValidityDays: OBSERVATION_VALIDITY_DAYS,
  materialMoistureChange: 0.1,
  maxCostPerOperationCredits: 400,
  creditReserve: 100,
};

export interface PlanRequest {
  fieldId: string;
  kind: QueueKind;
  priority?: number;
  reason: string;
  expectedEffect?: string;
  /** Irrigation only: target soil moisture (fraction of capacity). Defaults to just under field capacity. */
  targetMoisture?: number;
  source?: "reservoir" | "creek";
  /** Delay the operation by this many simulated days. */
  earliestInDays?: number;
}

export interface Rejection {
  fieldId: string;
  kind: QueueKind;
  code: string;
  message: string;
}

export interface PreviewResult {
  ok: boolean;
  credits: number | null;
  durationS: number | null;
  errors: Array<{ code: string; detail?: string }>;
}

export interface PlanContext {
  fields: FieldObservations;
  nowS: number;
  credits: number | null;
  queue: ActionQueue;
  riskLedger: RiskLedger;
  actions: ReadonlyArray<{ type: string; status: string; target: string | null; finishedAtS: number | null }>;
  /** Authoritative simulator validation and cost of an exact request; never an invented estimate. */
  preview: (type: string, params: Record<string, unknown>) => Promise<PreviewResult>;
  policy?: Partial<QueuePolicy>;
}

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const policyOf = (ctx: { policy?: Partial<QueuePolicy> }): QueuePolicy => ({ ...DEFAULT_QUEUE_POLICY, ...ctx.policy });

export function operationId(fieldId: string, kind: QueueKind, part: number, observedAtS: number): string {
  return `q-${createHash("sha256").update(`${fieldId}|${kind}|${part}|${round(observedAtS, 3)}`).digest("hex").slice(0, 12)}`;
}

/** Splits a required irrigation volume into the fewest simulator operations (the per-operation maximum), never padding it. */
export function irrigationParts(volumeM3: number, maxOperationM3: number): number[] {
  const n = Math.max(1, Math.ceil(volumeM3 / maxOperationM3 - 1e-9));
  const each = Math.floor((volumeM3 / n) * 10) / 10;
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = round(volumeM3 - each * (n - 1), 1);
  return parts.filter((p) => p > 0);
}

/** Water needed to raise the observed moisture to the target (m3), from the static soil capacity. */
export function irrigationNeedM3(field: FieldObservation, targetMoisture?: number, policy: QueuePolicy = DEFAULT_QUEUE_POLICY): { volumeM3: number; target: number; observed: number; available: number } | null {
  const soil = field.soil;
  const moisture = field.measurements.soilMoisture;
  if (!soil || !moisture) return null;
  const ceiling = soil.fieldCapacityFraction * policy.irrigationTargetShare;
  const target = Math.min(targetMoisture ?? ceiling, ceiling);
  const available = (moisture.value - soil.wiltingPointFraction) / Math.max(1e-6, soil.fieldCapacityFraction - soil.wiltingPointFraction);
  return { volumeM3: Math.max(0, (target - moisture.value) * soil.capacityM3), target, observed: moisture.value, available };
}

const reject = (r: PlanRequest, code: string, message: string): Rejection => ({ fieldId: r.fieldId, kind: r.kind, code, message });

function usable(m: { observedAtSimTimeS: number; freshness: string } | undefined, nowS: number, policy: QueuePolicy): boolean {
  return !!m && m.freshness !== "expired" && m.freshness !== "never_observed" && nowS - m.observedAtSimTimeS <= policy.observationValidityDays * DAY_S + 1e-9;
}

/**
 * Turns the model's justified requests into queue items. All numbers (volume, cost, eligibility) come from the observation,
 * the soil capacity and the simulator's own dry-run; a request without sufficient evidence or economic justification is
 * rejected with a reason instead of being executed. Requests are handled most-urgent first so scarce credits go to them.
 */
export async function planFieldActions(ctx: PlanContext, requests: PlanRequest[]): Promise<{ queued: QueueItem[]; reused: QueueItem[]; rejected: Rejection[] }> {
  const policy = policyOf(ctx);
  const queued: QueueItem[] = [];
  const reused: QueueItem[] = [];
  const rejected: Rejection[] = [];
  let committed = ctx.queue.filter((i) => isActiveQueueStatus(i.status)).reduce((s, i) => s + (i.expectedCostCredits ?? 0), 0);
  const ordered = [...requests].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

  for (const req of ordered) {
    const field = ctx.fields.fields.find((f) => f.fieldId === req.fieldId);
    if (!field) {
      rejected.push(reject(req, "unknown_field", `No field ${req.fieldId}.`));
      continue;
    }
    const earliest = ctx.nowS + (req.earliestInDays ?? 0) * DAY_S;
    const risk = ctx.riskLedger[req.fieldId];
    const lastDone = (type: string) => ctx.actions.filter((a) => a.type === type && a.target === req.fieldId && a.status === "completed").reduce<number | null>((m, a) => (a.finishedAtS !== null && (m === null || a.finishedAtS > m) ? a.finishedAtS : m), null);

    let moisture: number | null = null;
    let pest: number | null = null;
    let observedAtS: number;
    let parts: Array<{ type: string; params: Record<string, unknown>; quantity: number; unit: "m3" | "application"; effect: string; criteria: string }>;

    if (req.kind === "irrigate") {
      const m = field.measurements.soilMoisture;
      if (!usable(m, ctx.nowS, policy)) {
        rejected.push(reject(req, "needs_observation", "There is no usable soil-moisture reading for this field (missing or older than its validity). Inspect it once, then plan."));
        continue;
      }
      if (!field.soil) {
        rejected.push(reject(req, "soil_capacity_unavailable", "The simulator did not publish this field's soil capacity, so the irrigation volume cannot be computed. Use execute_action with your own volume."));
        continue;
      }
      observedAtS = m!.observedAtSimTimeS;
      if ((lastDone("irrigateField") ?? -Infinity) > observedAtS) {
        rejected.push(reject(req, "observation_predates_intervention", "An irrigation finished after this reading, so it no longer describes the field. Re-measure once the effect is due, then plan."));
        continue;
      }
      const need = irrigationNeedM3(field, req.targetMoisture, policy)!;
      moisture = need.observed;
      const minM3 = Math.max(policy.minIrrigationM3, policy.minIrrigationCapacityShare * field.soil.capacityM3);
      if (need.available >= policy.irrigationSatisfiedAvailable || need.volumeM3 < minM3) {
        rejected.push(reject(req, "no_water_need", `Observed moisture ${round(need.observed, 3)} already reaches ${round(need.target, 3)} within the minimum worthwhile volume (${round(need.volumeM3, 1)} m3 needed, minimum ${round(minM3, 1)} m3). Irrigating would waste the service fee.`));
        continue;
      }
      // The simulator pumps at most pumpLimitM3PerDay per source per simulated day, so a larger need is delivered by one operation per day.
      const pumpCap = field.soil.pumpLimitM3PerDay ?? Infinity;
      parts = irrigationParts(need.volumeM3, Math.min(policy.maxOperationM3, pumpCap)).map((v) => ({
        type: "irrigateField",
        params: { fieldId: req.fieldId, volumeM3: v, source: req.source ?? "reservoir" },
        quantity: v,
        unit: "m3" as const,
        effect: `Raises soil moisture by about ${round((v / field.soil!.capacityM3) * 100, 1)} points (to about ${round(need.target, 2)} once all parts finish).`,
        criteria: "Operation completed with the requested volume delivered; re-measure moisture no sooner than 1 simulated day later.",
      }));
    } else {
      const p = field.measurements.pestPressure;
      if (!usable(p, ctx.nowS, policy)) {
        rejected.push(reject(req, "needs_observation", "There is no usable pest-pressure reading for this field. Inspect it once, then plan."));
        continue;
      }
      observedAtS = p!.observedAtSimTimeS;
      pest = p!.value;
      if (pest < policy.pestPressureThreshold) {
        rejected.push(reject(req, "pressure_below_threshold", `Observed pest pressure ${round(pest, 3)} is below the treatment threshold ${policy.pestPressureThreshold}; the cost is not justified.`));
        continue;
      }
      const treatedTimes = [lastDone("applyTreatment"), risk?.lastTreatmentAtS ?? null].filter((v): v is number => v !== null);
      const lastTreated = treatedTimes.length > 0 ? Math.max(...treatedTimes) : null;
      if (lastTreated !== null && observedAtS <= lastTreated) {
        rejected.push(reject(req, "observation_predates_treatment", "This field was treated after the reading was taken. Never repeat a treatment without a newer observation showing the pests are still there."));
        continue;
      }
      if (lastTreated !== null && ctx.nowS - lastTreated < policy.treatmentIntervalDays * DAY_S - 1e-9) {
        rejected.push(reject(req, "treatment_interval", `The last treatment finished less than ${policy.treatmentIntervalDays} simulated day(s) ago.`));
        continue;
      }
      parts = [{
        type: "applyTreatment",
        params: { fieldId: req.fieldId, treatment: "pest_management" },
        quantity: 1,
        unit: "application",
        effect: "One treatment knocks pest density down once; pests can regrow, so it is judged on a later observation.",
        criteria: "Operation completed; re-measure pest pressure no sooner than 1 simulated day after it finishes.",
      }];
    }

    const sameField = ctx.queue.filter((i) => i.fieldId === req.fieldId && i.kind === req.kind && isActiveQueueStatus(i.status));
    if (sameField.some((i) => i.status === "running")) {
      rejected.push(reject(req, "operation_in_progress", "An operation of this kind is already running on this field; wait for it to finish and its effect to show."));
      continue;
    }
    const firstId = operationId(req.fieldId, req.kind, 0, observedAtS);
    if (sameField.some((i) => i.id === firstId)) {
      reused.push(...sameField.filter((i) => i.id === firstId || i.dependsOn.includes(firstId)));
      continue;
    }

    const built: QueueItem[] = [];
    let failure: Rejection | null = null;
    let planCost = 0;
    for (let n = 0; n < parts.length; n += 1) {
      const part = parts[n]!;
      const preview = await ctx.preview(part.type, part.params);
      if (!preview.ok) {
        const code = preview.errors[0]?.code ?? "simulator_rejected";
        failure = reject(req, `simulator_rejected:${code}`, `The simulator refuses this operation now (${preview.errors.map((e) => e.code).join(", ") || "invalid"}).`);
        break;
      }
      const cost = preview.credits ?? 0;
      if (cost > policy.maxCostPerOperationCredits) {
        failure = reject(req, "cost_above_policy", `One operation would cost ${round(cost)} credits, above the per-operation spending policy of ${policy.maxCostPerOperationCredits}.`);
        break;
      }
      planCost += cost;
      built.push({
        id: operationId(req.fieldId, req.kind, n, observedAtS),
        fieldId: req.fieldId,
        kind: req.kind,
        status: n === 0 && earliest <= ctx.nowS ? "queued" : "planned",
        quantity: part.quantity,
        unit: part.unit,
        expectedCostCredits: round(cost),
        priority: Math.min(5, Math.max(1, Math.round(req.priority ?? 3))),
        dependsOn: n === 0 ? [] : [operationId(req.fieldId, req.kind, n - 1, observedAtS)],
        earliestSimTimeS: earliest + (req.kind === "irrigate" && field.soil?.pumpLimitM3PerDay ? n * DAY_S : 0),
        observationRef: { atS: observedAtS, soilMoisture: moisture, pestPressure: pest },
        reason: req.reason.slice(0, 300),
        expectedEffect: (req.expectedEffect ?? part.effect).slice(0, 300),
        completionCriteria: part.criteria,
        request: { type: part.type, params: part.params },
        createdAtS: ctx.nowS,
        updatedAtS: ctx.nowS,
        idempotencyKey: null,
        note: null,
      });
    }
    if (failure) {
      rejected.push(failure);
      continue;
    }
    if (ctx.credits !== null && committed + planCost > ctx.credits - policy.creditReserve) {
      rejected.push(reject(req, "insufficient_credits", `The plan costs about ${round(planCost)} credits, but only ${round(ctx.credits - committed - policy.creditReserve)} are free after queued work and the ${policy.creditReserve}-credit reserve.`));
      continue;
    }
    committed += planCost;
    // A newer observation replaces an older plan for the same field and kind that has not started.
    for (const old of sameField) if (old.status !== "running") supersede(old, "newer_observation", ctx.nowS);
    queued.push(...built);
  }
  return { queued, reused, rejected };
}

export function supersede(item: QueueItem, why: string, nowS: number): void {
  item.status = "superseded";
  item.note = why;
  item.updatedAtS = nowS;
}

export interface StaleContext {
  fields: FieldObservations;
  nowS: number;
  riskLedger: RiskLedger;
  actions: ReadonlyArray<{ type: string; status: string; target: string | null; finishedAtS: number | null }>;
  policy?: Partial<QueuePolicy>;
}

/** Why an unstarted item must not run any more (conditions changed materially since it was planned), or null when it is still valid. */
export function staleReason(item: QueueItem, ctx: StaleContext): string | null {
  const policy = policyOf(ctx);
  const age = ctx.nowS - item.observationRef.atS;
  // A plan survives one extra day beyond observation validity so a day change alone never discards it; material changes always do.
  const ageLimit = (policy.observationValidityDays + 1) * DAY_S;
  if (age > ageLimit + 1e-9) return `the observation it was planned from is ${round(age / DAY_S, 1)} simulated days old`;
  const field = ctx.fields.fields.find((f) => f.fieldId === item.fieldId);
  if (!field) return "the field no longer exists";
  const doneAfter = (type: string) => ctx.actions.some((a) => a.type === type && a.target === item.fieldId && a.status === "completed" && (a.finishedAtS ?? -Infinity) > item.observationRef.atS && !item.dependsOn.length);
  if (item.kind === "irrigate") {
    const m = field.measurements.soilMoisture;
    if (m && m.observedAtSimTimeS > item.observationRef.atS && item.observationRef.soilMoisture !== null) {
      if (m.value - item.observationRef.soilMoisture >= policy.materialMoistureChange) return `a newer reading shows the soil is much wetter (${round(m.value, 3)} vs ${round(item.observationRef.soilMoisture, 3)})`;
      if (field.soil && (m.value - field.soil.wiltingPointFraction) / Math.max(1e-6, field.soil.fieldCapacityFraction - field.soil.wiltingPointFraction) >= policy.irrigationSatisfiedAvailable) return "a newer reading shows the soil is already sufficiently wet";
    }
    if (doneAfter("irrigateField")) return "another irrigation of this field finished after the plan was made";
  } else {
    const p = field.measurements.pestPressure;
    if (p && p.observedAtSimTimeS > item.observationRef.atS && p.value < policy.pestPressureThreshold) return `a newer reading shows pest pressure fell to ${round(p.value, 3)}`;
    if (doneAfter("applyTreatment")) return "a treatment of this field finished after the plan was made";
  }
  return null;
}

/** Items that may be submitted now: dependencies done, time reached, field free of other operations, plan not stale. At most one per field. */
export function runnableItems(queue: ActionQueue, ctx: StaleContext & { busyFields: ReadonlySet<string> }): { run: QueueItem[]; staled: Array<{ item: QueueItem; why: string }> } {
  const run: QueueItem[] = [];
  const staled: Array<{ item: QueueItem; why: string }> = [];
  const byId = new Map(queue.map((i) => [i.id, i]));
  const taken = new Set<string>();
  const candidates = queue.filter((i) => (i.status === "queued" || i.status === "planned")).sort((a, b) => a.priority - b.priority || a.createdAtS - b.createdAtS || a.id.localeCompare(b.id));
  for (const item of candidates) {
    if (item.earliestSimTimeS > ctx.nowS + 1e-9) continue;
    const deps = item.dependsOn.map((d) => byId.get(d));
    if (deps.some((d) => d && (d.status === "failed" || d.status === "cancelled" || d.status === "superseded"))) {
      staled.push({ item, why: "a previous part of the same plan did not complete" });
      continue;
    }
    if (deps.some((d) => d && d.status !== "completed")) continue;
    const why = staleReason(item, ctx);
    if (why) {
      staled.push({ item, why });
      continue;
    }
    if (ctx.busyFields.has(item.fieldId) || taken.has(item.fieldId)) continue;
    taken.add(item.fieldId);
    run.push(item);
  }
  return { run, staled };
}

interface TrackedLike {
  idempotencyKey: string;
  actionId: string;
  status: string;
  consumedWaterM3: number | null;
  failure: string | null;
  outcome: string | null;
}
interface OperationLike {
  idempotencyKey: string;
  status: string;
  summary: Record<string, unknown>;
}

/**
 * Folds the outcome of submitted operations back into the queue: completion, failure, or a refused request. Dependent parts of
 * a failed item are cancelled; unrelated items are preserved.
 */
export function reconcileQueue(queue: ActionQueue, actions: ReadonlyArray<TrackedLike>, operations: ReadonlyArray<OperationLike>, nowS: number): boolean {
  let changed = false;
  for (const item of queue) {
    if (item.status !== "running" || item.idempotencyKey === null) continue;
    const action = actions.find((a) => a.idempotencyKey === item.idempotencyKey);
    if (action) {
      if (action.status === "completed") {
        item.status = "completed";
        item.note = action.outcome ?? "completed";
      } else if (action.status === "failed" || action.status === "cancelled" || action.status === "rejected") {
        item.status = "failed";
        item.note = (action.failure ?? action.outcome ?? action.status).slice(0, 200);
      } else continue;
      item.updatedAtS = nowS;
      changed = true;
      continue;
    }
    const op = operations.find((o) => o.idempotencyKey === item.idempotencyKey);
    if (op && (op.status === "rejected" || op.status === "not_applied")) {
      item.status = "failed";
      item.note = `refused by the simulator${typeof op.summary.code === "string" ? ` (${op.summary.code})` : ""}`;
      item.updatedAtS = nowS;
      changed = true;
    }
  }
  for (const item of queue) {
    if (item.status !== "planned" && item.status !== "queued") continue;
    const broken = item.dependsOn.some((d) => {
      const dep = queue.find((x) => x.id === d);
      return dep && (dep.status === "failed" || dep.status === "cancelled" || dep.status === "superseded");
    });
    if (broken) {
      item.status = "cancelled";
      item.note = "a previous part of the same plan did not complete";
      item.updatedAtS = nowS;
      changed = true;
    }
  }
  return changed;
}

/** Terminal items older than this are dropped from the persisted queue to keep the session small. */
export function pruneQueue(queue: ActionQueue, keepTerminal = 30): void {
  const terminal = queue.filter((i) => !isActiveQueueStatus(i.status));
  const drop = new Set(terminal.sort((a, b) => b.updatedAtS - a.updatedAtS).slice(keepTerminal).map((i) => i.id));
  if (drop.size === 0) return;
  for (let i = queue.length - 1; i >= 0; i -= 1) if (drop.has(queue[i]!.id)) queue.splice(i, 1);
}

/** Compact prompt view of the queue: active items in full, a short tally of the rest. */
export function queueBrief(queue: ActionQueue, nowS: number) {
  const active = queue.filter((i) => isActiveQueueStatus(i.status));
  if (active.length === 0) return null;
  return active.map((i) => ({
    id: i.id,
    field: i.fieldId,
    kind: i.kind,
    status: i.status,
    qty: i.quantity,
    unit: i.unit,
    cost: i.expectedCostCredits,
    pri: i.priority,
    ...(i.dependsOn.length > 0 ? { after: i.dependsOn } : {}),
    ...(i.earliestSimTimeS > nowS ? { notBeforeS: i.earliestSimTimeS } : {}),
    obsAtS: i.observationRef.atS,
    why: i.reason,
  }));
}
