// Real-integration check for the packaged library. Run from a project that installed the tarball:
//   node check.mjs <setup|observe|mutate-create|slice|status|control> [args]
// Uses a real simulator (SIM_URL), a real PostgreSQL database (DATABASE_URL) and the real Meta API (MODEL_API_KEY).
// Secrets come from the environment / a local secrets file; nothing is printed except sanitized summaries.
import { readFileSync } from "node:fs";
import pg from "pg";
import { PostgresSessionStore, getSessionReport, runWorkerOnce, startSession } from "agrogenesis-muse-agent";

const [phase, arg] = process.argv.slice(2);
const secrets = JSON.parse(readFileSync(process.env.P6A_SECRETS, "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const backend = new PostgresSessionStore(pool, { leaseTtlMs: 60_000 });
const readOnly = phase === "observe";

const deps = {
  backend,
  simulator: { baseUrl: process.env.SIM_URL, agentToken: readOnly ? secrets.observeToken : secrets.actToken },
  model: {
    apiKey: process.env.MODEL_API_KEY,
    modelId: process.env.MODEL_ID,
    baseUrl: process.env.MODEL_BASE_URL,
    maxCostPerRequestUsd: 0.05,
    maxSessionCostUsd: 0.25,
  },
};
const summary = (state) => ({
  sessionId: state.sessionId,
  status: state.status,
  stopReason: state.stopReason,
  cycle: state.cycle,
  mutationsEnabled: state.config.mutationsEnabled,
  budgets: { modelCalls: state.budgets.modelCalls, costUsd: Number(state.budgets.costUsd.toFixed(4)), acceptedMutations: state.budgets.acceptedMutations, advanceRequests: state.budgets.advanceRequests, advancedSimSeconds: state.budgets.advancedSimSeconds },
  actions: state.actions.map((a) => ({ actionId: a.actionId, type: a.type, status: a.status, idempotencyKey: a.idempotencyKey })),
});

try {
  if (phase === "setup") {
    console.log(JSON.stringify({ applied: await backend.migrate(), appliedAgain: await backend.migrate() }));
  } else if (phase === "observe") {
    const sessionId = arg ?? `p6a-observe-${Date.now()}`;
    await startSession(deps, { gameId: secrets.gameId, sessionId, limits: { maxCostUsd: 0.1, maxModelCalls: 6 } });
    await backend.requestControl(sessionId, "run");
    const events = [];
    await runWorkerOnce({ deps, mutationsAllowed: false, onEvent: (e) => events.push(e) });
    console.log(JSON.stringify({ events, ...summary(await backend.load(sessionId)), control: await backend.getControl(sessionId) }));
  } else if (phase === "mutate-create") {
    const sessionId = arg;
    const state = await startSession(deps, {
      gameId: secrets.gameId,
      sessionId,
      mutationsEnabled: true,
      planningHorizonDays: 200,
      limits: { maxCostUsd: 0.4, maxMutations: 3, maxModelCalls: 18, maxSimSeconds: 172_800, maxFarmSpendCredits: 500 },
    });
    await backend.requestControl(sessionId, "run");
    console.log(JSON.stringify({ created: summary(state), control: await backend.getControl(sessionId) }));
  } else if (phase === "slice") {
    const events = [];
    const slices = await runWorkerOnce({ deps, mutationsAllowed: true, sliceCycles: Number(process.argv[4] ?? 2), onEvent: (e) => events.push(e) });
    console.log(JSON.stringify({ pid: process.pid, slices, events: events.map((e) => ({ ...e })) }));
  } else if (phase === "status") {
    const state = await backend.load(arg);
    console.log(JSON.stringify({ ...summary(state), control: await backend.getControl(arg), report: Object.keys(await getSessionReport(backend, arg)) }));
  } else if (phase === "control") {
    console.log(JSON.stringify({ ok: await backend.requestControl(arg, process.argv[4]) }));
  } else {
    throw new Error("unknown phase");
  }
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/g, "***").slice(0, 400) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
