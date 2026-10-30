import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, IncompatibleSessionError, newSessionState } from "../src/index.js";
import { SessionState } from "../src/autonomy/types.js";

/** Regression: baseline-run records and damaged files share the sessions directory and must not break unrelated sessions. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-legacy-"));
  dirs.push(root);
  const store = new FileSessionStore(root);
  store.create(newSessionState({ sessionId: "good", gameId: "game-1", modelId: "muse-spark-1.3", mutationsEnabled: false }));
  const baseline = JSON.stringify({ version: 1, runId: "p5a-baseline", strategy: "baseline", gameId: "g", config: {}, limits: {} });
  mkdirSync(join(root, "p5a-baseline"));
  writeFileSync(join(root, "p5a-baseline", "state.json"), baseline);
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "state.json"), "{not json");
  mkdirSync(join(root, "future"));
  writeFileSync(join(root, "future", "state.json"), JSON.stringify({ version: 2, sessionId: "future" }));
  return { root, store, baseline };
}

describe("incompatible persisted sessions (file store)", () => {
  it("lists readable sessions, reports the rest with a reason, and never throws a ZodError", () => {
    const { store } = setup();
    expect(store.list().map((s) => s.sessionId)).toEqual(["good"]);
    const skipped = store.listIncompatible();
    expect(skipped.map((s) => s.sessionId).sort()).toEqual(["broken", "future", "p5a-baseline"]);
    expect(skipped.find((s) => s.sessionId === "future")?.reason).toContain("version 2");
  });

  it("load() raises a clear IncompatibleSessionError and unrelated sessions stay usable", () => {
    const { store } = setup();
    expect(() => store.load("p5a-baseline")).toThrow(IncompatibleSessionError);
    expect(() => store.load("broken")).toThrow(/not valid JSON/);
    expect(store.load("good").sessionId).toBe("good");
  });

  it("never modifies or deletes incompatible files", () => {
    const { root, store, baseline } = setup();
    store.list();
    store.listIncompatible();
    expect(readFileSync(join(root, "p5a-baseline", "state.json"), "utf8")).toBe(baseline);
    expect(readFileSync(join(root, "broken", "state.json"), "utf8")).toBe("{not json");
  });
});

describe("sessions persisted before the inspection budget existed", () => {
  it("loads with zero accrued inspection usage and the conservative default inspection budget", () => {
    const fresh = newSessionState({ sessionId: "old", gameId: "game-1", modelId: "muse-spark-1.3", mutationsEnabled: true, limits: { maxCostUsd: 1, maxMutations: 3, maxModelCalls: 20, maxSimSeconds: 600 } });
    const legacyJson = JSON.parse(JSON.stringify(fresh)) as Record<string, any>;
    delete legacyJson.config.limits.maxInspections;
    delete legacyJson.budgets.acceptedInspections;
    delete legacyJson.budgets.inspectionAttempts;
    delete legacyJson.budgets.rejectedInspections;
    const parsed = SessionState.parse(legacyJson);
    expect(parsed.config.limits.maxInspections).toBe(3);
    expect(parsed.budgets).toMatchObject({ acceptedInspections: 0, inspectionAttempts: 0, rejectedInspections: 0 });
  });
});
