import { afterEach, describe, expect, it } from "vitest";
import { SimulatorClient, SimulatorError } from "../src/simulator/client.js";
import { runReadOnlyIntegration } from "../src/simulator/integration.js";
import { silentLogger } from "../src/logging/logger.js";
import { availableActions, executeAccepted, fieldObservations, GAME_ID, games, overview } from "./fixtures.js";
import { startMockServer, type MockServer } from "./mockServer.js";

const TOKEN = "test-agent-token";
let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function routes(overrides: Record<string, unknown> = {}) {
  return (req: { method: string; url: string; authorization: string | undefined }) => {
    if (req.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: "Authentication required." } };
    const table: Record<string, unknown> = {
      "GET /api/agent/v1/games": games,
      [`GET /api/agent/v1/games/${GAME_ID}/overview`]: overview,
      [`GET /api/agent/v1/games/${GAME_ID}/fields`]: fieldObservations,
      [`GET /api/agent/v1/games/${GAME_ID}/actions`]: availableActions,
      [`POST /api/agent/v1/games/${GAME_ID}/actions`]: executeAccepted,
      ...overrides,
    };
    const body = table[`${req.method} ${req.url}`];
    return body === undefined ? { status: 404, body: { error: "Not found." } } : { status: 200, body };
  };
}

const client = (url: string, token = TOKEN, timeoutMs = 2000) => new SimulatorClient({ baseUrl: url, agentToken: token, timeoutMs, logger: silentLogger });

describe("simulator client + read-only integration (MOCKED simulator, not a real integration)", () => {
  it("runs the read-only flow without any mutating call", async () => {
    server = await startMockServer(routes());
    const report = await runReadOnlyIntegration(client(server.url), silentLogger);
    expect(report).toMatchObject({ gameId: GAME_ID, simDay: 2, fieldCount: 1, eligibleActionTypes: ["inspectField"], mutatingCalls: 0 });
    expect(server.requests.every((r) => r.method === "GET")).toBe(true);
    expect(server.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("refuses a game the token does not authorize", async () => {
    server = await startMockServer(routes());
    await expect(runReadOnlyIntegration(client(server.url), silentLogger, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(/not authorized/);
  });

  it("surfaces authentication failures", async () => {
    server = await startMockServer(routes());
    await expect(client(server.url, "wrong").listGames()).rejects.toMatchObject({ kind: "http", status: 401 });
  });

  it("rejects responses that leak hidden truth", async () => {
    const leaked = { ...fieldObservations, groundTruth: { soilMoisture: 0.3 } };
    server = await startMockServer(routes({ [`GET /api/agent/v1/games/${GAME_ID}/fields`]: leaked }));
    await expect(client(server.url).getFieldObservations(GAME_ID)).rejects.toMatchObject({ kind: "contract" });
  });

  it("times out slow simulators", async () => {
    server = await startMockServer(() => ({ status: 200, body: games, delayMs: 300 }));
    await expect(client(server.url, TOKEN, 50).listGames()).rejects.toBeInstanceOf(SimulatorError);
    await expect(client(server.url, TOKEN, 50).listGames()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("defaults execution to a dry run and sends an idempotency key", async () => {
    server = await startMockServer(routes());
    await client(server.url).executeAction(GAME_ID, { type: "irrigateField", params: { fieldId: "field-1", volumeM3: 50 } });
    const sent = JSON.parse(server.requests[0]!.body) as { dryRun: boolean; idempotencyKey: string };
    expect(sent.dryRun).toBe(true);
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("parses an HTTP 422 rejection as a normal committed response, but still throws on other 4xx", async () => {
    const rejected = { ...executeAccepted, accepted: false, action: null, errors: [{ code: "invalid_params", detail: "volumeM3 must be positive" }] };
    server = await startMockServer(() => ({ status: 422, body: rejected }));
    const result = await client(server.url).executeAction(GAME_ID, { type: "irrigateField", params: { fieldId: "field-1", volumeM3: 50 }, dryRun: false });
    expect(result.accepted).toBe(false);
    await server.close();
    server = await startMockServer(() => ({ status: 400, body: { error: "bad" } }));
    await expect(client(server.url).executeAction(GAME_ID, { type: "irrigateField", params: { fieldId: "field-1", volumeM3: 50 } })).rejects.toMatchObject({ kind: "http", status: 400 });
  });
});
