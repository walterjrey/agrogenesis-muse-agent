import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { executeAccepted, fieldObservations, availableActions, overview, clock, GAME_ID } from "../fixtures.js";
import { startMockServer, type MockRequest, type MockServer } from "../mockServer.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/model/meta.js";
import { SimulatorClient } from "../../src/simulator/client.js";

/** Everything in tests/agent uses MOCKED collaborators (scripted model, fake HTTP simulator). None of it is live validation. */

export interface FakeSim {
  server: MockServer;
  state: { revision: number; accepted: number; replays: number };
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  client: SimulatorClient;
  close(): Promise<void>;
}

type Override = (req: MockRequest, sim: FakeSim["state"]) => { status: number; body: unknown; delayMs?: number } | undefined;

const BASE = `/api/agent/v1/games/${GAME_ID}`;

/** Minimal stateful stand-in for the simulator's agent API: revision checks and idempotent replay of POSTs. */
export async function fakeSimulator(override?: Override, clientTimeoutMs = 2000): Promise<FakeSim> {
  const state = { revision: 4, accepted: 0, replays: 0 };
  const posts: FakeSim["posts"] = [];
  const stored = new Map<string, { status: number; body: unknown }>();

  const server = await startMockServer((req) => {
    const path = req.url.split("?")[0]!.replace(BASE, "");
    if (req.method === "POST") posts.push({ path, body: JSON.parse(req.body) as Record<string, unknown> });
    const early = override?.(req, state);
    if (early) return early;
    if (req.method === "GET") {
      if (path === "/overview") return { status: 200, body: { ...overview, revision: state.revision } };
      if (path === "/fields") return { status: 200, body: { ...fieldObservations, revision: state.revision } };
      if (path === "/actions") return { status: 200, body: { ...availableActions, revision: state.revision } };
      if (path === "/actions/act-1") return { status: 200, body: { gameId: GAME_ID, action: executeAccepted.action } };
      if (path === "/events") return { status: 200, body: { gameId: GAME_ID, clock, events: [], nextCursor: 0 } };
      return { status: 404, body: { error: "not found", code: "not_found" } };
    }
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const key = String(body.idempotencyKey);
    const replay = stored.get(key);
    if (replay) { state.replays += 1; return replay; }
    if (body.expectedRevision !== state.revision) {
      return { status: 409, body: { error: "expectedRevision does not match the game's current revision.", code: "stale_revision", currentRevision: state.revision } };
    }
    state.revision += 1;
    let response: { status: number; body: unknown };
    if (path === "/actions") {
      state.accepted += 1;
      response = { status: 201, body: { ...executeAccepted, revision: state.revision } };
    } else {
      const granted = Math.min(Number(body.requestedSeconds), 1800);
      response = { status: 200, body: { gameId: GAME_ID, clockBefore: clock, clockAfter: { ...clock, simTimeS: clock.simTimeS + granted }, requestedSeconds: body.requestedSeconds, grantedSeconds: granted, stoppedBecause: "requested_time_reached", events: [], nextCursor: 0 } };
    }
    stored.set(key, response);
    return response;
  });

  const client = new SimulatorClient({ baseUrl: server.url, agentToken: "test-agent-token-SECRET", timeoutMs: clientTimeoutMs });
  return { server, state, posts, client, close: () => server.close() };
}

export interface ScriptedCall { name: string; args?: unknown; id?: string; rawArguments?: string }
export interface ScriptedStep { content?: string | null; calls?: ScriptedCall[]; costUsd?: number; throws?: Error }

export interface ScriptedProvider extends ModelProvider {
  requests: ModelRequest[];
}

/** A scripted stand-in for the model: it returns predetermined native-shaped responses. It makes no decisions. */
export function scriptedModel(steps: ScriptedStep[]): ScriptedProvider {
  let index = 0;
  const requests: ModelRequest[] = [];
  return {
    modelId: "muse-spark-1.3",
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      if (step.throws) throw step.throws;
      const toolCalls = (step.calls ?? []).map((c, i) => ({ id: c.id ?? `call_${index}_${i}`, name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.args ?? {}) }));
      const assistantMessage: ChatCompletionMessageParam = {
        role: "assistant",
        content: step.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) } : {}),
      };
      const response: ModelResponse = {
        model: "muse-spark-1.3",
        content: step.content ?? null,
        toolCalls,
        assistantMessage,
        finishReason: toolCalls.length ? "tool_calls" : "stop",
        usage: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 20, reasoningTokens: null, totalTokens: 120 },
        estimatedCostUsd: step.costUsd ?? 0.001,
        latencyMs: 1,
        requestId: `req-${index}`,
      };
      return response;
    },
  };
}

export const toolMessages = (provider: ScriptedProvider, requestIndex: number): Array<{ tool_call_id: string; body: { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> } }> =>
  (provider.requests[requestIndex]?.messages ?? [])
    .slice((provider.requests[requestIndex]?.messages ?? []).map((m) => m.role).lastIndexOf("assistant") + 1)
    .filter((m): m is Extract<ChatCompletionMessageParam, { role: "tool" }> => m.role === "tool")
    .map((m) => ({ tool_call_id: m.tool_call_id, body: JSON.parse(String(m.content)) as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> } }));

export const countingIds = (): (() => string) => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};
