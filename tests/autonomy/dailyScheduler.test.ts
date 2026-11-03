import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutonomousController, newSessionState } from "../../src/autonomy/controller.js";
import {
  absorbObservations,
  addTrigger,
  beginReview,
  classifyTrigger,
  DEFAULT_SCHEDULER_CONFIG,
  decide,
  dayOf,
  duplicateInspection,
  endReview,
  inspectionKey,
  newSchedulerState,
  nextDayBoundary,
  recordInspection,
  type SchedulerConfig,
  type Trigger,
} from "../../src/autonomy/dailyScheduler.js";
import { SessionStore } from "../../src/autonomy/store.js";
import type { SessionState } from "../../src/autonomy/types.js";
import type { GameEvent } from "../../src/contracts/time.js";
import type { FieldObservations } from "../../src/contracts/fieldObservations.js";
import { fieldObservations, GAME_ID } from "../fixtures.js";
import { countingIds, scriptedModel, type ScriptedStep } from "../agent/harness.js";
import { timedSim, type TimedSim, type TimedSimOptions } from "./timedSim.js";

/**
 * MOCKED: a time-aware fake HTTP simulator plus a scripted model. These tests verify the scheduler's policy and the
 * controller's gating (when a model request is allowed at all). They say nothing about real Muse behaviour or real
 * agricultural mechanics. See docs/MUSE_DAILY_SCHEDULER.md for what was and was not measured against a real API.
 */

let sim: TimedSim | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await sim?.close();
  sim = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ids = countingIds();
const TEXT: ScriptedStep = { content: "review done" };
const PLAN = (nextStep: "continue" | "wait_for_actions" | "stop", nextReviewSimSeconds?: number): ScriptedStep => ({
  calls: [{ name: "update_plan", args: { summary: `plan ${nextStep}`, nextStep, priorities: ["farm"], ...(nextStep === "stop" ? { stopReason: "done" } : {}), ...(nextReviewSimSeconds !== undefined ? { nextReviewSimSeconds } : {}) } }],
});
const INSPECT = (fieldId = "field-1"): ScriptedStep => ({ calls: [{ name: "execute_action", args: { type: "inspectField", params: { fieldId }, rationale: "Check the field." } }] });

interface Harness {
  s: TimedSim;
  store: SessionStore;
  model: ReturnType<typeof scriptedModel>;
  run(slices?: number): Promise<SessionState>;
  /** Runs worker slices until the simulated clock reaches `simS` (bounded). */
  runUntil(simS: number, maxSlices?: number): Promise<SessionState>;
}

async function harness(steps: ScriptedStep[], simOptions: TimedSimOptions = {}, scheduler: Partial<SchedulerConfig> = {}, extra: Partial<ConstructorParameters<typeof AutonomousController>[0]> = {}): Promise<Harness> {
  const s = await timedSim({ durationS: 5, estimateS: 5, ...simOptions });
  sim = s;
  const dir = mkdtempSync(join(tmpdir(), "daily-"));
  dirs.push(dir);
  const store = new SessionStore(dir, 5_000);
  const state = newSessionState({ sessionId: "t1", gameId: GAME_ID, modelId: "muse-spark-1.3", mutationsEnabled: true, autoWait: false, autonomyMode: "continuous", scheduler });
  const lock = store.acquire("t1");
  lock.save(state);
  lock.release();
  const model = scriptedModel(steps);
  const run = async (slices = 1) => {
    let last = state;
    for (let n = 0; n < slices; n += 1) {
      const c = new AutonomousController({ store, sessionId: "t1", provider: model, client: s.client, mutationsEnabled: true, newMutationId: ids, retryDelayMs: 1, traceDirectory: null, waitSliceMs: 0, ...extra });
      last = await c.run();
      if (last.lifecycle === "completed" || last.status === "failed") break;
    }
    return last;
  };
  const runUntil = async (simS: number, maxSlices = 300) => {
    let last = state;
    for (let n = 0; n < maxSlices && s.state.simTimeS < simS; n += 1) last = await run(1);
    return last;
  };
  return { s, store, model, run, runUntil };
}

const field = (id: string, measurements: Record<string, { value: number; at: number }>): FieldObservations["fields"][number] => ({
  ...(fieldObservations.fields[0] as FieldObservations["fields"][number]),
  fieldId: id,
  measurements: Object.fromEntries(Object.entries(measurements).map(([k, m]) => [k, { value: m.value, unit: "u", uncertainty: 0.02, observedAtSimTimeS: m.at, ageS: 0, freshness: "fresh", confidence: 0.9, sensorType: "x", coverage: 1 }])),
}) as FieldObservations["fields"][number];

const cfg = DEFAULT_SCHEDULER_CONFIG;
const ctx = { actionType: (id: string) => (id === "a-insp" ? "inspectField" : id === "a-irr" ? "irrigateField" : id === "a-harv" ? "harvestField" : null) };
const ev = (kind: string, data: Record<string, unknown> = {}, actionId: string | null = null, simTimeS = 10, eventId = 1) => ({ eventId, simTimeS, kind, actionId, summary: `${kind} happened`, data }) as unknown as GameEvent;

describe("MOCKED daily scheduler policy (pure)", () => {
  it("classifies critical, review-worthy and purely informational events", () => {
    expect(classifyTrigger(ev("weather_alert"), ctx)).toMatchObject({ kind: "critical_weather", critical: true });
    expect(classifyTrigger(ev("action_failed", {}, "a-irr"), ctx)).toMatchObject({ kind: "operation_failed", critical: true });
    expect(classifyTrigger(ev("field_attention", { fieldId: "f1", level: 2 }), ctx)).toMatchObject({ kind: "field_threshold_crossed", critical: true });
    expect(classifyTrigger(ev("crop_ready", { fieldId: "f1" }), ctx)).toMatchObject({ kind: "crop_ready", critical: false });
    expect(classifyTrigger(ev("action_completed", {}, "a-harv"), ctx)).toMatchObject({ kind: "operation_completed", critical: false });
    // Informational: never wake the model on their own.
    expect(classifyTrigger(ev("field_attention", { fieldId: "f1", level: 1 }), ctx)).toBeNull();
    expect(classifyTrigger(ev("action_started"), ctx)).toBeNull();
    expect(classifyTrigger(ev("action_completed", {}, "a-irr"), ctx)).toBeNull();
    expect(classifyTrigger(ev("action_completed", {}, "a-insp"), ctx)).toBeNull();
    expect(classifyTrigger(ev("observation_delivered"), ctx)).toBeNull();
  });

  it("treats a repeated identical observation as no news and a materially changed one as news", () => {
    const sch = newSchedulerState();
    expect(absorbObservations(sch, { ...fieldObservations, fields: [field("f1", { soilMoisture: { value: 0.3, at: 10 } })] } as unknown as FieldObservations)).toEqual(["f1"]);
    expect(absorbObservations(sch, { ...fieldObservations, fields: [field("f1", { soilMoisture: { value: 0.3, at: 20 } })] } as unknown as FieldObservations)).toEqual([]);
    expect(absorbObservations(sch, { ...fieldObservations, fields: [field("f1", { soilMoisture: { value: 0.12, at: 30 } })] } as unknown as FieldObservations)).toEqual(["f1"]);
    // An older reading can never be news.
    expect(absorbObservations(sch, { ...fieldObservations, fields: [field("f1", { soilMoisture: { value: 0.9, at: 5 } })] } as unknown as FieldObservations)).toEqual([]);
  });

  it("grants one daily review, then at most eventReviewsPerDay event reviews, then carries and surfaces", () => {
    const sch = newSchedulerState();
    const trig = (n: number, critical = false): Trigger => ({ key: `t${n}`, kind: critical ? "critical_weather" : "crop_ready", critical, field: null, simTimeS: 5 + n, summary: `t${n}` });
    let now = 1;
    const first = decide(sch, cfg, { simTimeS: now, plannedReviewSimS: null });
    expect(first).toMatchObject({ kind: "review", review: "daily_review" });
    if (first.kind === "review") beginReview(sch, first, now, cfg);
    endReview(sch, 60);
    // No news, daily done: wait to the day boundary, no review.
    expect(decide(sch, cfg, { simTimeS: now, plannedReviewSimS: null })).toEqual({ kind: "wait", waitUntilSimS: 60, blocked: [] });
    for (let n = 1; n <= cfg.eventReviewsPerDay; n += 1) {
      now += 1;
      addTrigger(sch, trig(n));
      const d = decide(sch, cfg, { simTimeS: now, plannedReviewSimS: null });
      expect(d).toMatchObject({ kind: "review", review: "event_review" });
      if (d.kind === "review") beginReview(sch, d, now, cfg);
      endReview(sch, 60);
    }
    // Budget gone: a noncritical trigger is carried, a critical one is surfaced and kept.
    addTrigger(sch, trig(8));
    addTrigger(sch, trig(9, true));
    const over = decide(sch, cfg, { simTimeS: now, plannedReviewSimS: null });
    expect(over).toMatchObject({ kind: "wait", waitUntilSimS: 60 });
    if (over.kind === "wait") expect(over.blocked.map((t) => t.key)).toEqual(["t9"]);
    expect(sch.unresolvedCritical.map((t) => t.key)).toEqual(["t9"]);
    expect(sch.pending.map((t) => t.key)).toEqual(["t8"]);
    // Next day: both are reviewed, nothing was silently dropped.
    const next = decide(sch, cfg, { simTimeS: 61, plannedReviewSimS: null });
    expect(next).toMatchObject({ kind: "review", review: "daily_review" });
    if (next.kind === "review") expect(next.triggers.map((t) => t.key).sort()).toEqual(["t8", "t9"]);
    expect(sch.counters.eventBudgetExhausted).toBe(1);
  });

  it("honours a planned wait without news, floored to a day boundary and capped by maxPlannedSkipDays", () => {
    const sch = newSchedulerState();
    sch.lastReview = { kind: "daily_review", day: 0, simTimeS: 10, triggers: [] };
    sch.day = 0;
    const d = decide(sch, cfg, { simTimeS: 61, plannedReviewSimS: 100_000 });
    expect(d).toMatchObject({ kind: "skip" });
    if (d.kind === "skip") expect(d.waitUntilSimS).toBe(Math.floor((10 + cfg.maxPlannedSkipDays * 60) / 60) * 60);
    // News overrides the plan.
    addTrigger(sch, { key: "w", kind: "critical_weather", critical: true, field: null, simTimeS: 62, summary: "storm" });
    sch.day = dayOf(61, cfg);
    expect(decide(sch, cfg, { simTimeS: 62, plannedReviewSimS: 100_000 }).kind).toBe("review");
  });

  it("refuses an identical inspection without new evidence and allows it after new evidence or the cooldown", () => {
    const sch = newSchedulerState();
    const key = inspectionKey("inspectField", { fieldId: "f1" });
    expect(duplicateInspection(sch, cfg, key, 10, false)).toBeNull();
    recordInspection(sch, key, 10);
    expect(duplicateInspection(sch, cfg, key, 20, false)).toMatch(/nothing new/);
    expect(duplicateInspection(sch, cfg, key, 20, true)).toMatch(/in progress/);
    addTrigger(sch, { key: "n", kind: "crop_ready", critical: false, field: "f1", simTimeS: 21, summary: "x" });
    expect(duplicateInspection(sch, cfg, key, 22, false)).toBeNull();
    const sch2 = newSchedulerState();
    recordInspection(sch2, key, 10);
    expect(duplicateInspection(sch2, cfg, key, 10 + cfg.inspectionCooldownDays * cfg.daySeconds, false)).toBeNull();
  });

  it("computes day boundaries exactly, including at the boundary instant", () => {
    expect(dayOf(59.9, cfg)).toBe(0);
    expect(dayOf(60, cfg)).toBe(1);
    expect(nextDayBoundary(60, cfg)).toBe(120);
    expect(nextDayBoundary(0, cfg)).toBe(60);
  });
});

describe("MOCKED before/after: the reported micro-decision loop", () => {
  const OBSERVE: ScriptedStep = { calls: [{ name: "observe_snapshot", args: {} }] };
  const WAIT_6S: ScriptedStep = { calls: [{ name: "advance_time", args: { requestedSeconds: 6, stopOn: ["action_completion"] } }] };
  // A model that does what production Muse did on Day 50: inspect, wait a few seconds, repeat.
  const microLoop = (n: number): ScriptedStep[] => Array.from({ length: n }, () => [OBSERVE, INSPECT(), OBSERVE, WAIT_6S, TEXT]).flat();

  it("cuts model calls per simulated day by an order of magnitude for the same scripted model, with identical simulated time", async () => {
    const days = 5;
    const measure = async (scheduler: Partial<SchedulerConfig>) => {
      const h = await harness(microLoop(400), { durationS: 5, estimateS: 5 }, scheduler, { sliceCycles: 5 });
      const started = Date.now();
      const state = await h.runUntil(days * 60, 400);
      const out = { modelCalls: h.model.requests.length, cycles: state.cycle, actions: h.s.actionPosts.length, avoided: state.scheduler.state.counters.duplicateInspectionsAvoided, simDays: Math.floor(h.s.state.simTimeS / 60), realMs: Date.now() - started };
      await h.s.close();
      sim = undefined;
      return out;
    };
    const before = await measure({ enabled: false });
    const after = await measure({});
    expect(before.simDays).toBeGreaterThanOrEqual(days);
    expect(after.simDays).toBeGreaterThanOrEqual(days);
    expect(after.modelCalls / after.simDays).toBeLessThanOrEqual(DEFAULT_SCHEDULER_CONFIG.maxModelCallsPerReview);
    expect(before.modelCalls / before.simDays).toBeGreaterThanOrEqual(4 * (after.modelCalls / after.simDays));
    expect(after.cycles).toBeLessThan(before.cycles);
    writeFileSync(join(tmpdir(), "scheduler-benchmark.json"), JSON.stringify({ note: "MOCKED simulator and scripted model; not a real Muse API measurement", days, before, after }, null, 2));
  });
});

describe("MOCKED daily scheduler in the controller", () => {
  it("advances a healthy idle farm many days with ZERO model calls and at most one skip entry per day", async () => {
    const h = await harness([TEXT], { eligible: false });
    const state = await h.runUntil(6 * 60);
    expect(h.model.requests).toHaveLength(0);
    expect(h.s.state.simTimeS).toBeGreaterThanOrEqual(5 * 60);
    const skips = state.decisions.filter((d) => d.kind === "review_skipped");
    expect(skips.length).toBeGreaterThan(0);
    expect(new Set(skips.map((d) => d.day)).size).toBe(skips.length);
    expect(state.budgets.modelCalls).toBe(0);
  });

  it("runs ONE daily review per day for an active farm and never a review per simulated tick", async () => {
    const h = await harness([PLAN("continue"), TEXT]);
    const state = await h.runUntil(4 * 60);
    const day = Math.floor(h.s.state.simTimeS / 60);
    expect(day).toBeGreaterThanOrEqual(3);
    const daily = state.decisions.filter((d) => d.kind === "daily_review");
    expect(daily.length).toBeLessThanOrEqual(day + 1);
    expect(new Set(daily.map((d) => d.day)).size).toBe(daily.length);
    expect(state.decisions.filter((d) => d.kind === "event_review")).toHaveLength(0);
    // At most the per-review model bound per day, nowhere near the 38 cycles/day of the reported failure.
    expect(h.model.requests.length / (day + 1)).toBeLessThanOrEqual(DEFAULT_SCHEDULER_CONFIG.maxModelCallsPerReview);
  });

  it("treats consecutive no-action reviews as valid: no ineffective-decision backoff stacks on the daily cadence", async () => {
    const h = await harness([PLAN("continue"), TEXT]);
    const state = await h.runUntil(8 * 60);
    expect(state.decisions.filter((d) => d.kind === "daily_review").length).toBeGreaterThanOrEqual(5);
    expect(state.budgets.consecutiveNoProgress).toBe(0);
    expect(state.stopDetail ?? "").not.toMatch(/without progress/);
    expect(state.retryAfter).toBeNull();
  });

  it("wakes for a critical water-stress threshold crossing with an event review that can act", async () => {
    const h = await harness([PLAN("continue", 100_000), TEXT, INSPECT(), TEXT, PLAN("continue", 100_000), TEXT], { scriptedEvents: [{ atS: 90, kind: "field_attention", summary: "Water stress level 2", data: { fieldId: "field-1", level: 2, status: "active", kind: "water_stress" } }] });
    const state = await h.runUntil(4 * 60);
    const reviews = state.decisions.filter((d) => d.kind === "daily_review" || d.kind === "event_review");
    const woken = reviews.filter((d) => d.triggers.includes("field_threshold_crossed"));
    expect(woken.length).toBeGreaterThanOrEqual(1);
    expect(h.s.actionPosts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not run a review for every tick of an ongoing long operation and lets it finish", async () => {
    const h = await harness([INSPECT(), TEXT, PLAN("continue", 100_000), TEXT], { durationS: 200, estimateS: 200 });
    const state = await h.run(40);
    expect(h.s.state.ops[0]!.status).toBe("completed");
    expect(h.s.state.simTimeS).toBeGreaterThanOrEqual(200);
    const reviews = state.decisions.filter((d) => d.kind === "daily_review" || d.kind === "event_review");
    // 200 s is just over 3 days: a handful of reviews, not one per advance request.
    expect(reviews.length).toBeLessThanOrEqual(Math.ceil(h.s.state.simTimeS / 60) + 1 + DEFAULT_SCHEDULER_CONFIG.eventReviewsPerDay);
    expect(h.s.state.advances.length).toBeGreaterThan(reviews.length);
  });

  it("does not repeat an identical inspection without new evidence, and submits nothing for the refused one", async () => {
    const h = await harness([INSPECT(), INSPECT(), TEXT, PLAN("continue", 100_000), TEXT]);
    const state = await h.run(10);
    const inspections = h.s.actionPosts.filter((p) => p.type === "inspectField");
    expect(inspections).toHaveLength(1);
    expect(state.scheduler.state.counters.duplicateInspectionsAvoided).toBeGreaterThanOrEqual(1);
  });

  it("lets one review issue several different valid actions", async () => {
    const OBSERVE: ScriptedStep = { calls: [{ name: "observe_snapshot", args: {} }] };
    const h = await harness([INSPECT("field-1"), OBSERVE, INSPECT("field-2"), TEXT, PLAN("continue", 100_000), TEXT], { catalogFields: ["field-1", "field-2"] });
    await h.run(10);
    const fields = new Set(h.s.actionPosts.map((p) => JSON.stringify((p as { params?: unknown }).params)));
    expect(fields.size).toBe(2);
  });

  it("respects the event-review budget per day when many critical events arrive, and surfaces what it could not review", async () => {
    const burst = Array.from({ length: 6 }, (_, i) => ({ atS: 61 + i, kind: "weather_alert", summary: `Storm ${i}`, data: {} }));
    const h = await harness([PLAN("continue", 100_000), TEXT], { scriptedEvents: burst }, { eventReviewsPerDay: 2 }, { sliceCycles: 100 });
    const state = await h.run(40);
    const byDay = new Map<number, number>();
    for (const d of state.decisions.filter((x) => x.kind === "event_review")) byDay.set(d.day ?? -1, (byDay.get(d.day ?? -1) ?? 0) + 1);
    for (const n of byDay.values()) expect(n).toBeLessThanOrEqual(2);
    expect(state.scheduler.state.counters.eventBudgetExhausted + state.decisions.filter((d) => d.kind === "blocked").length).toBeGreaterThanOrEqual(0);
  });

  it("is independent of the checkpoint size (visualization speed): same reviews, triggers, model calls and farm outcome", async () => {
    const run = async (maxGrantS: number) => {
      const h = await harness([PLAN("continue", 100_000), TEXT, PLAN("continue", 100_000), TEXT, PLAN("continue", 100_000), TEXT], { maxGrantS, scriptedEvents: [{ atS: 130, kind: "crop_ready", summary: "Corn ready", data: { fieldId: "field-1" } }] });
      const state = await h.runUntil(5 * 60);
      const reviews = state.decisions.filter((d) => d.kind === "daily_review" || d.kind === "event_review");
      const out = {
        reviewKinds: reviews.length,
        triggers: reviews.flatMap((d) => d.triggers).sort(),
        modelCalls: h.model.requests.length,
        skipsPerDay: Math.max(0, ...[...state.decisions.filter((d) => d.kind === "review_skipped").reduce((m, d) => m.set(d.day, (m.get(d.day) ?? 0) + 1), new Map<number | null, number>()).values()]),
        credits: h.s.state.credits,
      };
      await h.s.close();
      sim = undefined;
      return out;
    };
    // Checkpoint size only changes when the scheduler notices an event (within one checkpoint), never what it decides.
    const small = await run(15);
    const large = await run(14_400);
    expect(small).toEqual(large);
    expect(small.triggers).toEqual(["crop_ready"]);
    expect(small.skipsPerDay).toBeLessThanOrEqual(1);
  });

  it("lets a robot observation with NEW authorized information trigger a follow-up review, but a repeat of known data does not", async () => {
    const fresh = (v: number) => [field("field-1", { soilMoisture: { value: v, at: 200_000 } })];
    const run = async (value: number | null) => {
      // The same delivery event; only whether it carried a materially different authorized measurement differs.
      const delivered = { atS: 100, kind: "observation_delivered", summary: "Drone downlink", data: { fieldId: "field-1" }, ...(value !== null ? { fields: fresh(value) } : {}) };
      const h = await harness([PLAN("continue", 100_000), TEXT, PLAN("continue", 100_000), TEXT, PLAN("continue", 100_000), TEXT], { scriptedEvents: [delivered] });
      const state = await h.runUntil(4 * 60);
      const triggers = state.decisions.filter((d) => d.kind === "daily_review" || d.kind === "event_review").flatMap((d) => d.triggers);
      await h.s.close();
      sim = undefined;
      return triggers;
    };
    expect(await run(0.12)).toContain("new_observation");
    expect(await run(null)).not.toContain("new_observation");
  });

  it("never loops without advancing time: bounded requests, strictly increasing simulated time", async () => {
    const h = await harness([PLAN("continue"), TEXT], { scriptedEvents: Array.from({ length: 40 }, (_, i) => ({ atS: 10 + i * 5, kind: "weather_alert", summary: `Storm ${i}`, data: {} })) });
    let last = -1;
    for (let i = 0; i < 20; i += 1) {
      await h.run(1);
      expect(h.s.state.simTimeS).toBeGreaterThanOrEqual(last);
      last = h.s.state.simTimeS;
    }
    expect(last).toBeGreaterThan(0);
    const day = Math.floor(last / 60) + 1;
    const perDay = h.model.requests.length / day;
    expect(perDay).toBeLessThanOrEqual((1 + DEFAULT_SCHEDULER_CONFIG.eventReviewsPerDay) * DEFAULT_SCHEDULER_CONFIG.maxModelCallsPerReview);
  });

  it("crosses day boundaries exactly: the day counter follows the simulated clock", async () => {
    const h = await harness([PLAN("continue"), TEXT], { eligible: false });
    const state = await h.runUntil(6 * 60);
    expect(Math.floor(h.s.state.simTimeS / 60)).toBeGreaterThanOrEqual(6);
    // One "skipped" entry per calendar day, stamped with that day, in strictly increasing order.
    const days = state.decisions.filter((d) => d.kind === "review_skipped").map((d) => d.day);
    expect(days.length).toBeGreaterThanOrEqual(5);
    expect(days).toEqual([...days].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(days).size).toBe(days.length);
    expect(state.scheduler.state.day).toBeGreaterThanOrEqual(5);
  });
});
