import { detectRegime, type RegimeBar, type RegimePolicy, DEFAULT_REGIME_POLICY } from "@twins/risk";

/**
 * Market regime analysis (Module 05). PURE and deterministic, built on the existing single-series detector (`detectRegime`). It combines the 5-minute, 15-minute and 1-hour series into one
 * structured regime object: direction, regime, volatility regime, implied-volatility rank, event risk, correlated-index agreement and evidence freshness.
 * RULE: missing, thin, stale or malformed evidence yields UNKNOWN (and a flag), never a guess and never a positive reading. Evidence only: it changes no limit and approves nothing.
 */
export const MARKET_REGIME_VERSION = "market-regime-v1";
export const TIMEFRAMES = ["5m", "15m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
export type OverallRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE_BOUND" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "RISK_OFF" | "UNKNOWN";
export type VolRegime = "LOW" | "NORMAL" | "HIGH" | "EXTREME" | "UNKNOWN";
export type EventRisk = "NONE" | "LOW" | "ELEVATED" | "HIGH" | "UNKNOWN";
export type DataSource = "FIXTURE" | "LIVE" | "HISTORICAL";

export interface TimedBar extends RegimeBar { at: Date }
export interface TimeframeBars { timeframe: Timeframe; bars: readonly TimedBar[] }
export interface RegimeInput {
  underlying: string; timeframes: readonly TimeframeBars[]; now: Date; dataSource: DataSource;
  impliedVol?: { current: number; history: readonly number[] } | null; hoursToHighImpactEvent?: number | null;
  /** Directions of correlated indices (for example NIFTY and BANKNIFTY), when known. */
  siblingDirections?: Record<string, Direction> | null;
  policy?: RegimePolicy;
}
export interface TimeframeReading {
  timeframe: Timeframe; status: "OK" | "UNKNOWN" | "STALE"; regime: string; direction: Direction;
  volatilityRatio: number | null; efficiencyRatio: number | null; slopeInAtr: number | null; atrPct: number | null; barsUsed: number; reasons: string[]; lastBarAgeSeconds: number | null;
}
export interface MarketRegimeObject {
  version: string; underlying: string; asOf: string | null; dataSource: DataSource;
  timeframes: TimeframeReading[]; direction: Direction; regime: OverallRegime; volatilityRegime: VolRegime;
  impliedVolatility: { current: number; percentileRank: number | null; regime: VolRegime } | null;
  eventRisk: EventRisk; correlatedIndexAgreement: "ALIGNED" | "MIXED" | "UNKNOWN"; riskOff: boolean;
  freshness: { stale: boolean; usableTimeframes: number; oldestUsableBarAgeSeconds: number | null }; flags: string[]; grantsApproval: false;
}

/** A series is stale when its newest bar is older than this (seconds). Off-hours and holidays also show as stale: that is reported, not hidden. */
export const MAX_BAR_AGE_SECONDS: Record<Timeframe, number> = { "5m": 15 * 60, "15m": 45 * 60, "1h": 3 * 3600 };
export const IV_MIN_HISTORY = 30;
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
const median = (v: number[]): number | null => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = (s.length - 1) / 2; return ((s[Math.floor(m)] as number) + (s[Math.ceil(m)] as number)) / 2; };

function directionOf(regime: string, slope: number | null, policy: RegimePolicy): Direction {
  if (regime === "TRENDING_UP") return "BULLISH";
  if (regime === "TRENDING_DOWN") return "BEARISH";
  if (regime === "RANGE_BOUND" || regime === "LOW_VOLATILITY") return "NEUTRAL";
  if (regime === "HIGH_VOLATILITY") return slope !== null && Math.abs(slope) >= policy.trendSlopeAtr * 0.5 ? (slope > 0 ? "BULLISH" : "BEARISH") : "NEUTRAL";
  return "UNKNOWN";
}
export function ivRegime(rank: number | null): VolRegime { return rank === null ? "UNKNOWN" : rank >= 98 ? "EXTREME" : rank >= 90 ? "HIGH" : rank <= 10 ? "LOW" : "NORMAL"; }
export function eventRiskOf(hours: number | null | undefined): EventRisk { return hours == null || !Number.isFinite(hours) ? "UNKNOWN" : hours < 0 ? "UNKNOWN" : hours <= 2 ? "HIGH" : hours <= 24 ? "ELEVATED" : hours <= 72 ? "LOW" : "NONE"; }
const VOL_ORDER: VolRegime[] = ["UNKNOWN", "LOW", "NORMAL", "HIGH", "EXTREME"];
const worseVol = (a: VolRegime, b: VolRegime): VolRegime => (VOL_ORDER.indexOf(a) >= VOL_ORDER.indexOf(b) ? a : b); // UNKNOWN is the lowest, so any known reading wins over it

export function analyzeMarketRegime(input: RegimeInput): MarketRegimeObject {
  const policy = input.policy ?? DEFAULT_REGIME_POLICY; const now = input.now.getTime(); const flags: string[] = [];
  const readings: TimeframeReading[] = TIMEFRAMES.map((tf) => {
    const series = input.timeframes.find((x) => x.timeframe === tf);
    if (!series || series.bars.length === 0) return { timeframe: tf, status: "UNKNOWN", regime: "UNKNOWN", direction: "UNKNOWN", volatilityRatio: null, efficiencyRatio: null, slopeInAtr: null, atrPct: null, barsUsed: 0, reasons: ["NO_DATA"], lastBarAgeSeconds: null } satisfies TimeframeReading;
    const last = series.bars[series.bars.length - 1] as TimedBar; const age = Math.round((now - last.at.getTime()) / 1000);
    if (age < 0) return { timeframe: tf, status: "UNKNOWN", regime: "UNKNOWN", direction: "UNKNOWN", volatilityRatio: null, efficiencyRatio: null, slopeInAtr: null, atrPct: null, barsUsed: series.bars.length, reasons: ["FUTURE_DATED_BAR"], lastBarAgeSeconds: age } satisfies TimeframeReading;
    const r = detectRegime(series.bars, policy);
    const stale = age > MAX_BAR_AGE_SECONDS[tf];
    const status = r.regime === "UNKNOWN" ? "UNKNOWN" : stale ? "STALE" : "OK";
    return { timeframe: tf, status, regime: r.regime, direction: status === "OK" ? directionOf(r.regime, r.slopeInAtr, policy) : "UNKNOWN", volatilityRatio: r.volatilityRatio, efficiencyRatio: r.efficiencyRatio, slopeInAtr: r.slopeInAtr, atrPct: r.atrPct, barsUsed: r.barsUsed, reasons: stale && r.regime !== "UNKNOWN" ? [...r.reasons, "STALE_SERIES"] : r.reasons, lastBarAgeSeconds: age } satisfies TimeframeReading;
  });
  const usable = readings.filter((r) => r.status === "OK");
  if (usable.length < readings.length) flags.push(`unusable_timeframes:${readings.filter((r) => r.status !== "OK").map((r) => r.timeframe).join(",")}`);

  // direction: needs at least two usable timeframes; non-neutral readings must agree
  let direction: Direction = "UNKNOWN";
  if (usable.length < 2) flags.push("insufficient_timeframes");
  else {
    const dirs = usable.map((r) => r.direction).filter((d) => d !== "NEUTRAL");
    if (dirs.length === 0) direction = "NEUTRAL";
    else if (dirs.every((d) => d === dirs[0])) direction = dirs.length >= 2 ? (dirs[0] as Direction) : "NEUTRAL";
    else { direction = "NEUTRAL"; flags.push("timeframes_disagree"); }
    if (dirs.length === 1) flags.push("single_directional_timeframe");
  }

  // implied volatility
  let iv: MarketRegimeObject["impliedVolatility"] = null;
  if (input.impliedVol && Number.isFinite(input.impliedVol.current)) {
    const h = input.impliedVol.history.filter((x) => Number.isFinite(x));
    const rank = h.length >= IV_MIN_HISTORY ? round((h.filter((x) => x <= input.impliedVol!.current).length / h.length) * 100, 2) : null;
    if (rank === null) flags.push("iv_history_thin");
    iv = { current: input.impliedVol.current, percentileRank: rank, regime: ivRegime(rank) };
  } else flags.push("iv_unavailable");

  const ratio = median(usable.map((r) => r.volatilityRatio).filter((x): x is number => x !== null));
  const realised: VolRegime = ratio === null ? "UNKNOWN" : ratio >= 2.5 ? "EXTREME" : ratio >= policy.highVolRatio ? "HIGH" : ratio <= policy.lowVolRatio ? "LOW" : "NORMAL";
  const volatilityRegime = worseVol(realised, iv?.regime ?? "UNKNOWN");
  const eventRisk = eventRiskOf(input.hoursToHighImpactEvent); if (eventRisk === "UNKNOWN") flags.push("event_risk_unknown");

  const bearish = usable.filter((r) => r.direction === "BEARISH").length;
  const riskOff = (volatilityRegime === "HIGH" || volatilityRegime === "EXTREME") && direction === "BEARISH" && bearish >= 2;

  let regime: OverallRegime = "UNKNOWN";
  if (usable.length >= 2) {
    const count = (name: string): number => usable.filter((r) => r.regime === name).length, half = usable.length / 2;
    regime = riskOff ? "RISK_OFF" : count("HIGH_VOLATILITY") >= half ? "HIGH_VOLATILITY" : direction === "BULLISH" && count("TRENDING_UP") >= 1 ? "TRENDING_UP" : direction === "BEARISH" && count("TRENDING_DOWN") >= 1 ? "TRENDING_DOWN" : count("RANGE_BOUND") >= half ? "RANGE_BOUND" : count("LOW_VOLATILITY") >= half ? "LOW_VOLATILITY" : "UNKNOWN";
  }

  const sib = input.siblingDirections ? Object.values(input.siblingDirections).filter((d) => d !== "UNKNOWN") : [];
  const correlatedIndexAgreement = sib.length === 0 || direction === "UNKNOWN" ? "UNKNOWN" : [...sib, direction].every((d) => d === direction) ? "ALIGNED" : "MIXED";
  const ages = usable.map((r) => r.lastBarAgeSeconds).filter((x): x is number => x !== null);
  const asOf = usable.length ? new Date(Math.max(...input.timeframes.filter((t) => usable.some((u) => u.timeframe === t.timeframe)).map((t) => (t.bars[t.bars.length - 1] as TimedBar).at.getTime()))).toISOString() : null;
  return { version: MARKET_REGIME_VERSION, underlying: input.underlying.trim().toUpperCase(), asOf, dataSource: input.dataSource, timeframes: readings, direction, regime, volatilityRegime, impliedVolatility: iv, eventRisk, correlatedIndexAgreement, riskOff, freshness: { stale: usable.length === 0, usableTimeframes: usable.length, oldestUsableBarAgeSeconds: ages.length ? Math.max(...ages) : null }, flags, grantsApproval: false };
}

/** One `market_regimes` row per usable timeframe (the table's own columns). An UNKNOWN or stale timeframe is not stored: nothing is recorded that is not known. */
export function toRegimeRows(o: MarketRegimeObject): Array<{ underlying: string; timeframe: Timeframe; direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN"; regime: string; volatilityRegime: VolRegime; impliedVolatility: string | null; eventRisk: EventRisk; evidence: unknown[]; detectorVersion: string; dataSource: DataSource; asOf: Date }> {
  if (o.asOf === null) return [];
  return o.timeframes.filter((t) => t.status === "OK").map((t) => ({
    underlying: o.underlying, timeframe: t.timeframe, direction: t.direction, regime: o.riskOff ? "RISK_OFF" : t.regime, volatilityRegime: o.volatilityRegime,
    impliedVolatility: o.impliedVolatility ? String(o.impliedVolatility.current) : null, eventRisk: o.eventRisk,
    evidence: [{ kind: "regime_measures", volatilityRatio: t.volatilityRatio, efficiencyRatio: t.efficiencyRatio, slopeInAtr: t.slopeInAtr, atrPct: t.atrPct, barsUsed: t.barsUsed }, { kind: "overall", direction: o.direction, regime: o.regime, flags: o.flags, correlatedIndexAgreement: o.correlatedIndexAgreement }],
    detectorVersion: o.version, dataSource: o.dataSource, asOf: new Date(o.asOf as string),
  }));
}
