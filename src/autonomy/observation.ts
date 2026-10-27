import type { AvailableActions } from "../contracts/actions.js";
import type { FarmOverview } from "../contracts/overview.js";
import type { FieldObservations } from "../contracts/fieldObservations.js";
import { SimulatorError, type SimulatorClient } from "../simulator/client.js";
import type { ObservationSummary } from "./types.js";

/** Revision and simulated time shared by every part of a snapshot. */
export interface Snapshot {
  gameId: string;
  revision: number;
  simTimeS: number;
  overview: FarmOverview;
  fields: FieldObservations;
  actions: AvailableActions;
  /** Reads performed to obtain this snapshot (1 round = overview + fields + actions). */
  rounds: number;
  mixedRevisionsDetected: number;
}

export class InconsistentObservationError extends Error {
  constructor(readonly observed: Array<{ part: string; revision: number; simTimeS: number }>) {
    super(`Could not read a consistent snapshot: ${observed.map((o) => `${o.part}@r${o.revision}/t${o.simTimeS}`).join(", ")}.`);
  }
}

export interface SnapshotOptions {
  maxRounds?: number;
  retryDelayMs?: number;
  /** An overview the caller just read; it is used as the first part of round one instead of being fetched again. */
  firstOverview?: FarmOverview;
}

/**
 * Reads overview, field observations and the action catalog and accepts them only if they describe the same game
 * revision and simulated instant. A mismatch means another writer (or the agent's own mutation) landed between reads;
 * the round is discarded and repeated, up to a small bound. Parts from different revisions are never merged.
 *
 * Snapshot consistency (same revision/time) is separate from sensor freshness: each measurement keeps its own
 * observation time, age and freshness exactly as the simulator reported them.
 */
export async function collectSnapshot(client: SimulatorClient, gameId: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  const maxRounds = options.maxRounds ?? 3;
  let observed: Array<{ part: string; revision: number; simTimeS: number }> = [];
  let mixed = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    const overview = round === 1 && options.firstOverview ? options.firstOverview : await client.getFarmOverview(gameId);
    const fields = await client.getFieldObservations(gameId);
    const actions = await client.getAvailableActions(gameId);
    observed = [
      { part: "overview", revision: overview.revision, simTimeS: overview.clock.simTimeS },
      { part: "fields", revision: fields.revision, simTimeS: fields.simTimeS },
      { part: "actions", revision: actions.revision, simTimeS: actions.simTimeS },
    ];
    const consistent = observed.every((o) => o.revision === overview.revision && o.simTimeS === overview.clock.simTimeS);
    if (consistent) return { gameId, revision: overview.revision, simTimeS: overview.clock.simTimeS, overview, fields, actions, rounds: round, mixedRevisionsDetected: mixed };
    mixed += 1;
    if (round < maxRounds) await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 250) * round));
  }
  throw new InconsistentObservationError(observed);
}

export function summarizeSnapshot(snapshot: Snapshot): ObservationSummary {
  const finance = snapshot.overview.finance;
  return {
    revision: snapshot.revision,
    simTimeS: snapshot.simTimeS,
    credits: finance.authorized ? finance.credits : null,
    realizedRevenue: finance.authorized ? finance.realizedRevenue : null,
    realizedCosts: finance.authorized ? finance.realizedCosts : null,
    resources: snapshot.overview.resources.map((r) => ({ id: r.id, kind: r.kind, quantity: r.quantity, unit: r.unit })),
    activeActions: snapshot.overview.status.activeActionCount,
    fields: snapshot.fields.fields.map((f) => ({ fieldId: f.fieldId, knownCrop: f.knownCrop?.value ?? null, knownGrowthStage: f.knownGrowthStage?.value ?? null, missingCount: f.missing.length })),
  };
}

export const isAuthFailure = (error: unknown): boolean => error instanceof SimulatorError && error.kind === "http" && (error.status === 401 || error.status === 403);
