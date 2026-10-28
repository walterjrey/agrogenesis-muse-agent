// app/api/agent/sessions/route.ts (Next.js App Router). Creating a session is fast: it persists a row and returns.
// The long-running work happens in the worker (worker.ts), never inside this request.
import { startSession } from "agrogenesis-muse-agent";
import { agentDependencies, sessionStore } from "../../../../lib/agent";

// Replace with the application's real administrator check before exposing this route.
async function requireAdministrator(): Promise<void> {
  throw new Error("Not implemented: wire this to the app's admin authentication.");
}

export async function POST(request: Request): Promise<Response> {
  await requireAdministrator();
  const body = (await request.json()) as { gameId: string; maxCostUsd: number; maxMutations: number; maxModelCalls: number; maxSimDays: number; horizonDays?: number };
  const state = await startSession(await agentDependencies(), {
    gameId: body.gameId,
    mutationsEnabled: true,
    limits: { maxCostUsd: body.maxCostUsd, maxMutations: body.maxMutations, maxModelCalls: body.maxModelCalls, maxSimSeconds: body.maxSimDays * 60 },
    ...(body.horizonDays !== undefined ? { planningHorizonDays: body.horizonDays } : {}),
  });
  return Response.json({ sessionId: state.sessionId, status: state.status }, { status: 202 });
}

export async function GET(): Promise<Response> {
  await requireAdministrator();
  return Response.json({ sessions: await (await sessionStore()).list() });
}
