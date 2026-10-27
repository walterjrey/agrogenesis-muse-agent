import { TERMINAL_ACTION_STATUSES, type LedgerEntry, type ObservationSummary, type SessionState, type TrackedAction } from "./types.js";

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const diff = (a: number | null | undefined, b: number | null | undefined): number | null => (a != null && b != null ? round(a - b) : null);

export interface EconomicSummary {
  asOfSimTimeS: number;
  credits: number | null;
  /** Simulator-reported cumulative totals. */
  realizedRevenueTotal: number | null;
  realizedOperatingCostsTotal: number | null;
  /** Changes since this session's first observation. */
  sinceSessionStart: { creditsDelta: number | null; revenueDelta: number | null; operatingCostsDelta: number | null };
  inventory: Array<{ product: string; kg: number; pricePerKg: number | null; priceStatus: "known_configured_quote" | "unknown"; estimatedValueCredits: number | null }>;
  /** Estimate = kg x configured quote; it is NOT cash until sold with sellHarvest. Null when any priced product is unknown. */
  estimatedUnsoldValueCredits: number | null;
  fuel: { depotL: number | null; inMachineTanksL: number | null; note: string };
  storageCapacity: "not published by the simulator (unknown)";
  priceSource: string;
  recentHarvestAndSaleEffects: Array<Record<string, unknown>>;
  lastSale: { actionId: string; product: unknown; kg: unknown; revenueCredits: number | null; atSimTimeS: number | null } | null;
  pendingOperations: number;
  notes: string[];
}

/** Compact economic facts from authorized observations and this session's own action results. No forecasts. */
export function buildEconomics(state: SessionState): EconomicSummary | null {
  const { latest, baseline, ledger } = state.metrics;
  if (!latest) return null;
  const prices = latest.marketPricesPerKg;
  const inventory = latest.resources
    .filter((r) => r.kind === "grain" && r.quantity > 0)
    .map((r) => {
      const product = r.id.replace(/^grain-/, "");
      const price = prices?.[product] ?? null;
      return { product, kg: round(r.quantity), pricePerKg: price, priceStatus: price === null ? ("unknown" as const) : ("known_configured_quote" as const), estimatedValueCredits: price === null ? null : round(r.quantity * price) };
    });
  const priced = inventory.every((i) => i.estimatedValueCredits !== null);
  const fuelDepot = latest.resources.find((r) => r.id === "fuel")?.quantity ?? null;
  const fuelTanks = latest.resources.find((r) => r.id === "fuel-in-machine-tanks")?.quantity ?? null;
  const sale = state.actions.filter((a) => a.type === "sellHarvest" && a.status === "completed").at(-1);
  const revenueMeasure = sale ? Object.entries(sale.measurements).find(([k]) => /revenue|credit/i.test(k))?.[1] ?? null : null;
  return {
    asOfSimTimeS: latest.simTimeS,
    credits: latest.credits,
    realizedRevenueTotal: latest.realizedRevenue,
    realizedOperatingCostsTotal: latest.realizedCosts,
    sinceSessionStart: { creditsDelta: diff(latest.credits, baseline?.credits), revenueDelta: diff(latest.realizedRevenue, baseline?.realizedRevenue), operatingCostsDelta: diff(latest.realizedCosts, baseline?.realizedCosts) },
    inventory,
    estimatedUnsoldValueCredits: inventory.length === 0 ? 0 : priced ? round(inventory.reduce((s, i) => s + (i.estimatedValueCredits ?? 0), 0)) : null,
    fuel: { depotL: fuelDepot, inMachineTanksL: fuelTanks, note: "Machines burn their own tank first and only draw depot fuel when a tank cannot cover a job; depot stock alone understates consumption." },
    storageCapacity: "not published by the simulator (unknown)",
    priceSource: prices ? `simulator-configured quote, config v${latest.priceConfigVersion ?? "?"}; the price applied at sale time may differ if the configuration changes` : "unknown (not published); learned only from the result of a sale",
    recentHarvestAndSaleEffects: ledger.slice(-3).map((e) => ({ fromS: e.fromSimTimeS, toS: e.toSimTimeS, harvests: e.harvestActionIds.length, sales: e.sellActionIds.length, grainDeltaKg: e.grainDeltaKg, creditsDelta: e.creditsDelta, revenueDelta: e.revenueDelta, pooled: "stock deltas pooled over all actions finished in this interval" })),
    lastSale: sale ? { actionId: sale.actionId, product: sale.params.product ?? null, kg: sale.params.kg ?? null, revenueCredits: revenueMeasure, atSimTimeS: sale.finishedAtS } : null,
    pendingOperations: state.actions.filter((a) => !TERMINAL_ACTION_STATUSES.has(a.status)).length,
    notes: [
      "Harvested grain stays in the depot and earns no credits until it is sold with sellHarvest.",
      "Estimated values are quote x stock, not cash and not a forecast. Costs of an action are only known from its catalog estimate and, after it finishes, its consumed resources.",
    ],
  };
}

/** Observed change between two authorized observations when this session's harvest/sale actions finished in between. */
export function ledgerEntry(previous: ObservationSummary, summary: ObservationSummary, actions: TrackedAction[]): LedgerEntry | null {
  if (summary.simTimeS <= previous.simTimeS) return null;
  const finishedIn = (type: string) => actions.filter((a) => a.type === type && a.finishedAtS !== null && a.finishedAtS > previous.simTimeS && a.finishedAtS <= summary.simTimeS).map((a) => a.actionId);
  const harvestActionIds = finishedIn("harvestField");
  const sellActionIds = finishedIn("sellHarvest");
  if (harvestActionIds.length + sellActionIds.length === 0) return null;
  const grainDeltaKg: Record<string, number> = {};
  for (const r of summary.resources) {
    if (r.kind !== "grain") continue;
    const before = previous.resources.find((p) => p.id === r.id)?.quantity ?? 0;
    if (Math.abs(r.quantity - before) > 1e-6) grainDeltaKg[r.id] = round(r.quantity - before, 3);
  }
  return { fromSimTimeS: previous.simTimeS, toSimTimeS: summary.simTimeS, harvestActionIds, sellActionIds, grainDeltaKg, creditsDelta: diff(summary.credits, previous.credits), revenueDelta: diff(summary.realizedRevenue, previous.realizedRevenue), costsDelta: diff(summary.realizedCosts, previous.realizedCosts) };
}
