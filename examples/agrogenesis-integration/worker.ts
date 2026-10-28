// worker.ts: a long-lived Node process (Render Background Worker, or a second process in the same service).
// It runs bounded slices; all progress is persisted in PostgreSQL, so a restart or redeploy resumes safely.
import { SessionLockedError, runSessionSlice } from "agrogenesis-muse-agent";
import { agentDependencies } from "./lib/agent";

const RESUMABLE_REASONS = new Set(["not_started", "slice_complete", "controller_error", "unresolved_mutation"]);
const IDLE_MS = 15_000;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => (stopping = true));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const deps = await agentDependencies();
  while (!stopping) {
    let worked = false;
    for (const summary of await deps.backend.list()) {
      if (stopping) break;
      const state = await deps.backend.load(summary.sessionId);
      const resumable = state.status === "running" || (state.status === "paused" && RESUMABLE_REASONS.has(String(state.stopReason)));
      if (!resumable) continue;
      try {
        const { finished, state: after } = await runSessionSlice(deps, { sessionId: summary.sessionId, mutationsEnabled: true, sliceCycles: 3 });
        console.log(JSON.stringify({ sessionId: summary.sessionId, finished, status: after.status, stopReason: after.stopReason }));
        worked = true;
      } catch (error) {
        if (!(error instanceof SessionLockedError)) console.error("slice failed", summary.sessionId, error instanceof Error ? error.message : error);
      }
    }
    if (!worked) await sleep(IDLE_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
