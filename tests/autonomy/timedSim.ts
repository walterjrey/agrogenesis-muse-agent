import { availableActions, executeAccepted, fieldObservations, GAME_ID, overview } from "../fixtures.js";
import { startMockServer, type MockServer } from "../mockServer.js";
import { SimulatorClient } from "../../src/simulator/client.js";

/**
 * MOCKED, time-aware stand-in for the simulator's agent API. It models what matters for the supervisor: a clock in
 * simulated seconds (1 day = 60 s, 0.1 s ticks), a per-request grant cap, operations with a TRUE completion time that
 * may differ from the advertised estimate, `stopOn: action_completion`, revision checks (409) and durable idempotent
 * replay. It is not the simulation engine and proves nothing about real agricultural mechanics.
 */
export interface TimedSimOptions {
  startSimS?: number;
  /** Per-request cap on granted seconds (the real simulator caps at 14,400). */
  maxGrantS?: number;
  /** Seconds of simulated time an action needs; per type, default 30. */
  durationS?: number;
  /** Estimate advertised for new actions: a number of seconds from start, or null for none. */
  estimateS?: number | null;
  /** First N advance POSTs are committed but their responses arrive after the client timeout. */
  loseResponses?: number;
  /** Simulated time at which a weather alert event is emitted. */
  weatherAtS?: number;
  /** Simulated time at which the running action fails instead of completing. */
  failAtS?: number;
  /** The first advance request sees a stale revision (another writer moved the game). */
  staleOnce?: number;
  /** Events emitted when an advance crosses `atS` (for example pest alerts, crop_ready, delivered observations). */
  scriptedEvents?: Array<{ atS: number; kind: string; actionId?: string | null; summary?: string; data?: Record<string, unknown>; /** Field observations reported from this moment on (a delivered measurement). */ fields?: unknown[] }>;
  /** Catalogue offers inspectField for each of these field ids (default: just field-1). */
  catalogFields?: string[];
  /** Whether the catalogue offers an eligible action (default true). */
  eligible?: boolean;
}

interface Op {
  id: string;
  type: string;
  startedAtS: number;
  completesAtS: number;
  estimateAtS: number | null;
  status: "running" | "completed" | "failed";
}

export interface TimedSim {
  server: MockServer;
  client: SimulatorClient;
  state: { simTimeS: number; revision: number; credits: number; replays: number; ops: Op[]; advances: Array<{ requested: number; granted: number; key: string; stoppedBecause: string }> };
  advancePosts: Array<Record<string, unknown>>;
  actionPosts: Array<Record<string, unknown>>;
  /** Sets how many more advance responses are lost (committed, but delivered after the client timeout). */
  setLose(n: number): void;
  /** Replaces the field observations the simulator reports (for example after a robot mission delivered data). */
  setFields(fields: unknown[]): void;
  setEligible(eligible: boolean): void;
  /** Number of GET requests served per path, to prove routine ticks do not hammer the simulator. */
  gets: Record<string, number>;
  close(): Promise<void>;
}

const BASE = `/api/agent/v1/games/${GAME_ID}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export async function timedSim(options: TimedSimOptions = {}, clientTimeoutMs = 2000): Promise<TimedSim> {
  const cap = options.maxGrantS ?? 14_400;
  const duration = options.durationS ?? 30;
  let lose = options.loseResponses ?? 0;
  let stale = options.staleOnce ?? 0;
  const state: TimedSim["state"] = { simTimeS: options.startSimS ?? 0, revision: 4, credits: 2500, replays: 0, ops: [], advances: [] };
  const stored = new Map<string, { status: number; body: unknown }>();
  const events: Array<Record<string, unknown>> = [];
  const advancePosts: Array<Record<string, unknown>> = [];
  const actionPosts: Array<Record<string, unknown>> = [];
  let weatherSent = false;
  let fields: unknown[] = fieldObservations.fields;
  let eligible = options.eligible ?? true;
  const scripted = (options.scriptedEvents ?? []).map((e) => ({ ...e, sent: false }));
  const gets: Record<string, number> = {};

  const clockNow = () => ({ simTimeS: r3(state.simTimeS), simDay: Math.floor(state.simTimeS / 60), tickCount: Math.round(state.simTimeS / 0.1), paused: false });
  const event = (kind: string, actionId: string | null, simTimeS: number, summary: string) => {
    const e = { eventId: events.length + 1, simTimeS: r3(simTimeS), kind, actionId, summary, data: {} };
    events.push(e);
    return e;
  };
  const view = (op: Op) => ({
    ...executeAccepted.action,
    actionId: op.id,
    type: op.type,
    status: op.status,
    startedAtS: op.startedAtS,
    estimatedCompletionS: op.estimateAtS,
    finishedAtS: op.status === "running" ? null : op.completesAtS,
    progress: op.status === "running" ? r3(Math.min(0.99, (state.simTimeS - op.startedAtS) / Math.max(1, op.completesAtS - op.startedAtS))) : 1,
    consumed: { ...executeAccepted.action.consumed, credits: op.status === "completed" ? 9.12 : 0, waterM3: op.status === "completed" && op.type === "irrigateField" ? 42.5 : 0 },
    outcome: op.status === "completed" ? { summary: `${op.type} done`, measurements: {} } : null,
    failure: op.status === "failed" ? { code: "equipment_fault", detail: "The machine broke down." } : null,
  });

  const server = await startMockServer((req) => {
    const path = req.url.split("?")[0]!.replace(BASE, "");
    if (req.method === "GET") {
      gets[path] = (gets[path] ?? 0) + 1;
      if (path === "/overview") return { status: 200, body: { ...overview, revision: state.revision, clock: clockNow(), status: { ...overview.status, activeActionCount: state.ops.filter((o) => o.status === "running").length }, finance: { authorized: true, credits: state.credits, realizedRevenue: 0, realizedCosts: 2500 - state.credits } } };
      if (path === "/fields") return { status: 200, body: { ...fieldObservations, fields, revision: state.revision, simTimeS: r3(state.simTimeS) } };
      if (path === "/actions") {
        const base = availableActions.actions[0]!;
        const offered = (options.catalogFields ?? [base.target.id]).map((id) => ({ ...base, target: { ...base.target, id, label: id }, eligibility: eligible ? base.eligibility : { eligible: false, issues: [{ code: "none", detail: "nothing to do" }] } }));
        return { status: 200, body: { ...availableActions, actions: offered, revision: state.revision, simTimeS: r3(state.simTimeS) } };
      }
      if (path === "/events") {
        const cursor = Number(new URL(req.url, "http://x").searchParams.get("cursor") ?? 0);
        const out = events.filter((e) => (e.eventId as number) > cursor);
        return { status: 200, body: { gameId: GAME_ID, clock: clockNow(), events: out, nextCursor: events.length } };
      }
      const m = /^\/actions\/(.+)$/.exec(path);
      const op = m ? state.ops.find((o) => o.id === m[1]) : undefined;
      if (op) return { status: 200, body: { gameId: GAME_ID, action: view(op) } };
      return { status: 404, body: { error: "not found", code: "not_found" } };
    }

    const body = JSON.parse(req.body) as Record<string, unknown>;
    (path === "/actions" ? actionPosts : advancePosts).push(body);
    const key = String(body.idempotencyKey);
    const replay = stored.get(key);
    if (replay) {
      state.replays += 1;
      if (lose > 0 && path === "/clock/advance") {
        lose -= 1;
        return { ...replay, delayMs: clientTimeoutMs + 300 };
      }
      return replay;
    }
    if (stale > 0 && path === "/clock/advance") {
      stale -= 1;
      state.revision += 1; // another writer moved the game
    }
    if (body.expectedRevision !== state.revision) return { status: 409, body: { error: "expectedRevision does not match.", code: "stale_revision", currentRevision: state.revision } };

    let response: { status: number; body: unknown };
    if (path === "/actions") {
      state.revision += 1;
      const id = `act-${state.ops.length + 1}`;
      state.ops.push({ id, type: String(body.type), startedAtS: state.simTimeS, completesAtS: state.simTimeS + duration, estimateAtS: options.estimateS === undefined ? state.simTimeS + duration : options.estimateS === null ? null : state.simTimeS + options.estimateS, status: "running" });
      state.credits -= 25;
      response = { status: 201, body: { ...executeAccepted, revision: state.revision, action: view(state.ops.at(-1)!) } };
    } else {
      const before = state.simTimeS;
      const requested = Number(body.requestedSeconds);
      let granted = Math.min(requested, cap);
      let stopped = requested > cap ? "granted_limit_reached" : "requested_time_reached";
      const running = state.ops.filter((o) => o.status === "running");
      const stopOnCompletion = Array.isArray(body.stopOn) && body.stopOn.includes("action_completion");
      const fail = options.failAtS !== undefined && running.length > 0 ? options.failAtS : Infinity;
      const next = Math.min(...running.map((o) => o.completesAtS), fail);
      if (stopOnCompletion && Number.isFinite(next) && before + granted >= next - 1e-9) {
        granted = Math.max(0.1, Math.ceil((next - before) / 0.1 - 1e-9) * 0.1);
        stopped = "action_completion";
      }
      granted = r3(granted);
      state.simTimeS = r3(before + granted);
      state.revision += 1;
      const emitted: Array<Record<string, unknown>> = [];
      if (options.weatherAtS !== undefined && !weatherSent && before < options.weatherAtS && state.simTimeS >= options.weatherAtS) {
        weatherSent = true;
        emitted.push(event("weather_alert", null, options.weatherAtS, "Storm warning"));
      }
      for (const e of scripted) {
        if (!e.sent && before < e.atS && state.simTimeS >= e.atS) {
          e.sent = true;
          if (e.fields) fields = e.fields;
          const ev = event(e.kind, e.actionId ?? null, e.atS, e.summary ?? e.kind);
          ev.data = e.data ?? {};
          emitted.push(ev);
        }
      }
      for (const op of running) {
        if (fail !== Infinity && state.simTimeS >= fail) {
          op.status = "failed";
          op.completesAtS = fail;
          emitted.push(event("action_failed", op.id, fail, `${op.type} failed`));
        } else if (state.simTimeS >= op.completesAtS - 1e-9) {
          op.status = "completed";
          emitted.push(event("action_completed", op.id, op.completesAtS, `${op.type} completed`));
          state.credits = r3(state.credits - 9.12);
        }
      }
      state.advances.push({ requested, granted, key, stoppedBecause: stopped });
      response = { status: 200, body: { gameId: GAME_ID, clockBefore: { simTimeS: before, simDay: Math.floor(before / 60), tickCount: Math.round(before / 0.1), paused: false }, clockAfter: clockNow(), requestedSeconds: requested, grantedSeconds: granted, stoppedBecause: stopped, events: emitted, nextCursor: events.length } };
    }
    stored.set(key, response);
    if (lose > 0 && path === "/clock/advance") {
      lose -= 1;
      return { ...response, delayMs: clientTimeoutMs + 300 };
    }
    return response;
  });

  const client = new SimulatorClient({ baseUrl: server.url, agentToken: "test-agent-token-SECRET", timeoutMs: clientTimeoutMs });
  return { server, client, state, advancePosts, actionPosts, gets, setLose: (n) => { lose = n; }, setFields: (f) => { fields = f; }, setEligible: (e) => { eligible = e; }, close: () => server.close() };
}
