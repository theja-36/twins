import type { Db } from "../../../packages/database/src/index";
import { evaluateMarketRisk, evaluatePortfolioRisk, type MarketDataProvider, type MarketDataQuery, type MarketSnapshot, type PortfolioOptions } from "../../../packages/risk/src/index";

/** A Wednesday, 10:00 IST (04:30 UTC), in the past: the India session is open, and no decision created "now" can be stale against it. */
export const OPEN_NOW = new Date("2024-06-12T04:30:00Z");

/** A healthy synthetic snapshot taken 5 seconds before `now` (equity-sized liquidity; override per case). */
export function healthy(now: Date = OPEN_NOW, over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { last: 100, bid: 99.95, ask: 100.05, bidQty: 5_000, askQty: 5_000, volume: 1_000_000, openInterest: 50_000, timestamp: new Date(now.getTime() - 5_000), ...over };
}

/** An injected SYNTHETIC provider (no live market data is used anywhere). */
export function syntheticProvider(snapshot: MarketSnapshot | null | ((q: MarketDataQuery) => MarketSnapshot | null | Promise<MarketSnapshot | null>), calls: MarketDataQuery[] = []): MarketDataProvider {
  return { name: "synthetic-test", getSnapshot: async (q) => { calls.push(q); return typeof snapshot === "function" ? snapshot(q) : snapshot; } };
}

/** sized -> portfolio -> market gates with a healthy synthetic provider: the only way a decision becomes APPROVED_FOR_REVIEW. */
export async function approveThroughGates(db: Db, sizedDecisionId: string, portfolio: PortfolioOptions, now: Date = OPEN_NOW) {
  const pf = await evaluatePortfolioRisk(db, sizedDecisionId, portfolio);
  if (pf.status !== "PENDING") return { pf, market: null };
  const market = await evaluateMarketRisk(db, pf.id, { provider: syntheticProvider(healthy(now)), now, capital: portfolio.capital ?? null });
  return { pf, market };
}
