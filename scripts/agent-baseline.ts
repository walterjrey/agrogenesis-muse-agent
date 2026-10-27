import { parseArgs } from "node:util";
import { loadDotEnv, numberEnv, requireEnv } from "../src/config.js";
import { BaselineRunner, BaselineStore, newBaselineState } from "../src/baseline/runner.js";
import { DEFAULT_BASELINE_CONFIG } from "../src/baseline/policy.js";
import { SimulatorClient } from "../src/simulator/client.js";
import { pacedApi } from "../src/baseline/paced.js";

/**
 *   npm run baseline:start  -- --game-id <id> [--run-id r] [--horizon-days 200] [--scenario-name n --scenario-seed N --initial-state-fingerprint sha]
 *   npm run baseline:resume -- --run-id <id>
 *   npm run baseline:status -- --run-id <id>
 *
 * The deterministic reference farmer. Uses the same authorized agent API and token scopes as the Muse agent,
 * never a model and never the simulator database. Credentials come from the environment only.
 */
loadDotEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "game-id": { type: "string" },
    "run-id": { type: "string" },
    "sessions-dir": { type: "string", default: "sessions" },
    "horizon-days": { type: "string" },
    "checkpoint-days": { type: "string" },
    "scenario-name": { type: "string" },
    "scenario-seed": { type: "string" },
    "initial-state-fingerprint": { type: "string" },
    "max-wall-minutes": { type: "string" },
  },
});
const fail = (message: string, code = 1): never => {
  console.error(JSON.stringify({ ok: false, error: message }));
  return process.exit(code);
};
const command = positionals[0];
if (command !== "start" && command !== "resume" && command !== "status") fail("Usage: agent-baseline <start|resume|status> [options]", 2);
const store = new BaselineStore(values["sessions-dir"] ?? "sessions");
const num = (name: string, raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fail(`Invalid --${name}: ${raw}`, 2);
};
const say = (m: string) => console.error(`[baseline] ${m}`);

const summary = (s: ReturnType<BaselineStore["load"]>) => ({
  runId: s.runId,
  strategy: s.strategy,
  gameId: s.gameId,
  status: s.status,
  stopReason: s.stopReason,
  config: s.config,
  scenario: s.scenario,
  startObservationSha256: s.startObservationSha256,
  counters: s.counters,
  wallClockSeconds: Math.round(s.wallClockMs / 1000),
  actionsByType: s.actions.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.type]: (acc[a.type] ?? 0) + 1 }), {}),
  startOutcome: s.startOutcome,
  finalOutcome: s.finalOutcome,
  comparison: s.comparison,
  modelCalls: 0,
  metaApiCostUsd: 0,
});

if (command === "status") {
  const id = values["run-id"] ?? fail("--run-id is required.", 2);
  console.log(JSON.stringify(summary(store.load(id as string)), null, 2));
  process.exit(0);
}

const client = pacedApi(new SimulatorClient({ baseUrl: requireEnv("SIMULATOR_BASE_URL"), agentToken: requireEnv("SIMULATOR_AGENT_TOKEN"), timeoutMs: numberEnv("SIMULATOR_TIMEOUT_MS", 15_000) }));
let state;
if (command === "start") {
  const gameId = values["game-id"]?.trim();
  if (!gameId) fail("--game-id is required (no game is ever chosen automatically).", 2);
  const horizon = num("horizon-days", values["horizon-days"]);
  const checkpoint = num("checkpoint-days", values["checkpoint-days"]);
  const wall = num("max-wall-minutes", values["max-wall-minutes"]);
  state = newBaselineState({
    ...(values["run-id"] ? { runId: values["run-id"] } : {}),
    gameId: gameId as string,
    config: { ...DEFAULT_BASELINE_CONFIG, ...(horizon !== undefined && { horizonDays: horizon }), ...(checkpoint !== undefined && { checkpointDays: checkpoint }) },
    ...(wall !== undefined && { limits: { maxWallClockMs: wall * 60_000 } }),
    scenario: { name: values["scenario-name"] ?? null, seed: values["scenario-seed"] ? Number(values["scenario-seed"]) : null, initialStateFingerprint: values["initial-state-fingerprint"] ?? null },
  });
  if (store.exists(state.runId)) fail(`Run ${state.runId} already exists; use baseline:resume.`, 2);
} else {
  const id = values["run-id"] ?? fail("--run-id is required.", 2);
  state = store.load(id as string);
  if (state.status === "stopped" && state.stopReason === "horizon_reached") fail("This run already reached its horizon.", 2);
}
const finished = await new BaselineRunner(client, store, say).run(state);
console.log(JSON.stringify(summary(finished), null, 2));
