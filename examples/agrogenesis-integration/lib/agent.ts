// Server-only helper. Everything credential-bearing is read from the server environment and never reaches the browser.
import pg from "pg";
import { PostgresSessionStore, createLogger, type AgentDependencies } from "agrogenesis-muse-agent";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

let pool: pg.Pool | undefined;
let store: PostgresSessionStore | undefined;

/** Use the app's existing PostgreSQL (DATABASE_URL). The agent only creates/uses its own `agent_sessions` table. */
export async function sessionStore(): Promise<PostgresSessionStore> {
  if (!store) {
    pool = new pg.Pool({ connectionString: required("DATABASE_URL"), max: 2 });
    store = new PostgresSessionStore(pool, { leaseTtlMs: 60_000 });
    await store.ensureSchema();
  }
  return store;
}

export async function agentDependencies(): Promise<AgentDependencies> {
  return {
    backend: await sessionStore(),
    // Loopback or internal URL of the simulator itself; a per-game agent token created with the simulator's own tooling.
    simulator: { baseUrl: required("AGENT_SIMULATOR_BASE_URL"), agentToken: required("AGENT_SIMULATOR_TOKEN") },
    model: { apiKey: required("MODEL_API_KEY"), maxSessionCostUsd: 1 },
    logger: createLogger({ level: "info" }),
  };
}
