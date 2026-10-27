import type { FarmOverview } from "../contracts/index.js";

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * A strategy-neutral measurement of a farm, derived only from the authorized overview. Both the Muse
 * agent and the deterministic baseline are scored with this same function so results are comparable.
 */
export interface OutcomeSnapshot {
  simDay: number;
  simTimeS: number;
  revision: number;
  credits: number;
  realizedRevenue: number;
  realizedCosts: number;
  /** Grain stock by product, kg. */
  inventoryKg: Record<string, number>;
  /** Published per-kg prices, or null when the simulator did not publish any. */
  marketPricesPerKg: Record<string, number> | null;
  /** Value of the stock at the published prices; products without a price are listed in `unpricedProducts`, not valued. */
  estimatedInventoryValue: number;
  unpricedProducts: string[];
  /** credits + estimatedInventoryValue: an estimate, because unsold stock has not been realized. */
  totalEstimatedValue: number;
  seedKg: Record<string, number>;
  fuelDepotL: number | null;
  fuelInMachineTanksL: number | null;
}

export function outcomeSnapshot(overview: FarmOverview): OutcomeSnapshot {
  const inventoryKg: Record<string, number> = {};
  const seedKg: Record<string, number> = {};
  let fuelDepotL: number | null = null;
  let fuelInMachineTanksL: number | null = null;
  for (const r of overview.resources) {
    if (r.kind === "grain") inventoryKg[r.id.replace(/^grain-/, "")] = r.quantity;
    else if (r.kind === "seed") seedKg[r.id.replace(/^seed-/, "")] = r.quantity;
    else if (r.kind === "fuel") fuelDepotL = r.quantity;
    else if (r.kind === "fuel_in_machines") fuelInMachineTanksL = r.quantity;
  }
  const finance = overview.finance.authorized ? overview.finance : null;
  const prices = finance?.marketPricesPerKg ?? null;
  let value = 0;
  const unpriced: string[] = [];
  for (const [product, kg] of Object.entries(inventoryKg)) {
    const price = prices?.[product];
    if (price === undefined) {
      if (kg > 0) unpriced.push(product);
    } else value += kg * price;
  }
  const credits = finance?.credits ?? 0;
  return {
    simDay: overview.clock.simDay,
    simTimeS: overview.clock.simTimeS,
    revision: overview.revision,
    credits,
    realizedRevenue: finance?.realizedRevenue ?? 0,
    realizedCosts: finance?.realizedCosts ?? 0,
    inventoryKg,
    marketPricesPerKg: prices,
    estimatedInventoryValue: round(value),
    unpricedProducts: unpriced.sort(),
    totalEstimatedValue: round(credits + value),
    seedKg,
    fuelDepotL,
    fuelInMachineTanksL,
  };
}

export interface OutcomeComparison {
  simDaysElapsed: number;
  netCashChange: number;
  realizedRevenue: number;
  operationalExpenses: number;
  initialInventoryKg: Record<string, number>;
  finalInventoryKg: Record<string, number>;
  inventoryChangeKg: Record<string, number>;
  initialEstimatedInventoryValue: number;
  finalEstimatedInventoryValue: number;
  initialTotalEstimatedValue: number;
  finalTotalEstimatedValue: number;
  totalEstimatedValueChange: number;
  seedConsumedKg: Record<string, number>;
  fuelDepotChangeL: number | null;
  fuelInMachineTanksChangeL: number | null;
  notes: string[];
}

/** Revenue and costs are the simulator's cumulative ledger values, so the change is final minus initial. */
export function compareOutcome(initial: OutcomeSnapshot, final: OutcomeSnapshot): OutcomeComparison {
  const products = [...new Set([...Object.keys(initial.inventoryKg), ...Object.keys(final.inventoryKg)])].sort();
  const change = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(products.map((p) => [p, round((b[p] ?? 0) - (a[p] ?? 0), 3)]));
  const seedProducts = [...new Set([...Object.keys(initial.seedKg), ...Object.keys(final.seedKg)])].sort();
  const notes: string[] = [];
  if (initial.marketPricesPerKg === null || final.marketPricesPerKg === null) notes.push("Market prices were not published by the simulator: inventory value is not estimable.");
  if (final.unpricedProducts.length > 0) notes.push(`No published price for: ${final.unpricedProducts.join(", ")} (excluded from the value estimate).`);
  if (JSON.stringify(initial.marketPricesPerKg) !== JSON.stringify(final.marketPricesPerKg)) notes.push("Published prices changed during the run; the initial and final values use different prices.");
  return {
    simDaysElapsed: final.simDay - initial.simDay,
    netCashChange: round(final.credits - initial.credits),
    realizedRevenue: round(final.realizedRevenue - initial.realizedRevenue),
    operationalExpenses: round(final.realizedCosts - initial.realizedCosts),
    initialInventoryKg: initial.inventoryKg,
    finalInventoryKg: final.inventoryKg,
    inventoryChangeKg: change(initial.inventoryKg, final.inventoryKg),
    initialEstimatedInventoryValue: initial.estimatedInventoryValue,
    finalEstimatedInventoryValue: final.estimatedInventoryValue,
    initialTotalEstimatedValue: initial.totalEstimatedValue,
    finalTotalEstimatedValue: final.totalEstimatedValue,
    totalEstimatedValueChange: round(final.totalEstimatedValue - initial.totalEstimatedValue),
    seedConsumedKg: Object.fromEntries(seedProducts.map((p) => [p, round((initial.seedKg[p] ?? 0) - (final.seedKg[p] ?? 0), 3)])),
    fuelDepotChangeL: initial.fuelDepotL === null || final.fuelDepotL === null ? null : round(final.fuelDepotL - initial.fuelDepotL, 3),
    fuelInMachineTanksChangeL: initial.fuelInMachineTanksL === null || final.fuelInMachineTanksL === null ? null : round(final.fuelInMachineTanksL - initial.fuelInMachineTanksL, 3),
    notes,
  };
}
