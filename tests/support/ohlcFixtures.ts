import { DEFAULT_AGENT_RULES, memoryLastPrice, memoryOhlcProvider, type AgentRulesConfig, type Candle, type LastPriceProvider, type OhlcProvider } from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";
import { at } from "./calendarMacroFixtures";

/** SYNTHETIC OHLC fixtures (daily bars; the last bar starts at 03:45Z on NOW's day, i.e. 20 minutes before NOW). */
const LAST_START = Date.parse("2025-01-06T03:45:00.000Z");
const DAY = 86_400_000;
export const candle = (open: number, high: number, low: number, close: number, volume: number | null = null): Candle => ({ t: "", open, high, low, close, volume });
/** Stamps consecutive daily start times, the last bar at LAST_START. */
export const stamp = (bars: Candle[]): Candle[] => bars.map((b, i) => ({ ...b, t: new Date(LAST_START - (bars.length - 1 - i) * DAY).toISOString() }));
/** Bars from closes: open = previous close, symmetric wicks. */
export const fromCloses = (closes: number[], wick = 0.5): Candle[] => closes.map((c, i) => { const o = i === 0 ? c : (closes[i - 1] as number); return candle(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c); });
export const wave = (n: number, start: number, step: number, amp = 2, freq = 0.9): number[] => Array.from({ length: n }, (_, i) => start + step * i + amp * Math.sin(i * freq));
/** `n` quiet doji bars around `price` (range 2, so the average range is 2). */
export const quiet = (n: number, price = 100): Candle[] => Array.from({ length: n }, () => candle(price, price + 1, price - 1, price));
export const ohlc = (bars: Candle[], o: { symbol?: string; asOf?: string | null; interval?: number; unstamped?: boolean } = {}): OhlcProvider =>
  memoryOhlcProvider({ name: "synthetic-ohlc", asOf: o.asOf === undefined ? at(-5) : o.asOf, series: { [`NSE:${o.symbol ?? "ACME"}`]: { symbol: o.symbol ?? "ACME", intervalSeconds: o.interval ?? 86_400, bars: o.unstamped ? bars : stamp(bars) } } });
export const lastPrice = (price: number, asOf: string = at(-1), symbol = "ACME"): LastPriceProvider => memoryLastPrice({ name: "synthetic-price", prices: { [`NSE:${symbol}`]: { price, asOf } } });
export const rulesWithOhlc = (over: { ohlc?: Partial<AgentRulesConfig["ohlc"]>; technical?: Partial<AgentRulesConfig["technical"]>; priceAction?: Partial<AgentRulesConfig["priceAction"]> } = {}): AgentRulesConfig => ({
  ...DEFAULT_AGENT_RULES, ohlc: { ...DEFAULT_AGENT_RULES.ohlc, ...over.ohlc }, technical: { ...DEFAULT_AGENT_RULES.technical, ...over.technical }, priceAction: { ...DEFAULT_AGENT_RULES.priceAction, ...over.priceAction },
});
export { NOW };
/** 66 rising wave bars, one small bearish candle (so the run starts fresh), then 3 bullish candles: a clean 70-bar uptrend ending near 113 (a BUY with a stop of 95 is not invalidated). */
export const uptrendBars = (): Candle[] => {
  const closes = wave(66, 80, 0.5, 3, 0.9);
  const s0 = closes[closes.length - 1] as number;
  const bear = candle(s0, s0 + 0.2, s0 - 0.6, s0 - 0.4);
  const run = Array.from({ length: 3 }, (_, i) => { const o = s0 - 0.4 + 0.5 * i, cl = o + 0.5; return candle(o, cl + 0.35, o - 0.35, cl); });
  return [...fromCloses(closes), bear, ...run];
};
