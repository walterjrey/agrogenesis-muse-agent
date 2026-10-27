import type { AvailableActions, FarmOverview } from "../contracts/index.js";
import { outcomeSnapshot } from "../benchmark/outcome.js";

/**
 * Deterministic reference farmer ("baseline v1"). Every rule below reads ONLY what the authorized agent API
 * returns (overview, field observations, available actions) plus this baseline's own memory of the actions
 * it executed itself. It never reads hidden simulator state, never selects randomly and never uses the clock
 * or the model. Given the same observations and memory it always returns the same decision.
 *
 * Rules, in strict priority order (the first rule that applies wins; one action at a time):
 *   R0 horizon   Stop once the simulated-day horizon is reached.
 *   R1 wait      If any operation is active, advance time (stopOn action_completion). Never stack operations.
 *   R2 sell      For each grain product (alphabetical) with at least `minSellKg` in stock and a PUBLISHED price > 0:
 *                sell floor(stock) kg. Rationale: the simulator publishes one fixed price per product and does not
 *                model storage capacity or price movement, so holding stock has no observable benefit and an
 *                unsold harvest earns nothing. Products with no published price are held and the hold is recorded.
 *   R3 harvest   For the first field (by id) whose harvestField is eligible: harvest it. Eligibility is the only
 *                maturity signal the agent API exposes; the baseline does not estimate maturity itself.
 *   R4 plant     For the first field whose plantField is eligible: plant the next crop in `rotation` after the
 *                last crop this baseline planted there (first planting uses rotation[0]). The crop is validated
 *                with a dry run before committing; a rejected crop is put on cooldown and the next one is tried.
 *   R5 prepare   For the first field whose prepareSoil is eligible, that this baseline has not planted, and where
 *                plantField is not eligible: prepareSoil (terminateCrop=false).
 *   R6 idle      Otherwise advance time by `checkpointDays` (stopOn any_event).
 *
 * Deliberately NOT done (documented limitation, see docs/BENCHMARK_FOUNDATION.md): inspections, irrigation and
 * pest treatment. There is no observable, calibrated moisture or pest threshold to trigger them from, and
 * inspections cost credits; a baseline that guesses thresholds would be an arbitrary strategy, not a reference.
 */
export interface BaselineConfig {
  horizonDays: number;
  checkpointDays: number;
  waitChunkS: number;
  rotation: string[];
  minSellKg: number;
  rejectionCooldownS: number;
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  horizonDays: 200,
  checkpointDays: 5,
  waitChunkS: 30,
  rotation: ["soybean", "corn", "wheat"],
  minSellKg: 1,
  rejectionCooldownS: 60,
};

export const DAY_S = 60;

export interface FieldMemory {
  state: "unknown" | "growing" | "harvested";
  lastCrop: string | null;
  plantedAtSimTimeS: number | null;
}

export interface BaselineMemory {
  fields: Record<string, FieldMemory>;
  /** key -> simulated time until which the same request must not be retried after a rejection. */
  cooldowns: Record<string, number>;
  /** Simulated time of the latest observation, used to date cooldowns. */
  nowS: number;
}

export const newMemory = (): BaselineMemory => ({ fields: {}, cooldowns: {}, nowS: 0 });

export interface BaselineView {
  overview: FarmOverview;
  actions: AvailableActions;
}

interface DecisionBase {
  rule: string;
  reason: string;
  /** Explicit "not selling / not acting" decisions considered while choosing. */
  holds: string[];
}

export type Decision =
  | (DecisionBase & { kind: "execute"; type: string; params: Record<string, unknown>; cooldownKey: string; preflight: boolean })
  | (DecisionBase & { kind: "advance"; seconds: number; stopOn: Array<"action_completion" | "any_event"> })
  | (DecisionBase & { kind: "stop" });

const eligibleTargets = (actions: AvailableActions, type: string): string[] =>
  actions.actions.filter((a) => a.type === type && a.eligibility.eligible && a.target !== null).map((a) => a.target!.id).sort();

export function decide(view: BaselineView, memory: BaselineMemory, config: BaselineConfig): Decision {
  const { overview, actions } = view;
  const now = overview.clock.simTimeS;
  const horizonS = config.horizonDays * DAY_S;
  const holds: string[] = [];
  if (now >= horizonS) return { kind: "stop", rule: "R0_horizon", reason: `Horizon of ${config.horizonDays} simulated days reached.`, holds };
  const remainingS = horizonS - now;
  const free = (key: string) => (memory.cooldowns[key] ?? -1) <= now;

  if (overview.status.activeActionCount > 0) {
    return { kind: "advance", rule: "R1_wait", reason: `${overview.status.activeActionCount} operation(s) active; waiting for completion.`, seconds: Math.min(config.waitChunkS, remainingS), stopOn: ["action_completion"], holds };
  }

  const outcome = outcomeSnapshot(overview);
  for (const product of Object.keys(outcome.inventoryKg).sort()) {
    const kg = outcome.inventoryKg[product] ?? 0;
    if (kg < config.minSellKg) continue;
    const price = outcome.marketPricesPerKg?.[product];
    if (price === undefined || !(price > 0)) {
      holds.push(`hold ${product} ${kg} kg: no published price`);
      continue;
    }
    const key = `sellHarvest:${product}`;
    if (!free(key)) {
      holds.push(`hold ${product} ${kg} kg: sale recently rejected`);
      continue;
    }
    const sellKg = Math.floor(kg);
    return { kind: "execute", rule: "R2_sell", reason: `Sell ${sellKg} kg ${product} at the published ${price}/kg (no storage or price dynamics are observable, so holding earns nothing).`, type: "sellHarvest", params: { product, kg: sellKg }, cooldownKey: key, preflight: false, holds };
  }

  for (const fieldId of eligibleTargets(actions, "harvestField")) {
    const key = `harvestField:${fieldId}`;
    if (!free(key)) continue;
    return { kind: "execute", rule: "R3_harvest", reason: `harvestField is eligible on ${fieldId} (the simulator's maturity signal).`, type: "harvestField", params: { fieldId }, cooldownKey: key, preflight: false, holds };
  }

  const plantable = eligibleTargets(actions, "plantField");
  for (const fieldId of plantable) {
    const last = memory.fields[fieldId]?.lastCrop ?? null;
    const start = last === null ? 0 : (config.rotation.indexOf(last) + 1) % config.rotation.length;
    const seedKg = outcome.seedKg;
    for (let i = 0; i < config.rotation.length; i++) {
      const crop = config.rotation[(start + i) % config.rotation.length]!;
      if ((seedKg[crop] ?? 0) <= 0) {
        holds.push(`skip ${crop} on ${fieldId}: no ${crop} seed in stock`);
        continue;
      }
      const key = `plantField:${fieldId}:${crop}`;
      if (!free(key)) continue;
      return { kind: "execute", rule: "R4_plant", reason: `plantField is eligible on ${fieldId}; next rotation crop after ${last ?? "none"} is ${crop}.`, type: "plantField", params: { fieldId, crop }, cooldownKey: key, preflight: true, holds };
    }
  }

  for (const fieldId of eligibleTargets(actions, "prepareSoil")) {
    if (plantable.includes(fieldId)) continue;
    if (memory.fields[fieldId]?.state === "growing") continue;
    const key = `prepareSoil:${fieldId}`;
    if (!free(key)) continue;
    return { kind: "execute", rule: "R5_prepare", reason: `prepareSoil is eligible on ${fieldId}, which is not planted by this baseline and not yet plantable.`, type: "prepareSoil", params: { fieldId, terminateCrop: false }, cooldownKey: key, preflight: false, holds };
  }

  return { kind: "advance", rule: "R6_idle", reason: "Nothing eligible to do; advancing one checkpoint.", seconds: Math.min(config.checkpointDays * DAY_S, remainingS), stopOn: ["any_event"], holds };
}

/** Learn only from this baseline's own completed actions (never from hidden state). */
export function learn(memory: BaselineMemory, action: { type: string; params: Record<string, unknown>; status: string; finishedAtS: number | null }): void {
  if (action.status !== "completed") return;
  const fieldId = typeof action.params.fieldId === "string" ? action.params.fieldId : null;
  if (!fieldId) return;
  const prev = memory.fields[fieldId] ?? { state: "unknown" as const, lastCrop: null, plantedAtSimTimeS: null };
  if (action.type === "plantField" && typeof action.params.crop === "string") {
    memory.fields[fieldId] = { state: "growing", lastCrop: action.params.crop, plantedAtSimTimeS: action.finishedAtS };
  } else if (action.type === "harvestField") {
    memory.fields[fieldId] = { ...prev, state: "harvested" };
  }
}
