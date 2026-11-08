import { describe, expect, it } from "vitest";
import { IV_MIN_HISTORY, MAX_BAR_AGE_SECONDS, analyzeMarketRegime, eventRiskOf, ivRegime, toRegimeRows, type RegimeInput, type TimedBar, type Timeframe } from "../../../packages/agents/src/regime/index";

const NOW = new Date("2026-11-09T06:00:00Z");
const STEP: Record<Timeframe, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
/** `n` bars ending `agoSec` before NOW. drift is the per-bar move in percent; the last `burst` bars use a larger oscillation. */
function series(tf: Timeframe, o: { n?: number; drift?: number; noise?: number; burst?: number; burstNoise?: number; agoSec?: number } = {}): TimedBar[] {
  const n = o.n ?? 60, out: TimedBar[] = []; let price = 24000;
  for (let i = 0; i < n; i++) {
    const inBurst = i >= n - (o.burst ?? 0), amp = (inBurst ? (o.burstNoise ?? 0) : (o.noise ?? 0.05)) / 100;
    const open = price, close = price * (1 + (o.drift ?? 0) / 100 + (i % 2 === 0 ? amp : -amp));
    out.push({ open, close, high: Math.max(open, close) * 1.0004, low: Math.min(open, close) * 0.9996, at: new Date(NOW.getTime() - (o.agoSec ?? 60) * 1000 - (n - 1 - i) * STEP[tf]) }); price = close;
  }
  return out;
}
const all = (o: Parameters<typeof series>[1] = {}) => (["5m", "15m", "1h"] as const).map((tf) => ({ timeframe: tf, bars: series(tf, o) }));
const base = (over: Partial<RegimeInput> = {}): RegimeInput => ({ underlying: "nifty", timeframes: all({ drift: 0.15 }), now: NOW, dataSource: "FIXTURE", ...over });

describe("market regime analysis", () => {
  it("reads a steady uptrend on every timeframe as bullish and trending, with evidence of each timeframe", () => {
    const r = analyzeMarketRegime(base());
    expect(r).toMatchObject({ underlying: "NIFTY", direction: "BULLISH", regime: "TRENDING_UP", riskOff: false, grantsApproval: false, dataSource: "FIXTURE" });
    expect(r.timeframes.map((t) => [t.timeframe, t.status, t.direction])).toEqual([["5m", "OK", "BULLISH"], ["15m", "OK", "BULLISH"], ["1h", "OK", "BULLISH"]]);
    expect(r.freshness).toMatchObject({ stale: false, usableTimeframes: 3 });
  });
  it("a flat, quiet market is neutral and range-bound or low-volatility, never a direction", () => {
    const r = analyzeMarketRegime(base({ timeframes: all({ drift: 0, noise: 0.02 }) }));
    expect(r.direction).toBe("NEUTRAL"); expect(["RANGE_BOUND", "LOW_VOLATILITY"]).toContain(r.regime);
  });
  it("timeframes that disagree give NEUTRAL and say so", () => {
    const r = analyzeMarketRegime(base({ timeframes: [{ timeframe: "5m", bars: series("5m", { drift: -0.15 }) }, { timeframe: "15m", bars: series("15m", { drift: 0.15 }) }, { timeframe: "1h", bars: series("1h", { drift: 0.15 }) }] }));
    expect(r.direction).toBe("NEUTRAL"); expect(r.flags).toContain("timeframes_disagree");
  });
  it("missing, thin, stale or future-dated series are UNKNOWN and flagged: nothing is guessed", () => {
    const thin = analyzeMarketRegime(base({ timeframes: [{ timeframe: "5m", bars: series("5m", { n: 10 }) }] }));
    expect(thin).toMatchObject({ direction: "UNKNOWN", regime: "UNKNOWN" }); expect(thin.flags).toContain("insufficient_timeframes");
    const stale = analyzeMarketRegime(base({ timeframes: all({ drift: 0.15, agoSec: MAX_BAR_AGE_SECONDS["5m"] + 4 * 3600 }) }));
    expect(stale.timeframes.some((t) => t.status === "STALE")).toBe(true); expect(stale.freshness.stale).toBe(true); expect(stale.direction).toBe("UNKNOWN");
    const future = analyzeMarketRegime(base({ timeframes: all({ drift: 0.15, agoSec: -600 }) }));
    expect(future.timeframes.every((t) => t.reasons.includes("FUTURE_DATED_BAR"))).toBe(true); expect(future.direction).toBe("UNKNOWN");
    expect(analyzeMarketRegime(base({ timeframes: [] })).asOf).toBeNull();
  });
  it("a volatility burst raises the volatility regime", () => {
    const r = analyzeMarketRegime(base({ timeframes: all({ drift: 0, noise: 0.03, burst: 10, burstNoise: 0.6 }) }));
    expect(["HIGH", "EXTREME"]).toContain(r.volatilityRegime);
  });
  it("RISK_OFF needs high volatility AND bearish agreement on at least two timeframes", () => {
    const down = all({ drift: -0.2, noise: 0.03, burst: 10, burstNoise: 0.7 });
    const r = analyzeMarketRegime(base({ timeframes: down }));
    expect(r.riskOff).toBe(r.volatilityRegime === "HIGH" || r.volatilityRegime === "EXTREME" ? r.direction === "BEARISH" : false);
    const calmDown = analyzeMarketRegime(base({ timeframes: all({ drift: -0.15, noise: 0.03 }) })); expect(calmDown.riskOff).toBe(false); expect(calmDown.direction).toBe("BEARISH");
  });
  it("implied volatility is ranked against its own history; thin history gives no rank", () => {
    const hist = Array.from({ length: 100 }, (_, i) => 10 + i * 0.1);
    expect(analyzeMarketRegime(base({ impliedVol: { current: 19.95, history: hist } })).impliedVolatility).toMatchObject({ percentileRank: 100, regime: "EXTREME" });
    expect(analyzeMarketRegime(base({ impliedVol: { current: 10.2, history: hist } })).impliedVolatility).toMatchObject({ regime: "LOW" });
    const thin = analyzeMarketRegime(base({ impliedVol: { current: 15, history: hist.slice(0, IV_MIN_HISTORY - 1) } })); expect(thin.impliedVolatility?.percentileRank).toBeNull(); expect(thin.flags).toContain("iv_history_thin");
    expect(analyzeMarketRegime(base()).flags).toContain("iv_unavailable");
    expect(ivRegime(null)).toBe("UNKNOWN");
  });
  it("event risk follows the time to the next high-impact event; unknown stays unknown", () => {
    expect([1, 10, 48, 100].map(eventRiskOf)).toEqual(["HIGH", "ELEVATED", "LOW", "NONE"]); expect(eventRiskOf(null)).toBe("UNKNOWN"); expect(eventRiskOf(-1)).toBe("UNKNOWN");
    expect(analyzeMarketRegime(base()).flags).toContain("event_risk_unknown");
  });
  it("correlated indices: aligned, mixed or unknown", () => {
    expect(analyzeMarketRegime(base({ siblingDirections: { BANKNIFTY: "BULLISH" } })).correlatedIndexAgreement).toBe("ALIGNED");
    expect(analyzeMarketRegime(base({ siblingDirections: { BANKNIFTY: "BEARISH" } })).correlatedIndexAgreement).toBe("MIXED");
    expect(analyzeMarketRegime(base({ siblingDirections: { BANKNIFTY: "UNKNOWN" } })).correlatedIndexAgreement).toBe("UNKNOWN"); expect(analyzeMarketRegime(base()).correlatedIndexAgreement).toBe("UNKNOWN");
  });
  it("stores only what is known: one row per usable timeframe, none for an unknown reading", () => {
    const rows = toRegimeRows(analyzeMarketRegime(base()));
    expect(rows.map((r) => r.timeframe)).toEqual(["5m", "15m", "1h"]); expect(rows[0]).toMatchObject({ underlying: "NIFTY", dataSource: "FIXTURE", detectorVersion: "market-regime-v1" });
    expect(toRegimeRows(analyzeMarketRegime(base({ timeframes: [] })))).toEqual([]);
  });
  it("is deterministic", () => { expect(analyzeMarketRegime(base())).toEqual(analyzeMarketRegime(base())); });
});
