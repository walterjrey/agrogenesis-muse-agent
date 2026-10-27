import { randomUUID } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { SimulatorError, type SimulatorClient } from "../simulator/client.js";
import type { RunPolicy } from "./policy.js";
import type { RunTrace } from "./trace.js";

export interface ToolState {
  /** Revision of the latest observation the model has actually been shown; null forces a fresh observation. */
  observedRevision: number | null;
  eventCursor: number;
  /** Set when a mutation may or may not have been applied and could not be resolved; blocks further mutations. */
  mutationLocked: boolean;
}

/** A state-changing request, recorded durably BEFORE it is sent so that a crash can be reconciled with the same key. */
export interface MutationIntent {
  tool: "execute_action" | "advance_time";
  idempotencyKey: string;
  expectedRevision: number;
  /** The exact request body that is (re)sent, including the idempotency key. */
  request: Record<string, unknown>;
  rationale: string | null;
}

export interface MutationSettlement {
  /** `not_applied` is used only when the simulator definitively refused the request (4xx before any commit). */
  status: "applied" | "rejected" | "not_applied";
  revisionAfter: number | null;
  summary: Record<string, unknown>;
}

export interface MutationJournal {
  begin(intent: MutationIntent): Promise<void>;
  settle(intent: MutationIntent, settlement: MutationSettlement): Promise<void>;
}

export interface ToolContext {
  journal?: MutationJournal;
  client: SimulatorClient;
  gameId: string;
  policy: RunPolicy;
  trace: RunTrace;
  state: ToolState;
  /** Idempotency keys are always created by the runtime, never by the model. */
  newMutationId: () => string;
  retryDelayMs: number;
  maxMutationRetries: number;
}

export interface ToolFailure {
  code: string;
  message: string;
  [detail: string]: unknown;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: ToolFailure };

export type ParseResult = { ok: true; args: Record<string, unknown> } | { ok: false; issues: Array<{ path: string; message: string }> };

export interface RegisteredTool {
  name: string;
  description: string;
  mutating: boolean;
  /** JSON Schema generated from the strict Zod argument schema. */
  parameters: Record<string, unknown>;
  parse(raw: unknown): ParseResult;
  run(context: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export const succeed = (data: unknown): ToolOutcome => ({ ok: true, data });
export const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome => ({ ok: false, error: { code, message, ...extra } });

export function defineTool<S extends z.ZodObject>(definition: {
  name: string;
  description: string;
  mutating: boolean;
  args: S;
  run: (context: ToolContext, args: z.output<S>) => Promise<ToolOutcome>;
}): RegisteredTool {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(definition.args, { io: "input" }) as Record<string, unknown>;
  void _schema;
  return {
    name: definition.name,
    description: definition.description,
    mutating: definition.mutating,
    parameters,
    parse(raw) {
      const parsed = definition.args.safeParse(raw);
      if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
      return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    },
    run: (context, args) => definition.run(context, args as z.output<S>),
  };
}

/** Maps a simulator or transport error to a structured failure the model can act on. Never forwards unvalidated payloads. */
export function failureFromError(error: unknown): ToolFailure {
  if (error instanceof SimulatorError) {
    const detail = (error.detail ?? {}) as { code?: string; currentRevision?: number };
    switch (error.kind) {
      case "timeout":
        return { code: "simulator_timeout", message: "The simulator did not respond in time." };
      case "network":
        return { code: "simulator_unreachable", message: "The simulator could not be reached." };
      case "contract":
        return { code: "contract_violation", message: "The simulator response violated the agent contract and was withheld." };
      case "http": {
        const byStatus: Record<number, string> = { 400: "bad_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited" };
        const code = detail.code ?? byStatus[error.status ?? 0] ?? "simulator_error";
        return { code, message: error.message, httpStatus: error.status ?? null, ...(detail.currentRevision !== undefined ? { currentRevision: detail.currentRevision } : {}) };
      }
    }
  }
  return { code: "internal_error", message: "The tool failed unexpectedly." };
}

const RETRIABLE = (error: unknown): boolean =>
  error instanceof SimulatorError && (error.kind === "timeout" || error.kind === "network" || (error.kind === "http" && (error.status ?? 0) >= 500));

export class OutcomeUnknownError extends Error {}

/**
 * Sends a mutation and, when the outcome is unknown (timeout, dropped connection, 5xx), repeats the SAME request
 * with the SAME idempotency key. The simulator replays the stored result when the first attempt committed, and
 * executes at most once otherwise. A new key is never generated for a retry.
 */
export async function sendIdempotent<T>(context: { trace: { record(event: string, data?: Record<string, unknown>): unknown }; retryDelayMs: number; maxMutationRetries: number }, send: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= context.maxMutationRetries; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!RETRIABLE(error)) throw error;
      lastError = error;
      context.trace.record("mutation.retry_same_key", { attempt: attempt + 1, reason: failureFromError(error).code });
      if (attempt < context.maxMutationRetries) await new Promise((resolve) => setTimeout(resolve, context.retryDelayMs * (attempt + 1)));
    }
  }
  throw Object.assign(new OutcomeUnknownError("Mutation outcome could not be confirmed."), { cause: lastError });
}

/** Only a definitive 4xx answer proves the simulator did not commit the request. Everything else is an unknown outcome. */
export const isDefinitiveRefusal = (error: unknown): boolean =>
  error instanceof SimulatorError && error.kind === "http" && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500;

async function mutationFailure(context: ToolContext, error: unknown, intent?: MutationIntent): Promise<ToolOutcome> {
  if (!isDefinitiveRefusal(error)) {
    context.state.mutationLocked = true;
    context.trace.record("mutation.outcome_unknown", { reason: error instanceof OutcomeUnknownError ? "retries_exhausted" : "unconfirmed_response" });
    return fail("outcome_unknown", "The request may or may not have been applied. Repeating it with the same idempotency key did not produce a confirmed result. Further state-changing calls are blocked for this run; use read-only tools to inspect the current state and report it.");
  }
  const failure = failureFromError(error);
  if (intent) await context.journal?.settle(intent, { status: "not_applied", revisionAfter: null, summary: { code: failure.code, httpStatus: failure.httpStatus ?? null } });
  if (failure.code === "stale_revision") {
    context.state.observedRevision = null;
    let latest: unknown = null;
    try {
      latest = await context.client.getFarmOverview(context.gameId);
    } catch {
      latest = null;
    }
    context.trace.record("mutation.conflict", { currentRevision: failure.currentRevision ?? null });
    return fail("stale_revision", "The farm changed since you last observed it, so nothing was executed. Re-observe, reconsider, and decide again; the original request was NOT retried.", {
      currentRevision: failure.currentRevision ?? null,
      latestOverview: latest,
    });
  }
  return { ok: false, error: failure };
}

const NoArgs = z.strictObject({});
export const Rationale = z.string().min(1).max(500).optional().describe("One or two sentences explaining, from the observations, why you are doing this. Recorded in the audit log.");

export function createToolRegistry(): RegisteredTool[] {
  return [
    defineTool({
      name: "observe_farm",
      description: "Get the observable farm overview: simulation clock, last weather observation (with age and confidence), resource stock levels, equipment status, active action count and finance if authorized. Reports only what the farm management knows.",
      mutating: false,
      args: NoArgs,
      async run(context) {
        try {
          const overview = await context.client.getFarmOverview(context.gameId);
          context.state.observedRevision = overview.revision;
          return succeed(overview);
        } catch (error) {
          return { ok: false, error: failureFromError(error) };
        }
      },
    }),
    defineTool({
      name: "observe_fields",
      description: "Get observed information for every field: each measurement carries its value, unit, uncertainty, age, freshness (fresh/stale/expired/never_observed), confidence and sensor, and `missing` lists quantities with no usable observation. Missing or stale quantities are unknown; do not assume values for them.",
      mutating: false,
      args: NoArgs,
      async run(context) {
        try {
          const fields = await context.client.getFieldObservations(context.gameId);
          context.state.observedRevision = fields.revision;
          return succeed(fields);
        } catch (error) {
          return { ok: false, error: failureFromError(error) };
        }
      },
    }),
    defineTool({
      name: "list_available_actions",
      description: "List the management actions the simulator offers, each with its parametersSchema (JSON Schema for `params`), resource and duration estimate, eligibility issues, and whether it is asynchronous. The simulator is the only validator. By default only currently eligible actions are returned.",
      mutating: false,
      args: z.strictObject({
        eligibleOnly: z.boolean().default(true).describe("Return only actions that are eligible right now."),
        category: z.enum(["agriculture", "machinery", "robotics", "livestock", "water", "economy"]).optional().describe("Restrict to one category."),
      }),
      async run(context, args) {
        try {
          const catalog = await context.client.getAvailableActions(context.gameId);
          context.state.observedRevision = catalog.revision;
          const matching = catalog.actions.filter((a) => (args.category ? a.category === args.category : true));
          const shown = matching.filter((a) => (args.eligibleOnly ? a.eligibility.eligible : true));
          return succeed({ revision: catalog.revision, simTimeS: catalog.simTimeS, actions: shown, omittedIneligibleCount: matching.length - shown.length });
        } catch (error) {
          return { ok: false, error: failureFromError(error) };
        }
      },
    }),
    defineTool({
      name: "execute_action",
      description: "Submit ONE management action to the simulator. Choose `type` from list_available_actions and build `params` exactly as that action's parametersSchema describes. The runtime attaches the game revision you last observed and an idempotency key; you cannot set either. Call this tool alone (never together with other tools). If the farm changed since your observation the request is NOT executed and you get a stale_revision result. Actions can be asynchronous: check progress with get_action_status.",
      mutating: true,
      args: z.strictObject({
        type: z.string().min(1).max(64).describe("Action type from list_available_actions."),
        params: z.record(z.string(), z.unknown()).describe("Parameters matching the action's parametersSchema."),
        rationale: Rationale,
      }),
      async run(context, args) {
        const expectedRevision = context.state.observedRevision;
        if (context.state.mutationLocked) return fail("mutation_locked", "A previous state-changing request has an unconfirmed outcome; no further actions are allowed in this run.");
        if (expectedRevision === null) return fail("observation_required", "Observe the farm first (observe_farm, observe_fields or list_available_actions): an action must be based on a current observation.");

        context.policy.mutationAttempts += 1;
        const idempotencyKey = context.newMutationId();
        const request = { type: args.type, params: args.params, expectedRevision, dryRun: false, idempotencyKey };
        const intent: MutationIntent = { tool: "execute_action", idempotencyKey, expectedRevision, request, rationale: args.rationale ?? null };
        context.trace.record("mutation.submit", { tool: "execute_action", type: args.type, params: args.params, expectedRevision, idempotencyKey, rationale: args.rationale ?? null });
        try {
          await context.journal?.begin(intent);
          const response = await sendIdempotent(context, () => context.client.executeAction(context.gameId, request));
          await context.journal?.settle(intent, {
            status: response.accepted ? "applied" : "rejected",
            revisionAfter: response.revision,
            summary: { type: args.type, accepted: response.accepted, actionId: response.action?.actionId ?? null, actionStatus: response.action?.status ?? null, errors: response.errors },
          });
          context.trace.record("mutation.result", { tool: "execute_action", accepted: response.accepted, revision: response.revision, actionId: response.action?.actionId ?? null, status: response.action?.status ?? null, errors: response.errors });
          if (response.accepted) {
            context.policy.acceptedMutations += 1;
            context.state.observedRevision = null;
          } else {
            context.state.observedRevision = response.revision;
          }
          return succeed({
            accepted: response.accepted,
            revision: response.revision,
            action: response.action,
            errors: response.errors,
            asynchronous: response.asynchronous,
            note: response.accepted
              ? "Accepted. The farm state changed; observe again before another action. Follow progress with get_action_status or advance_time."
              : "Rejected by the simulator; nothing was reserved or consumed. You may reconsider.",
          });
        } catch (error) {
          return mutationFailure(context, error, intent);
        }
      },
    }),
    defineTool({
      name: "get_action_status",
      description: "Get the recorded status of a previously submitted action: status, progress, reserved and consumed resources, outcome and failure.",
      mutating: false,
      args: z.strictObject({ actionId: z.string().min(1).max(100).describe("actionId returned by execute_action.") }),
      async run(context, args) {
        try {
          return succeed(await context.client.getAction(context.gameId, args.actionId));
        } catch (error) {
          return { ok: false, error: failureFromError(error) };
        }
      },
    }),
    defineTool({
      name: "advance_time",
      description: "Ask the simulator to advance simulated time so that submitted actions can progress. The server owns the clock: it may grant less than requested, and the run enforces a per-call and total limit. Call this tool alone. After advancing, your earlier observations are stale; observe again before acting.",
      mutating: true,
      args: z.strictObject({
        requestedSeconds: z.number().positive().max(86_400).describe("Simulated seconds to advance."),
        stopOn: z.array(z.enum(["action_completion", "new_observation", "any_event"])).min(1).default(["action_completion"]).describe("Conditions that end the advance early."),
        rationale: Rationale,
      }),
      async run(context, args) {
        const expectedRevision = context.state.observedRevision;
        if (context.state.mutationLocked) return fail("mutation_locked", "A previous state-changing request has an unconfirmed outcome; no further time advancement is allowed in this run.");
        if (expectedRevision === null) return fail("observation_required", "Observe the farm first (observe_farm, observe_fields or list_available_actions) before advancing time.");

        const idempotencyKey = context.newMutationId();
        const request = { requestedSeconds: args.requestedSeconds, stopOn: args.stopOn, cursor: context.state.eventCursor, expectedRevision, idempotencyKey };
        const intent: MutationIntent = { tool: "advance_time", idempotencyKey, expectedRevision, request, rationale: args.rationale ?? null };
        context.trace.record("mutation.submit", { tool: "advance_time", requestedSeconds: args.requestedSeconds, stopOn: args.stopOn, expectedRevision, idempotencyKey, rationale: args.rationale ?? null });
        try {
          await context.journal?.begin(intent);
          const response = await sendIdempotent(context, () => context.client.advance(context.gameId, request));
          await context.journal?.settle(intent, {
            status: "applied",
            revisionAfter: null,
            summary: { grantedSeconds: response.grantedSeconds, stoppedBecause: response.stoppedBecause, simTimeAfterS: response.clockAfter.simTimeS, eventCount: response.events.length },
          });
          context.policy.advancedSimSeconds += response.grantedSeconds;
          context.policy.advanceRequests += 1;
          context.state.eventCursor = Math.max(context.state.eventCursor, response.nextCursor);
          context.state.observedRevision = null;
          context.trace.record("mutation.result", { tool: "advance_time", grantedSeconds: response.grantedSeconds, stoppedBecause: response.stoppedBecause, simTimeBeforeS: response.clockBefore.simTimeS, simTimeAfterS: response.clockAfter.simTimeS, eventCount: response.events.length });
          return succeed({ ...response, note: "Time advanced. Earlier observations are now stale; observe again before acting." });
        } catch (error) {
          return mutationFailure(context, error, intent);
        }
      },
    }),
    defineTool({
      name: "get_recent_events",
      description: "Get the agent-visible event timeline (action started/completed/failed/cancelled, mode changes) after an event id.",
      mutating: false,
      args: z.strictObject({ sinceEventId: z.number().int().nonnegative().default(0).describe("Return events with an id greater than this.") }),
      async run(context, args) {
        try {
          const events = await context.client.getEvents(context.gameId, args.sinceEventId);
          context.state.eventCursor = Math.max(context.state.eventCursor, events.nextCursor);
          return succeed(events);
        } catch (error) {
          return { ok: false, error: failureFromError(error) };
        }
      },
    }),
  ];
}

/** Native Chat Completions `tools` payload for the tools this policy exposes. `tool_choice` stays at the API default ("auto"). */
export function toolSpecs(tools: readonly RegisteredTool[], exposed: (tool: RegisteredTool) => boolean): ChatCompletionTool[] {
  return tools.filter(exposed).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export const newMutationId = (): string => randomUUID();
