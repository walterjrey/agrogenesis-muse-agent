import { parseArgs } from "node:util";
import { loadDotEnv, requireEnv } from "../src/config.js";
import { observationFingerprint } from "../src/benchmark/fingerprint.js";
import { outcomeSnapshot } from "../src/benchmark/outcome.js";
import { SimulatorClient } from "../src/simulator/client.js";

/**
 *   npm run benchmark:verify-pair -- --muse-game <id> --baseline-game <id>
 *   npm run benchmark:outcome     -- --game <id>        (uses SIMULATOR_AGENT_TOKEN)
 *
 * verify-pair reads, with observe-only agent tokens (MUSE_AGENT_TOKEN, BASELINE_AGENT_TOKEN from the environment),
 * what each strategy would see at the start and compares the two. It is read-only: it never mutates a game, and it
 * reports a mismatch loudly. It complements the simulator-side `agent:game create-pair` database fingerprint.
 */
loadDotEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "muse-game": { type: "string" }, "baseline-game": { type: "string" }, game: { type: "string" } },
});
const base = requireEnv("SIMULATOR_BASE_URL");
const command = positionals[0];

if (command === "verify-pair") {
  const sides = [
    { role: "muse", gameId: values["muse-game"], token: requireEnv("MUSE_AGENT_TOKEN") },
    { role: "baseline", gameId: values["baseline-game"], token: requireEnv("BASELINE_AGENT_TOKEN") },
  ];
  const results = [];
  for (const side of sides) {
    if (!side.gameId) throw new Error(`--${side.role}-game is required.`);
    const client = new SimulatorClient({ baseUrl: base, agentToken: side.token });
    const [overview, fields, actions] = await Promise.all([client.getFarmOverview(side.gameId), client.getFieldObservations(side.gameId), client.getAvailableActions(side.gameId)]);
    results.push({ role: side.role, gameId: side.gameId, revision: overview.revision, simTimeS: overview.clock.simTimeS, mode: (await client.listGames()).games.find((g) => g.gameId === side.gameId)?.managementMode ?? null, ...observationFingerprint({ overview, fields, actions }), outcome: outcomeSnapshot(overview) });
  }
  const [a, b] = results as [(typeof results)[number], (typeof results)[number]];
  const equivalent = a.combinedSha256 === b.combinedSha256 && a.revision === b.revision && a.simTimeS === b.simTimeS && a.mode === b.mode && JSON.stringify(a.outcome) === JSON.stringify(b.outcome);
  console.log(JSON.stringify({ equivalent, games: results.map((r) => ({ role: r.role, gameId: r.gameId, revision: r.revision, simTimeS: r.simTimeS, mode: r.mode, overviewSha256: r.overviewSha256, fieldsSha256: r.fieldsSha256, actionsSha256: r.actionsSha256, combinedSha256: r.combinedSha256 })), startOutcome: a.outcome }, null, 2));
  if (!equivalent) {
    console.error("Initial observations are NOT equivalent: do not run a benchmark on this pair.");
    process.exit(2);
  }
} else if (command === "outcome") {
  if (!values.game) throw new Error("--game is required.");
  const client = new SimulatorClient({ baseUrl: base, agentToken: requireEnv("SIMULATOR_AGENT_TOKEN") });
  console.log(JSON.stringify(outcomeSnapshot(await client.getFarmOverview(values.game)), null, 2));
} else {
  console.error("Usage: benchmark <verify-pair|outcome>");
  process.exit(2);
}
