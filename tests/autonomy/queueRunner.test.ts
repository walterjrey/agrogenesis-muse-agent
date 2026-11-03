import { describe, expect, it } from "vitest";
import { newSessionState } from "../../src/autonomy/controller.js";
import { planAndStore, drainQueue, type QueueRunnerDeps } from "../../src/autonomy/queueRunner.js";
import { SessionState } from "../../src/autonomy/types.js";
import { GAME_ID } from "../fixtures.js";

const NOW = 600;
const measure = (value: number) => ({ value, unit: "fraction", uncertainty: 0.03, observedAtSimTimeS: NOW - 10, ageS: 10, freshness: "fresh", confidence: 0.8, sensorType: "remote_inspection", coverage: 1 });
const fields = {
  gameId: GAME_ID, revision: 3, simTimeS: NOW,
  fields: [{ fieldId: "f1", label: "f1", areaHa: 4, knownCrop: null, knownGrowthStage: null, measurements: { soilMoisture: measure(0.4), pestPressure: measure(0.6) }, lastObservedAtSimTimeS: NOW - 10, missing: [], activeOperationActionId: null, soil: { capacityM3: 1700, fieldCapacityFraction: 0.8, wiltingPointFraction: 0.2 } }],
};

function rig(options: { failSend?: boolean } = {}) {
  const posts: Array<{ type: string; idempotencyKey?: string | undefined }> = [];
  const client = {
    getFarmOverview: async () => ({ revision: 3, clock: { simTimeS: NOW } }),
    getFieldObservations: async () => fields,
    executeAction: async (_g: string, req: { type: string; dryRun: boolean; params: Record<string, unknown>; idempotencyKey?: string }) => {
      if (req.dryRun) return { accepted: true, errors: [], estimate: { credits: req.type === "irrigateField" ? 5 + 0.1 * Number(req.params.volumeM3) : 25, waterM3: 0, durationS: 5 } };
      posts.push({ type: req.type, idempotencyKey: req.idempotencyKey });
      if (options.failSend) throw new Error("socket hang up");
      return { accepted: true, revision: 4, errors: [], action: { actionId: `act-${posts.length}`, status: "running", startedAtS: NOW, estimatedCompletionS: NOW + 5, finishedAtS: null, progress: 0, outcome: null, consumed: null } };
    },
  };
  const state = newSessionState({ sessionId: "r", gameId: GAME_ID, modelId: "mock", mutationsEnabled: true, scenario: { startSimTimeS: 0 } });
  let counter = 0;
  const deps = {
    client, gameId: GAME_ID, state,
    journal: { begin: async (intent: unknown) => { state.pendingMutation = { intent } as never; }, settle: async () => { state.pendingMutation = null; } },
    newMutationId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    retryDelayMs: 0, maxMutationRetries: 0, trace: { record: () => undefined },
    maySubmit: () => true, onOutcomeUnknown: () => undefined,
  } as unknown as QueueRunnerDeps;
  return { deps, posts, state };
}

const requests = [
  { fieldId: "f1", kind: "irrigate" as const, reason: "dry" },
  { fieldId: "f1", kind: "pest_treatment" as const, reason: "pests" },
];

describe("queue runner", () => {
  it("plans both operations from one observation and executes them in order, one at a time per field, with no inspection", async () => {
    const { deps, posts, state } = rig();
    const plan = await planAndStore(deps, fields as never, NOW, 5000, requests);
    expect(plan.queued).toHaveLength(2);
    await drainQueue(deps);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.type).toBe("applyTreatment");
    // The field is now busy: a second drain must not submit the other item, and must not resubmit the first.
    await drainQueue(deps);
    expect(posts).toHaveLength(1);
    expect(state.queue.filter((i) => i.status === "running")).toHaveLength(1);
    expect(state.queue.filter((i) => i.status === "queued")).toHaveLength(1);
  });

  it("survives a restart: the persisted queue and the unknown-outcome key are not executed twice", async () => {
    const { deps, posts, state } = rig({ failSend: true });
    await planAndStore(deps, fields as never, NOW, 5000, requests.slice(0, 1));
    const result = await drainQueue(deps);
    expect(result.locked).toBe(true);
    expect(posts).toHaveLength(1);
    const running = state.queue[0]!;
    expect(running.status).toBe("running");
    const key = running.idempotencyKey;
    expect(key).toBeTruthy();

    // Restart: reload from JSON. The item stays running with its key, and and a running item keeps its field busy, so it is never submitted again.
    const snapshot = JSON.parse(JSON.stringify({ ...state, pendingMutation: null }));
    const restored = SessionState.parse(snapshot);
    expect(restored.queue[0]!.idempotencyKey).toBe(key);
    const again = rig();
    again.deps.state.queue.push(...restored.queue);
    await drainQueue(again.deps);
    expect(again.posts).toHaveLength(0);
  });

  it("does not execute an item the budget gate forbids", async () => {
    const { deps, posts } = rig();
    await planAndStore(deps, fields as never, NOW, 5000, requests);
    deps.maySubmit = () => false;
    await drainQueue(deps);
    expect(posts).toHaveLength(0);
  });
});
