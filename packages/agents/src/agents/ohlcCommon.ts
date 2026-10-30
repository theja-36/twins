import { AgentUnavailableError } from "../contract";
import type { Collector } from "./common";
import { ohlcProblem, type Candle, type LastPriceProvider, type OhlcProvider } from "./ohlcProviders";
import type { AgentRulesConfig } from "./rules";

/** Shared, fail-closed loading and validation of the candles and the reference price for the Technical Structure and Price-Action agents. */
const MIN = 60_000, DAY = 86_400_000;
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
export interface MarketBars {
  bars: Candle[]; intervalSeconds: number; refPrice: number; priceSource: "last_price" | "last_bar"; lastBarAgeMinutes: number; providerAgeMinutes: number | null; evidenceRef: string;
}
export async function loadMarketBars(o: {
  rules: AgentRulesConfig; ohlc: OhlcProvider | null; price: LastPriceProvider | null; symbol: string; nowMs: number; minBars: number; c: Collector;
}): Promise<MarketBars> {
  const r = o.rules.ohlc;
  if (!o.ohlc) return unavailable("OHLC_PROVIDER_NOT_CONFIGURED", "no OHLC provider is configured; price structure cannot be assessed");
  const now = o.nowMs;
  o.c.check();
  let providerAge: number | null = null;
  if (o.ohlc.asOf === null) o.c.add("CAUTION", "OHLC_AS_OF_UNKNOWN", "The OHLC snapshot carries no snapshot time.");
  else {
    providerAge = (now - Date.parse(o.ohlc.asOf)) / MIN;
    if (Number.isNaN(providerAge)) return unavailable("OHLC_DATA_MALFORMED", "the OHLC provider returned malformed data");
    if (providerAge > r.unavailableMinutes) return unavailable("OHLC_SNAPSHOT_TOO_OLD", "the OHLC snapshot is too old to describe recent price action");
    if (providerAge < -r.futureToleranceMinutes) return unavailable("OHLC_DATA_FROM_FUTURE", "the OHLC snapshot is dated in the future");
    if (providerAge > r.staleCautionMinutes) o.c.add("CAUTION", "OHLC_SNAPSHOT_STALE", `The OHLC snapshot is ${Math.round(providerAge)} minutes old.`, { ageMinutes: Math.round(providerAge) });
  }
  let series;
  try { series = await o.ohlc.candles({ market: r.market, symbol: o.symbol, limit: Math.max(o.minBars, 250), to: new Date(now + r.futureToleranceMinutes * MIN).toISOString() }); } catch { return unavailable("OHLC_PROVIDER_UNAVAILABLE", "the OHLC provider is unavailable"); } // the provider's own message is never stored
  if (series === null) return unavailable("OHLC_DATA_NOT_AVAILABLE", "the OHLC provider has no candles for this underlying");
  if (ohlcProblem(series) !== null) return unavailable("OHLC_DATA_MALFORMED", "the OHLC provider returned malformed data");
  if (typeof series.symbol !== "string" || series.symbol.toUpperCase() !== o.symbol) return unavailable("OHLC_SYMBOL_MISMATCH", "the candles describe a different instrument than the signal's underlying");
  if (series.bars.length < o.minBars) return unavailable("OHLC_HISTORY_INSUFFICIENT", "the OHLC provider returned too little history for the configured lookbacks");
  const last = series.bars[series.bars.length - 1] as Candle;
  const lastAge = (now - Date.parse(last.t)) / MIN;
  if (lastAge < -r.futureToleranceMinutes) return unavailable("OHLC_DATA_FROM_FUTURE", "the latest candle is dated in the future");
  if (lastAge > r.maxBarAgeDays * DAY / MIN) return unavailable("OHLC_DATA_TOO_OLD", "the latest candle is too old to describe recent price action");

  let ref = last.close, source: MarketBars["priceSource"] = "last_bar";
  if (o.price) {
    let p;
    try { p = await o.price.price({ market: r.market, symbol: o.symbol }); } catch { return unavailable("LAST_PRICE_UNAVAILABLE", "the last-price provider is unavailable"); }
    if (p === null) o.c.add("INFO", "LAST_PRICE_MISSING", "The last-price provider has no price; the latest candle's close was used.");
    else {
      if (!p || typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0 || Number.isNaN(Date.parse(p.asOf))) return unavailable("LAST_PRICE_MALFORMED", "the last-price provider returned malformed data");
      const age = (now - Date.parse(p.asOf)) / MIN;
      if (age > r.unavailableMinutes || age < -r.futureToleranceMinutes) o.c.add("CAUTION", "LAST_PRICE_UNUSABLE", "The last price is too old or dated in the future; the latest candle's close was used.");
      else {
        if (age > r.staleCautionMinutes) o.c.add("CAUTION", "LAST_PRICE_STALE", `The last price is ${Math.round(age)} minutes old.`, { ageMinutes: Math.round(age) });
        ref = p.price; source = "last_price";
        const dis = Math.abs(p.price / last.close - 1) * 100;
        if (dis > r.priceDisconnectPct) o.c.add("CAUTION", "PRICE_CANDLE_DISCONNECT", `The last price differs from the latest candle's close by ${Math.round(dis * 100) / 100}%.`, { differencePct: Math.round(dis * 100) / 100 });
      }
    }
  }
  const evidenceRef = `${o.ohlc.name}${o.ohlc.asOf ? `@${o.ohlc.asOf}` : ""}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150);
  return { bars: series.bars, intervalSeconds: series.intervalSeconds, refPrice: ref, priceSource: source, lastBarAgeMinutes: Math.max(0, Math.round(lastAge)), providerAgeMinutes: providerAge === null ? null : Math.max(0, Math.round(providerAge)), evidenceRef };
}
export const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;
