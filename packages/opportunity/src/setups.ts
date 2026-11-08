import { detectPatterns, rsi, swings, type Candle, type OhlcSeries } from "@twins/agents";
import { DEFAULT_INDEPENDENT_POLICY, generateCandidates, type Strategy } from "@twins/signals";

/**
 * Setup detection (Module 16, technical and price-action intelligence). PURE. It REUSES the existing rule-based generator for breakout / breakdown / pullback and the existing swing, RSI and candle-pattern
 * helpers for reversal and momentum, and adds only what was missing: reversal and momentum rules, an explicit invalidation condition and a series resampler for multi-timeframe confluence.
 * RULE: every setup carries a protective stop and an invalidation level; nothing here is calibrated, backtested or an instruction to trade.
 */
export const SETUP_DETECTOR_VERSION = "opportunity-setups-v1";
export type SetupClass = "BREAKOUT_LONG" | "BREAKDOWN_SHORT" | "PULLBACK_LONG" | "REVERSAL_LONG" | "REVERSAL_SHORT" | "MOMENTUM_LONG" | "MOMENTUM_SHORT";
/** The coarse setup vocabulary stored in `opportunity_candidates.setup` (the Stage 02 SETUPS list). */
export const COARSE_SETUP: Record<SetupClass, "BREAKOUT" | "REVERSAL" | "MOMENTUM" | "OTHER"> = {
  BREAKOUT_LONG: "BREAKOUT", BREAKDOWN_SHORT: "BREAKOUT", PULLBACK_LONG: "OTHER", REVERSAL_LONG: "REVERSAL", REVERSAL_SHORT: "REVERSAL", MOMENTUM_LONG: "MOMENTUM", MOMENTUM_SHORT: "MOMENTUM",
};
export interface Invalidation { price: number; breachWhen: "BELOW" | "ABOVE"; condition: string }
export interface SetupSignal {
  setup: SetupClass; side: "BUY" | "SELL"; timeframeSeconds: number; entry: number; stop: number; targets: number[]; riskPerUnit: number;
  invalidation: Invalidation; reasons: string[]; signalBarAt: string; volumeConfirmed: boolean | null;
}
export interface SetupPolicy { minBars: number; atrWindow: number; stopAtrMultiple: number; minStopPct: number; targetsR: [number, number, number]; fastMa: number; slowMa: number; rsiPeriod: number; swingK: number; swingLookback: number; reversalAtrReach: number; patternMinBodyAtr: number; patternWickRatio: number }
export const DEFAULT_SETUP_POLICY: SetupPolicy = { minBars: 60, atrWindow: 14, stopAtrMultiple: 1.5, minStopPct: 0.3, targetsR: [1, 2, 3], fastMa: 20, slowMa: 50, rsiPeriod: 14, swingK: 2, swingLookback: 12, reversalAtrReach: 1, patternMinBodyAtr: 0.3, patternWickRatio: 0.6 };
const r2 = (x: number): number => Math.round(x * 100) / 100;
const sma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function atrOf(bars: readonly Candle[], window: number): number | null {
  if (bars.length < window + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) { const b = bars[i] as Candle, pc = (bars[i - 1] as Candle).close; tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))); }
  const v = sma(tr.slice(-window));
  return Number.isFinite(v) && v > 0 ? v : null;
}
const setupFrom = (setup: SetupClass, side: "BUY" | "SELL", tf: number, last: Candle, entry: number, stop: number, p: SetupPolicy, reasons: string[], vol: boolean | null, why: string): SetupSignal | null => {
  const s = side === "BUY" ? 1 : -1, risk = Math.abs(entry - stop);
  if (!(risk > 0) || (side === "BUY" ? stop >= entry : stop <= entry)) return null;
  const targets = p.targetsR.map((r) => r2(entry + s * risk * r));
  return { setup, side, timeframeSeconds: tf, entry: r2(entry), stop: r2(stop), targets, riskPerUnit: r2(risk), invalidation: { price: r2(stop), breachWhen: side === "BUY" ? "BELOW" : "ABOVE", condition: why }, reasons, signalBarAt: last.t, volumeConfirmed: vol };
};

/** Detects zero or more setups on the LAST bar of a validated series (oldest first). Returns [] for short, malformed or degenerate data: never a guess. */
export function detectSetups(series: OhlcSeries, symbol: string, policy: SetupPolicy = DEFAULT_SETUP_POLICY): SetupSignal[] {
  const bars = series.bars, p = policy;
  if (bars.length < p.minBars) return [];
  const last = bars[bars.length - 1] as Candle, tf = series.intervalSeconds, out: SetupSignal[] = [];
  const atr = atrOf(bars, p.atrWindow);
  if (atr === null) return [];
  const minRisk = last.close * (p.minStopPct / 100);

  // 1. breakout / breakdown / pullback: the existing generator (its own stop, targets and reasons), wrapped with an invalidation condition
  const base = generateCandidates(symbol, bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), null, [], { ...DEFAULT_INDEPENDENT_POLICY, atrWindow: p.atrWindow, stopAtrMultiple: p.stopAtrMultiple, minStopPct: p.minStopPct, targetsR: p.targetsR });
  const MAP: Record<Strategy, SetupClass> = { BREAKOUT_LONG: "BREAKOUT_LONG", BREAKDOWN_SHORT: "BREAKDOWN_SHORT", PULLBACK_LONG: "PULLBACK_LONG" };
  for (const c of base) {
    const vol = c.reasons.includes("VOLUME_CONFIRMED") ? true : c.reasons.includes("VOLUME_UNKNOWN") ? null : null;
    const why = c.side === "BUY" ? "a close below the protective stop voids the long thesis" : "a close above the protective stop voids the short thesis";
    const sig = setupFrom(MAP[c.strategy], c.side, tf, last, c.entry, c.stop, p, c.reasons, vol, why);
    if (sig) out.push({ ...sig, targets: [...c.targets] });
  }

  const closes = bars.map((b) => b.close), highs = bars.map((b) => b.high), lows = bars.map((b) => b.low);
  const rsiNow = rsi(closes.slice(-(p.rsiPeriod * 4)), p.rsiPeriod);
  const fast = sma(closes.slice(-p.fastMa)), slow = sma(closes.slice(-p.slowMa));

  // 2. reversal: a rejection / engulfing pattern on the last bar, at a recent swing extreme, with RSI stretched the same way
  const sw = swings(highs, lows, p.swingK), fromIdx = bars.length - 1 - p.swingLookback;
  const patterns = detectPatterns(bars, bars.length - 1, atr, { minBodyAtr: p.patternMinBodyAtr, wickRatio: p.patternWickRatio });
  const bull = patterns.filter((x) => x.bias === 1).map((x) => x.name), bear = patterns.filter((x) => x.bias === -1).map((x) => x.name);
  const swLow = [...sw.lows].reverse().find((x) => x.i >= fromIdx), swHigh = [...sw.highs].reverse().find((x) => x.i >= fromIdx);
  if (bull.length && swLow && last.low <= swLow.v + p.reversalAtrReach * atr && rsiNow <= 40) {
    const stop = Math.min(swLow.v, last.low) - 0.25 * atr, entry = last.close;
    const sig = setupFrom("REVERSAL_LONG", "BUY", tf, last, entry, Math.min(stop, entry - minRisk), p, [...bull, "AT_RECENT_SWING_LOW", "RSI_STRETCHED_LOW"], null, "a break below the swing low and the pattern bar's low voids the reversal");
    if (sig) out.push(sig);
  }
  if (bear.length && swHigh && last.high >= swHigh.v - p.reversalAtrReach * atr && rsiNow >= 60) {
    const stop = Math.max(swHigh.v, last.high) + 0.25 * atr, entry = last.close;
    const sig = setupFrom("REVERSAL_SHORT", "SELL", tf, last, entry, Math.max(stop, entry + minRisk), p, [...bear, "AT_RECENT_SWING_HIGH", "RSI_STRETCHED_HIGH"], null, "a break above the swing high and the pattern bar's high voids the reversal");
    if (sig) out.push(sig);
  }

  // 3. momentum: trend stack (fast vs slow) + RSI in the trending-but-not-exhausted band + price on the right side of the fast average with positive 5-bar change
  const roc = last.close - (bars[bars.length - 6] as Candle).close;
  if (fast > slow && last.close > fast && rsiNow >= 55 && rsiNow <= 75 && roc >= atr) {
    const sig = setupFrom("MOMENTUM_LONG", "BUY", tf, last, last.close, last.close - Math.max(p.stopAtrMultiple * atr, minRisk), p, ["FAST_ABOVE_SLOW", "CLOSE_ABOVE_FAST", "RSI_IN_TREND_BAND", "ROC5_AT_LEAST_ATR"], null, "a close below the momentum stop voids the long thesis");
    if (sig) out.push(sig);
  }
  if (fast < slow && last.close < fast && rsiNow <= 45 && rsiNow >= 25 && -roc >= atr) {
    const sig = setupFrom("MOMENTUM_SHORT", "SELL", tf, last, last.close, last.close + Math.max(p.stopAtrMultiple * atr, minRisk), p, ["FAST_BELOW_SLOW", "CLOSE_BELOW_FAST", "RSI_IN_TREND_BAND", "ROC5_AT_LEAST_ATR"], null, "a close above the momentum stop voids the short thesis");
    if (sig) out.push(sig);
  }
  return out;
}

/** Aggregates a series into COMPLETE buckets of `targetSeconds` aligned on the epoch. A trailing partial bucket is dropped (never a half-formed bar). Returns null when the target is not a multiple of the source interval. */
export function resample(series: OhlcSeries, targetSeconds: number): OhlcSeries | null {
  if (!Number.isInteger(targetSeconds) || targetSeconds <= series.intervalSeconds || targetSeconds % series.intervalSeconds !== 0) return null;
  const per = targetSeconds / series.intervalSeconds, ms = targetSeconds * 1000, buckets = new Map<number, Candle[]>();
  for (const b of series.bars) { const k = Math.floor(Date.parse(b.t) / ms); const a = buckets.get(k); if (a) a.push(b); else buckets.set(k, [b]); }
  const out: Candle[] = [];
  for (const [k, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length !== per) continue; // incomplete bucket: skip, never extrapolate
    const vols = bs.map((b) => b.volume);
    out.push({ t: new Date(k * ms).toISOString(), open: (bs[0] as Candle).open, high: Math.max(...bs.map((b) => b.high)), low: Math.min(...bs.map((b) => b.low)), close: (bs[bs.length - 1] as Candle).close, volume: vols.some((v) => v === null) ? null : vols.reduce<number>((a, v) => a + (v as number), 0) });
  }
  return { symbol: series.symbol, intervalSeconds: targetSeconds, bars: out };
}

/** The higher-timeframe trend from fast/slow moving averages: BULLISH, BEARISH, NEUTRAL or UNKNOWN when there is too little history. */
export function trendOf(series: OhlcSeries | null, p: SetupPolicy = DEFAULT_SETUP_POLICY): "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN" {
  if (!series || series.bars.length < p.slowMa) return "UNKNOWN";
  const closes = series.bars.map((b) => b.close), fast = sma(closes.slice(-p.fastMa)), slow = sma(closes.slice(-p.slowMa)), last = closes[closes.length - 1] as number;
  if (fast > slow && last > slow) return "BULLISH";
  if (fast < slow && last < slow) return "BEARISH";
  return "NEUTRAL";
}
