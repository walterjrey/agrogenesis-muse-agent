// app/api/agent/sessions/[id]/route.ts: read-only status for a dashboard or for polling.
import { getSessionReport } from "agrogenesis-muse-agent";
import { sessionStore } from "../../../../../lib/agent";

async function requireAdministrator(): Promise<void> {
  throw new Error("Not implemented: wire this to the app's admin authentication.");
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  await requireAdministrator();
  const { id } = await context.params;
  return Response.json(await getSessionReport(await sessionStore(), id));
}
