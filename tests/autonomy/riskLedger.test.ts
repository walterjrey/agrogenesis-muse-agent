import { describe, expect, it } from "vitest";
import type { FieldObservations } from "../../src/contracts/fieldObservations.js";
import { compactFields } from "../../src/autonomy/compactObservation.js";
import { AUTONOMOUS_SYSTEM_PROMPT } from "../../src/autonomy/prompt.js";
import { attentionQueue, dueReviews, refreshLedger, reviewAtCheckpoint, RiskLedger, type LedgerInput } from "../../src/autonomy/riskLedger.js";
import { SessionState } from "../../src/autonomy/types.js";
import { superviseInterval, type SupervisorDeps } from "../../src/autonomy/supervisor.js";

const DAY = 60;
type Spec = { id: string; alert?: { level: 1 | 2 | 3; since: number }; pest?: { v: number; at: number; sensor?: string }; health?: { v: number; at: number; sensor?: string } };

function fields(simTimeS: number, specs: Spec[]): FieldObservations {
  const meas = (name: string, m: { v: number; at: number; sensor?: string }) => [name, { value: m.v, unit: "fraction", uncertainty: 0.02, observedAtSimTimeS: m.at, ageS: simTimeS - m.at, freshness: "fresh" as const, confidence: 0.9, sensorType: m.sensor ?? "remote_inspection", coverage: 1 }] as const;
  return {
    gameId: "g",
    revision: 1,
    simTimeS,
    fields: specs.map((s) => ({
      fieldId: s.id,
      label: s.id,
      areaHa: 1,
      knownCrop: null,
      knownGrowthStage: null,
      measurements: Object.fromEntries([...(s.pest ? [meas("pestPressure", s.pest)] : []), ...(s.health ? [meas("cropHealth", s.health)] : [])]),
      lastObservedAtSimTimeS: null,
      missing: [],
      activeOperationActionId: null,
      attention: s.alert ? [{ alertId: `a-${s.id}`, category: "pest_outbreak", level: s.alert.level, sinceSimTimeS: s.alert.since, status: "active" as const }] : [],
    })),
  } as FieldObservations;
}

const state = (actions: LedgerInput["actions"] = []): LedgerInput => ({ riskLedger: {}, actions });
const treated = (target: string, at: number) => ({ type: "applyTreatment", status: "completed", target, finishedAtS: at });

describe("persistent Level-1 alert review", () => {
  it("does not wake before 3 simulated days, wakes at 3, and then at most once per simulated day per field", () => {
    const s = state();
    for (const day of [0, 1, 2.9]) {
      refreshLedger(s, fields(day * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }]));
      expect(dueReviews(s, day * DAY)).toEqual([]);
    }
    refreshLedger(s, fields(3 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }]));
    expect(dueReviews(s, 3 * DAY)).toEqual([{ fieldId: "f1", reason: "persistent_alert" }]);
    refreshLedger(s, fields(3.5 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }]));
    expect(dueReviews(s, 3.5 * DAY)).toEqual([]);
    expect(dueReviews(s, 3.99 * DAY)).toEqual([]);
    expect(dueReviews(s, 4 * DAY)).toEqual([{ fieldId: "f1", reason: "persistent_alert" }]);
  });

  it("throttles per field, not globally", () => {
    const s = state();
    refreshLedger(s, fields(3 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }, { id: "f2", alert: { level: 1, since: 0 } }]));
    expect(dueReviews(s, 3 * DAY).map((d) => d.fieldId).sort()).toEqual(["f1", "f2"]);
    refreshLedger(s, fields(3.5 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }, { id: "f2", alert: { level: 1, since: 3.4 * DAY } }]));
    // f2 re-alerted: a new alert is a new condition, f1 stays capped.
    expect(dueReviews(s, 3.5 * DAY)).toEqual([]);
  });

  it("leaves Level-2+ alerts to the simulator's own immediate event (no ledger wake, no cap)", () => {
    const s = state();
    refreshLedger(s, fields(10 * DAY, [{ id: "f1", alert: { level: 2, since: 0 } }]));
    expect(dueReviews(s, 10 * DAY)).toEqual([]);
  });

  it("clears the alert when the condition resolves but keeps treatment history", () => {
    const s = state([treated("f1", 5 * DAY)]);
    refreshLedger(s, fields(5.5 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }]));
    refreshLedger(s, fields(9 * DAY, [{ id: "f1" }]));
    const risk = s.riskLedger.f1!;
    expect(risk).toMatchObject({ alertLevel: null, alertSinceS: null, treatments: 1, lastTreatmentAtS: 5 * DAY });
    expect(attentionQueue(s, 9 * DAY).find((e) => e.alert)).toBeUndefined();
  });
});

describe("treatment follow-up and outcome verification", () => {
  it("schedules one follow-up 1 day after a completed treatment and does not assume the outbreak ended", () => {
    const s = state([treated("f1", 10 * DAY)]);
    refreshLedger(s, fields(10.2 * DAY, [{ id: "f1", alert: { level: 1, since: 8 * DAY } }]));
    expect(dueReviews(s, 10.2 * DAY)).toEqual([]);
    expect(dueReviews(s, 11 * DAY)).toEqual([{ fieldId: "f1", reason: "treatment_follow_up" }]);
    expect(attentionQueue(s, 11 * DAY)[0]).toMatchObject({ id: "f1", treated: { count: 1, outcomeChecked: true } });
  });

  it("stays pending in the queue until an authorized observation taken after the treatment settles it", () => {
    const s = state([treated("f1", 10 * DAY)]);
    refreshLedger(s, fields(10.1 * DAY, [{ id: "f1", alert: { level: 1, since: 8 * DAY }, pest: { v: 0.4, at: 9 * DAY } }]));
    expect(attentionQueue(s, 10.1 * DAY)[0]).toMatchObject({ why: "treated_awaiting_outcome_check", treated: { outcomeChecked: false } });
    refreshLedger(s, fields(11 * DAY, [{ id: "f1", alert: { level: 1, since: 8 * DAY }, pest: { v: 0.3, at: 10.8 * DAY, sensor: "pest_scout" } }]));
    const entry = attentionQueue(s, 11 * DAY)[0]!;
    expect(entry.treated?.outcomeChecked).toBe(true);
    expect(entry.lastKnown?.pestPressure).toMatchObject({ v: 0.3, trend: "down", sensor: "rover" });
  });

  it("never creates or repeats an action: the ledger only reports", () => {
    const actions = [treated("f1", 10 * DAY)];
    const s = state(actions);
    refreshLedger(s, fields(20 * DAY, [{ id: "f1", alert: { level: 1, since: 8 * DAY } }]));
    dueReviews(s, 20 * DAY);
    expect(actions).toHaveLength(1);
  });

  it("ignores treatments too old to be a follow-up (sessions predating the ledger)", () => {
    const s = state([treated("f1", 1 * DAY)]);
    refreshLedger(s, fields(40 * DAY, [{ id: "f1" }]));
    expect(dueReviews(s, 40 * DAY)).toEqual([]);
  });
});

describe("early deterioration", () => {
  it("wakes before the 3-day threshold when authorized observations show substantial worsening, once per observation", () => {
    const s = state();
    refreshLedger(s, fields(1 * DAY, [{ id: "f1", alert: { level: 1, since: 0.5 * DAY }, pest: { v: 0.3, at: 1 * DAY }, health: { v: 0.9, at: 1 * DAY } }]));
    expect(dueReviews(s, 1 * DAY)).toEqual([]);
    refreshLedger(s, fields(1.5 * DAY, [{ id: "f1", alert: { level: 1, since: 0.5 * DAY }, pest: { v: 0.45, at: 1.5 * DAY }, health: { v: 0.8, at: 1.5 * DAY } }]));
    expect(dueReviews(s, 1.5 * DAY)).toEqual([{ fieldId: "f1", reason: "worsening_observed" }]);
    expect(dueReviews(s, 2.6 * DAY)).toEqual([]);
    expect(dueReviews(s, 3.5 * DAY)).toEqual([{ fieldId: "f1", reason: "persistent_alert" }]);
  });
});

describe("cross-field prioritization and fog-of-war", () => {
  const specs: Spec[] = [
    { id: "f1", alert: { level: 1, since: 0 }, pest: { v: 0.31, at: 2.9 * DAY } },
    { id: "f2", alert: { level: 1, since: 1 * DAY } },
    { id: "f3" },
  ];

  it("ranks untreated persistent alerts above a treated field that was just inspected, and omits healthy fields", () => {
    const s = state([treated("f1", 2 * DAY)]);
    refreshLedger(s, fields(3 * DAY, specs));
    const queue = attentionQueue(s, 3 * DAY);
    expect(queue.map((e) => e.id)).toEqual(["f2", "f1"]);
    expect(queue[0]).toMatchObject({ why: "untreated_alert" });
  });

  it("does not let one just-inspected field dominate while another equally old alert is untouched", () => {
    const s = state();
    refreshLedger(s, fields(3 * DAY, [{ id: "f1", alert: { level: 1, since: 0 }, pest: { v: 0.3, at: 2.95 * DAY } }, { id: "f2", alert: { level: 1, since: 0 } }]));
    expect(attentionQueue(s, 3 * DAY).map((e) => e.id)).toEqual(["f2", "f1"]);
  });

  it("only reports readings that came from authorized observations, labelled last-known with age and sensor", () => {
    const s = state();
    refreshLedger(s, fields(3 * DAY, specs));
    const queue = attentionQueue(s, 3 * DAY);
    expect(queue.find((e) => e.id === "f2")?.lastKnown).toBeUndefined();
    expect(queue.find((e) => e.id === "f1")?.lastKnown?.pestPressure).toEqual({ v: 0.31, daysAgo: 0.1, trend: null, sensor: "inspectField" });
    expect(JSON.stringify(s.riskLedger)).not.toMatch(/damage|yield|hidden/i);
  });
});

describe("checkpoint review is read-only and model-free", () => {
  it("returns a reason only when due and never needs more than one field read", async () => {
    let reads = 0;
    const client = { getFieldObservations: async () => { reads += 1; return fields(3 * DAY, [{ id: "f1", alert: { level: 1, since: 0 } }]); } };
    const s = state();
    expect(await reviewAtCheckpoint(client, "g", s)).toMatch(/f1 persistent_alert/);
    expect(await reviewAtCheckpoint(client, "g", s)).toBeNull();
    expect(reads).toBe(2);
  });

  it("hands control back from a supervised wait without a model call, and only at the due checkpoint", async () => {
    let now = 0;
    let advances = 0;
    const s = state();
    const deps = {
      client: {
        getFarmOverview: async () => ({ revision: 1, clock: { simTimeS: now } }),
        advance: async (_g: string, req: { requestedSeconds: number }) => { advances += 1; now += req.requestedSeconds; return { grantedSeconds: req.requestedSeconds, events: [], stoppedBecause: "requested_time_reached", revision: 1, nextCursor: 0, clockAfter: { simTimeS: now }, simTimeS: now }; },
      },
      gameId: "g",
      newMutationId: () => `k${advances}`,
      retryDelayMs: 0,
      maxMutationRetries: 0,
      budget: { requestsLeft: 1000, simSecondsLeft: 1e9, maxChunkSeconds: DAY, maxCallSeconds: DAY, conflictsLeft: 1 },
      getCursor: () => 0,
      setCursor: () => undefined,
      onAdvanced: () => undefined,
      checkpointReview: () => reviewAtCheckpoint({ getFieldObservations: async () => fields(now, [{ id: "f1", alert: { level: 1, since: 0 } }]) }, "g", s),
    } as unknown as SupervisorDeps;
    const result = await superviseInterval(deps, { maxSeconds: 30 * DAY, checkpointSeconds: DAY });
    expect(result.outcome).toBe("event_interrupt");
    expect(result.advancedSimDays).toBe(3);
    expect(result.detail).toMatch(/persistent_alert/);
    expect(advances).toBe(3);
  });
});

describe("ledger persistence across worker slices and restarts", () => {
  const reload = (s: LedgerInput): LedgerInput => ({ ...s, riskLedger: RiskLedger.parse(JSON.parse(JSON.stringify(s.riskLedger))) });

  it("keeps throttle, treatment history and last-known readings after a serialize/restart round trip, without hidden values", () => {
    let s = state([treated("f1", 0)]);
    refreshLedger(s, fields(4.2 * DAY, [{ id: "f1", alert: { level: 1, since: 0 }, pest: { v: 0.31, at: 4.1 * DAY } }]));
    expect(dueReviews(s, 4.2 * DAY).length).toBe(1);
    s = reload(s); // worker restart: only the persisted JSON survives
    refreshLedger(s, fields(4.6 * DAY, [{ id: "f1", alert: { level: 1, since: 0 }, pest: { v: 0.31, at: 4.1 * DAY } }]));
    expect(dueReviews(s, 4.6 * DAY)).toEqual([]); // same sim day: still throttled after restart
    expect(s.riskLedger.f1!.treatments).toBe(1);
    expect(attentionQueue(s, 4.6 * DAY)[0]!.lastKnown?.pestPressure?.v).toBe(0.31);
    expect(JSON.stringify(s.riskLedger)).not.toMatch(/damage|yield|hidden|currentPest/i);
  });

  it("does not wake the model for a persistent Level-1 alert while a fresh treatment settles", () => {
    const s = state([treated("f1", 3 * DAY)]);
    refreshLedger(s, fields(4.2 * DAY, [{ id: "f1", alert: { level: 1, since: 0 }, pest: { v: 0.31, at: 4.1 * DAY } }]));
    expect(dueReviews(s, 4.2 * DAY)).toEqual([]);
    expect(dueReviews(s, 7.5 * DAY).map((d) => d.reason)).toEqual(["persistent_alert"]);
  });

  it("loads sessions persisted before the ledger existed with an empty ledger", () => {
    expect(SessionState.shape.riskLedger.parse(undefined)).toEqual({});
  });
});

describe("persistent alerts, follow-ups and accelerated checkpoints together", () => {
  it("over 12 simulated days of hourly checkpoints with two persistent alerts and a treatment, wakes stay bounded (<= 1 per field per day)", async () => {
    let now = 0;
    const s = state();
    const client = { getFieldObservations: async () => fields(now, [{ id: "f1", alert: { level: 1, since: 0 } }, { id: "f2", alert: { level: 1, since: 0 } }]) };
    const wakes: string[] = [];
    let reads = 0;
    for (let hour = 1; hour <= 12 * 24; hour++) {
      now = (hour / 24) * DAY;
      if (hour === 4 * 24) s.actions = [treated("f1", now)] as LedgerInput["actions"];
      reads += 1;
      const reason = await reviewAtCheckpoint({ getFieldObservations: async () => { return client.getFieldObservations(); } }, "g", s);
      if (reason) wakes.push(reason);
    }
    expect(reads).toBe(288);
    // Two fields, days 3..12, plus one follow-up: strictly below one wake per checkpoint, and within the per-field daily cap.
    expect(wakes.length).toBeLessThanOrEqual(2 * 10 + 1);
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes.some((w) => /treatment_follow_up/.test(w))).toBe(true);
  });
});

describe("agent-visible robot guidance and geometry", () => {
  it("states robot limits (weather, battery, downlink, no data on failure) that match the simulator", () => {
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/wind or rain/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/battery and time instead of credits/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/downlink delay/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/failed or not-yet-delivered mission gives no data/);
  });

  it("describes what each robot can sense and keeps robot use optional", () => {
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/Scout drone: surveyField/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/cannot measure pest pressure/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/Ground rover: inspectPestPressure/);
    expect(AUTONOMOUS_SYSTEM_PROMPT).toMatch(/optional observation tools, never required/);
  });

  it("exposes parcel geometry compactly when provided and omits it otherwise", () => {
    const base = fields(0, [{ id: "f1" }]);
    expect(compactFields(base).fields[0]).not.toHaveProperty("geo");
    const withGeo = { ...base, fields: [{ ...base.fields[0]!, geometry: { centerX: 12.34, centerZ: -5.67, widthM: 40, depthM: 30 } }] } as FieldObservations;
    expect(compactFields(withGeo).fields[0]).toMatchObject({ geo: { x: 12.3, z: -5.7, w: 40, d: 30 } });
  });

  it("labels drone and rover readings with their own method so the agent can compare them", () => {
    const s = state();
    refreshLedger(s, fields(2 * DAY, [{ id: "f1", alert: { level: 1, since: 0 }, health: { v: 0.7, at: 1.9 * DAY, sensor: "visual_survey" }, pest: { v: 0.3, at: 1.95 * DAY, sensor: "pest_scout" } }]));
    const e = attentionQueue(s, 2 * DAY)[0]!;
    expect(e.lastKnown?.cropHealth?.sensor).toBe("drone");
    expect(e.lastKnown?.pestPressure?.sensor).toBe("rover");
  });
});
