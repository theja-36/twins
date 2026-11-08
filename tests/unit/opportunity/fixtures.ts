import type { MarketRegimeObject, OhlcProvider, OhlcSeries, RegimeProvider } from "../../../packages/agents/src/index";
import { DEFAULT_OPPORTUNITY_CONFIG, type OpportunityConfig } from "../../../packages/opportunity/src/index";

/** 09:46 UTC: the latest COMPLETE 15-minute bar started at 09:30. */
export const NOW = new Date("2031-01-05T09:46:00Z");
export const LAST_BAR = new Date("2031-01-05T09:30:00Z");
export function series(symbol: string, closes: number[], o: { interval?: number; end?: Date; spread?: number; volumes?: Array<number | null> } = {}): OhlcSeries {
  const interval = o.interval ?? 900, end = (o.end ?? LAST_BAR).getTime(), n = closes.length, sp = o.spread ?? 0.2;
  return { symbol, intervalSeconds: interval, bars: closes.map((c, i) => {
    const open = i === 0 ? c : (closes[i - 1] as number);
    return { t: new Date(end - (n - 1 - i) * interval * 1000).toISOString(), open, high: Math.max(open, c) + sp, low: Math.min(open, c) - sp, close: c, volume: o.volumes ? (o.volumes[i] ?? null) : 1000 };
  }) };
}
/** 240 gentle up bars, then a decisive close above the prior highs on double volume: a breakout the existing generator recognises. */
export function breakoutUp(symbol: string): OhlcSeries {
  const closes = Array.from({ length: 239 }, (_, i) => 100 + 0.02 * i); closes.push((closes[238] as number) + 3);
  return series(symbol, closes, { volumes: [...Array(239).fill(1000), 2500] });
}
/** 240 gentle down bars then a close below the prior lows. */
export function breakdownDown(symbol: string): OhlcSeries {
  const closes = Array.from({ length: 239 }, (_, i) => 200 - 0.02 * i); closes.push((closes[238] as number) - 3);
  return series(symbol, closes, { volumes: [...Array(239).fill(1000), 2500] });
}
/** Flat noise: no setup. */
export function flat(symbol: string): OhlcSeries { return series(symbol, Array.from({ length: 240 }, (_, i) => 100 + (i % 2 === 0 ? 0.05 : -0.05))); }
export function provider(map: Record<string, OhlcSeries | null | "throw">, o: { name?: string; asOf?: string | null } = {}): OhlcProvider {
  return { name: o.name ?? "memory-ohlc", asOf: o.asOf === undefined ? NOW.toISOString() : o.asOf, async candles(q) { const v = map[q.symbol]; if (v === "throw") throw new Error("SECRET provider failure text"); return v ?? null; } };
}
export const cfg = (o: Partial<OpportunityConfig> = {}): OpportunityConfig => ({ ...DEFAULT_OPPORTUNITY_CONFIG, enabled: true, universe: ["AAA"], ...o });
export function regime(o: Partial<MarketRegimeObject> = {}): MarketRegimeObject {
  return { version: "market-regime-v1", underlying: "AAA", asOf: NOW.toISOString(), dataSource: "FIXTURE", timeframes: [], direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", correlatedIndexAgreement: "ALIGNED", riskOff: false,
    freshness: { stale: false, usableTimeframes: 3, oldestUsableBarAgeSeconds: 60 }, flags: [], grantsApproval: false, ...o };
}
export const regimeProvider = (r: MarketRegimeObject | null | "throw"): RegimeProvider => ({ name: "memory-regime", async regimeFor() { if (r === "throw") throw new Error("boom"); return r; } });
