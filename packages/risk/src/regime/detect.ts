/**
 * Market-regime detector (P1 #7). PURE, descriptive: classifies the recent bars of one instrument as TRENDING_UP, TRENDING_DOWN, RANGE_BOUND, HIGH_VOLATILITY, LOW_VOLATILITY or UNKNOWN from three measures
 * (efficiency ratio, trend slope relative to ATR, and short-over-long realised volatility). Fewer bars than needed, or any malformed bar, gives UNKNOWN with a reason; nothing is guessed. It emits the
 * `volatilityRatio` that the reduce-only sizing shadow expects as an input. Evidence only: it changes no limit and approves nothing.
 */
export const REGIME_VERSION = "regime-detector-v1";
export interface RegimeBar { open: number; high: number; low: number; close: number }
export type Regime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE_BOUND" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "UNKNOWN";
export interface RegimePolicy { shortWindow: number; longWindow: number; atrWindow: number; highVolRatio: number; lowVolRatio: number; trendEfficiency: number; trendSlopeAtr: number }
export const DEFAULT_REGIME_POLICY: RegimePolicy = { shortWindow: 10, longWindow: 40, atrWindow: 14, highVolRatio: 1.5, lowVolRatio: 0.6, trendEfficiency: 0.35, trendSlopeAtr: 1 };
export interface RegimeResult {
  version: typeof REGIME_VERSION; regime: Regime; reasons: string[];
  volatilityRatio: number | null; efficiencyRatio: number | null; slopeInAtr: number | null; atrPct: number | null; barsUsed: number;
  grantsApproval: false;
}
const round = (x: number): number => Math.round(x * 1e4) / 1e4;
const stdev = (xs: number[]): number => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const unknown = (reason: string, n: number): RegimeResult => ({ version: REGIME_VERSION, regime: "UNKNOWN", reasons: [reason], volatilityRatio: null, efficiencyRatio: null, slopeInAtr: null, atrPct: null, barsUsed: n, grantsApproval: false });

/** `bars` oldest first. */
export function detectRegime(bars: readonly RegimeBar[], policy: RegimePolicy = DEFAULT_REGIME_POLICY): RegimeResult {
  const p = policy;
  if (!(p.shortWindow >= 2 && p.longWindow > p.shortWindow && p.atrWindow >= 2 && p.highVolRatio > 1 && p.lowVolRatio > 0 && p.lowVolRatio < 1)) throw new Error("invalid regime policy");
  const need = p.longWindow + 1;
  if (bars.length < need) return unknown("INSUFFICIENT_BARS", bars.length);
  const b = bars.slice(-need);
  for (const x of b) if (![x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v) && v > 0) || x.high < x.low || x.close > x.high || x.close < x.low || x.open > x.high || x.open < x.low) return unknown("MALFORMED_BAR", bars.length);
  const closes = b.map((x) => x.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log((closes[i] as number) / (closes[i - 1] as number)));
  const longSd = stdev(rets), shortSd = stdev(rets.slice(-p.shortWindow));
  if (longSd === 0) return unknown("ZERO_LONG_VOLATILITY", bars.length);
  const volatilityRatio = round(shortSd / longSd);
  const tr: number[] = [];
  for (let i = 1; i < b.length; i++) { const x = b[i] as RegimeBar, pc = (b[i - 1] as RegimeBar).close; tr.push(Math.max(x.high - x.low, Math.abs(x.high - pc), Math.abs(x.low - pc))); }
  const atr = tr.slice(-p.atrWindow).reduce((a, c) => a + c, 0) / p.atrWindow;
  const last = closes[closes.length - 1] as number;
  const window = closes.slice(-p.shortWindow - 1);
  const net = (window[window.length - 1] as number) - (window[0] as number);
  let path = 0; for (let i = 1; i < window.length; i++) path += Math.abs((window[i] as number) - (window[i - 1] as number));
  const efficiencyRatio = path === 0 ? 0 : round(Math.abs(net) / path);
  const slopeInAtr = atr === 0 ? 0 : round(net / atr);
  const atrPct = round((atr / last) * 100);
  const base = { version: REGIME_VERSION as typeof REGIME_VERSION, volatilityRatio, efficiencyRatio, slopeInAtr, atrPct, barsUsed: need, grantsApproval: false as const };
  if (volatilityRatio >= p.highVolRatio) return { ...base, regime: "HIGH_VOLATILITY", reasons: ["SHORT_VOL_ABOVE_LONG_VOL"] };
  if (efficiencyRatio >= p.trendEfficiency && Math.abs(slopeInAtr) >= p.trendSlopeAtr) return { ...base, regime: net > 0 ? "TRENDING_UP" : "TRENDING_DOWN", reasons: ["EFFICIENT_DIRECTIONAL_MOVE"] };
  if (volatilityRatio <= p.lowVolRatio) return { ...base, regime: "LOW_VOLATILITY", reasons: ["SHORT_VOL_BELOW_LONG_VOL"] };
  return { ...base, regime: "RANGE_BOUND", reasons: ["NO_EFFICIENT_DIRECTION"] };
}
