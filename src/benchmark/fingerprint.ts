import { createHash } from "node:crypto";
import type { AvailableActions, FarmOverview, FieldObservations } from "../contracts/index.js";

/** Canonical JSON: object keys sorted recursively, so key order can never change a hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sha256 = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * Fingerprint of what an agent can legitimately see at the start of a game. The game id is the only
 * per-game identifier in these responses and is excluded so two independent games can compare equal.
 * This is an agent-API-level check; the database-level check lives in the simulator's `agent:game create-pair`.
 */
const withoutGameId = <T extends { gameId: string }>(value: T): Omit<T, "gameId"> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== "gameId")) as Omit<T, "gameId">;

export function observationFingerprint(input: { overview: FarmOverview; fields: FieldObservations; actions: AvailableActions }) {
  const overview = withoutGameId(input.overview);
  const fields = withoutGameId(input.fields);
  const actions = withoutGameId(input.actions);
  return { overviewSha256: sha256(overview), fieldsSha256: sha256(fields), actionsSha256: sha256(actions), combinedSha256: sha256({ overview, fields, actions }) };
}
