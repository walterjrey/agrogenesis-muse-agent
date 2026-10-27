import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ActionStatusResponse,
  AdvanceResponse,
  ApiErrorBody,
  AuthorizedGames,
  AvailableActions,
  EventsResponse,
  ExecuteActionResponse,
  FarmOverview,
  FieldObservations,
  type AdvanceRequest,
  type ExecuteActionRequest,
} from "../contracts/index.js";
import { silentLogger, type Logger } from "../logging/logger.js";

export interface SimulatorClientOptions {
  baseUrl: string;
  agentToken: string;
  timeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** A submission the simulator validated and refused answers 422 with a normal, committed response body. */
const SUBMISSION_STATUSES = [422] as const;

export class SimulatorError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "network" | "timeout" | "contract",
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SimulatorError";
  }
}

/** Server-to-server client for the simulator's agent API. Every response is validated against the contracts. */
export class SimulatorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SimulatorClientOptions) {
    const url = new URL(options.baseUrl);
    this.baseUrl = url.origin + url.pathname.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  listGames() {
    return this.request("GET", "/api/agent/v1/games", AuthorizedGames);
  }

  getFarmOverview(gameId: string) {
    return this.request("GET", this.game(gameId, "overview"), FarmOverview);
  }

  getFieldObservations(gameId: string) {
    return this.request("GET", this.game(gameId, "fields"), FieldObservations);
  }

  getAvailableActions(gameId: string) {
    return this.request("GET", this.game(gameId, "actions"), AvailableActions);
  }

  /** Mutating. Defaults to a dry run so nothing is committed unless the caller opts in explicitly. */
  executeAction(gameId: string, input: Omit<ExecuteActionRequest, "idempotencyKey" | "dryRun"> & { dryRun?: boolean; idempotencyKey?: string }) {
    const body = { ...input, dryRun: input.dryRun ?? true, idempotencyKey: input.idempotencyKey ?? randomUUID() };
    return this.request("POST", this.game(gameId, "actions"), ExecuteActionResponse, body, SUBMISSION_STATUSES);
  }

  getAction(gameId: string, actionId: string) {
    return this.request("GET", this.game(gameId, `actions/${encodeURIComponent(actionId)}`), ActionStatusResponse);
  }

  getEvents(gameId: string, cursor = 0) {
    return this.request("GET", this.game(gameId, `events?cursor=${cursor}`), EventsResponse);
  }

  /** Requests time progression; the simulator decides how much is granted. */
  advance(gameId: string, input: Omit<AdvanceRequest, "idempotencyKey"> & { idempotencyKey?: string }) {
    const body = { ...input, idempotencyKey: input.idempotencyKey ?? randomUUID() };
    return this.request("POST", this.game(gameId, "clock/advance"), AdvanceResponse, body);
  }

  private game(gameId: string, suffix: string): string {
    return `/api/agent/v1/games/${encodeURIComponent(gameId)}/${suffix}`;
  }

  private async request<S extends z.ZodType>(method: "GET" | "POST", path: string, schema: S, body?: unknown, okStatuses: readonly number[] = []): Promise<z.infer<S>> {
    const started = Date.now();
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.agentToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      this.logger.log("warn", "simulator.request.failed", { method, path, timedOut, ms: Date.now() - started });
      throw new SimulatorError(timedOut ? "Simulator request timed out." : "Simulator is unreachable.", timedOut ? "timeout" : "network");
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    this.logger.log("info", "simulator.request", { method, path, status: response.status, ms: Date.now() - started });

    if (!response.ok && !okStatuses.includes(response.status)) {
      const parsed = ApiErrorBody.safeParse(json);
      throw new SimulatorError(parsed.success ? parsed.data.error : `Simulator returned HTTP ${response.status}.`, "http", response.status, parsed.success ? parsed.data : undefined);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      this.logger.log("error", "simulator.contract_violation", { method, path, issues: result.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })) });
      throw new SimulatorError("Simulator response violated the agent contract.", "contract", response.status, result.error.issues);
    }
    return result.data;
  }
}
