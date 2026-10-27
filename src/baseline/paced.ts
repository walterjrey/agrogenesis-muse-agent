import { SimulatorError, type SimulatorClient } from "../simulator/client.js";

/** The subset of the simulator client the baseline uses; lets tests substitute a deterministic fake. */
export type BaselineApi = Pick<SimulatorClient, "getFarmOverview" | "getFieldObservations" | "getAvailableActions" | "executeAction" | "getAction" | "advance">;

export interface PacingOptions {
  /** Minimum spacing between requests; keeps the baseline under the server's per-token limit (120/min). */
  minIntervalMs: number;
  /** How long to wait after a 429 before retrying (the server's window is 60 s). */
  rateLimitWaitMs: number;
  maxRateLimitRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_PACING: PacingOptions = { minIntervalMs: 700, rateLimitWaitMs: 61_000, maxRateLimitRetries: 3 };

/**
 * Respects the server's rate limits instead of fighting them. A 429 is returned before any processing, so
 * retrying it is safe; mutating requests also carry their original idempotency key.
 */
export function pacedApi(client: BaselineApi, options: PacingOptions = DEFAULT_PACING): BaselineApi & { requests: () => number; rateLimited: () => number } {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;
  let sent = 0;
  let limited = 0;
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = last + options.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      sent += 1;
      try {
        return await fn();
      } catch (error) {
        if (error instanceof SimulatorError && error.status === 429 && attempt < options.maxRateLimitRetries) {
          limited += 1;
          await sleep(options.rateLimitWaitMs);
          last = Date.now();
          continue;
        }
        throw error;
      }
    }
  }
  return {
    getFarmOverview: (...a) => call(() => client.getFarmOverview(...a)),
    getFieldObservations: (...a) => call(() => client.getFieldObservations(...a)),
    getAvailableActions: (...a) => call(() => client.getAvailableActions(...a)),
    executeAction: (...a) => call(() => client.executeAction(...a)),
    getAction: (...a) => call(() => client.getAction(...a)),
    advance: (...a) => call(() => client.advance(...a)),
    requests: () => sent,
    rateLimited: () => limited,
  };
}
