import { AgentContractError } from "../contract";

/**
 * Rule configuration of the first two research agents (Stage 5 / Task 2). Conservative defaults; a malformed override THROWS at start-up (no silent fallback).
 *
 *   TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES / _ADVERSE_MINUTES / _BLOCK_MINUTES   10 / 30 / 120 (strictly increasing)
 *   TWINS_AGENT_SIGNAL_FUTURE_TOLERANCE_MINUTES                                      5 (a signal time further in the future is impossible -> BLOCKING)
 *   TWINS_AGENT_TARGET_ORDERING                strict | non_strict (default strict: targets must improve strictly)
 *   TWINS_AGENT_TARGET_ORDER_VIOLATION         ADVERSE | BLOCKING (default ADVERSE)
 *   TWINS_AGENT_REVISION_AMBIGUOUS             ADVERSE | BLOCKING (default BLOCKING: an ambiguous revision group is non-actionable)
 *   TWINS_AGENT_INSTRUMENT_REFERENCE           none | file:<path to a twins-instrument-reference-v1 .json> (default none)
 *   TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS        1-730 (default 90)
 *   TWINS_AGENT_EXPIRY_BEYOND_HORIZON          ADVERSE | BLOCKING (default ADVERSE)
 *   TWINS_AGENT_MISSING_LOT_SIZE               ADVERSE | BLOCKING (default BLOCKING: a derivative without a lot size / multiplier cannot be sized)
 *   TWINS_AGENT_REFERENCE_MAX_AGE_DAYS         1-365 (default 30; an older reference snapshot is a CAUTION)
 * Stage 5 / Task 3 (calendar + macro):
 *   TWINS_AGENT_HOLIDAY_CALENDAR / TWINS_AGENT_ECONOMIC_CALENDAR / TWINS_AGENT_MACRO_PROVIDER   none | file:<path> (default none -> the agent is UNAVAILABLE, never a pass)
 *   TWINS_AGENT_CALENDAR_SESSIONS              JSON {"NSE":{"utcOffsetMinutes":330,"open":"09:15","close":"15:30"}} (default: NSE, BSE, NFO, BFO 09:15-15:30 IST, Mon-Fri)
 *   TWINS_AGENT_CALENDAR_LOOKAHEAD_MINUTES     1-10080 (default 240: events further ahead are not reported)
 *   TWINS_AGENT_CRITICAL_BLACKOUT_BEFORE_MINUTES / _AFTER_MINUTES   0-1440 (default 60 / 30: a CRITICAL event in this window -> BLOCKING)
 *   TWINS_AGENT_HIGH_EVENT_BEFORE_MINUTES / _AFTER_MINUTES          0-1440 (default 120 / 30: a HIGH event in this window -> ADVERSE; later in the look-ahead -> CAUTION)
 *   TWINS_AGENT_CRITICAL_EVENT_BLACKOUT       BLOCKING | ADVERSE (default BLOCKING)
 *   TWINS_AGENT_SIGNAL_OUTSIDE_SESSION        CAUTION | ADVERSE | BLOCKING (default CAUTION: the signal was sent outside trading hours)
 *   TWINS_AGENT_EXPIRY_DAY_SEVERITY / _APPROACHING_SEVERITY         INFO | CAUTION | ADVERSE (default CAUTION / INFO); TWINS_AGENT_EXPIRY_APPROACHING_DAYS 1-30 (default 2)
 *   TWINS_AGENT_NEAR_CLOSE_MINUTES            0-120 (default 15: closing within this many minutes -> CAUTION)
 *   TWINS_AGENT_CALENDAR_MAX_AGE_DAYS         1-365 (default 30: an older calendar snapshot -> CAUTION)
 *   TWINS_AGENT_MACRO_TREND_LOOKBACK_SESSIONS 1-60 (default 5); _TREND_SUPPORTIVE_PCT 0.5, _TREND_CAUTION_PCT 0.75, _TREND_ADVERSE_PCT 2 (against the signal direction)
 *   TWINS_AGENT_MACRO_VOL_CAUTION / _ADVERSE / _BLOCK                 volatility index level 20 / 25 / 40; TWINS_AGENT_MACRO_VOL_SPIKE_PCT 15 (one-day rise -> ADVERSE)
 *   TWINS_AGENT_MACRO_INDEX_MOVE_CAUTION / _ADVERSE / _BLOCK          absolute one-day index move % 1.5 / 3 / 7
 *   TWINS_AGENT_MACRO_GAP_CAUTION / _ADVERSE                          absolute opening gap % 1 / 2
 *   TWINS_AGENT_MACRO_BREADTH_RISK_OFF / _RISK_ON                     advancing share 0.3 / 0.7
 *   TWINS_AGENT_MACRO_GLOBAL_CAUTION / _ADVERSE                       global index one-day move against the direction % 1 / 2
 *   TWINS_AGENT_MACRO_CURRENCY_CAUTION                                absolute one-day currency move % 1
 *   TWINS_AGENT_MACRO_STALE_CAUTION_MINUTES / _UNAVAILABLE_MINUTES    60 / 1440 (older than the second -> the context is UNAVAILABLE)
 *   TWINS_AGENT_MACRO_RELEASE_BEFORE_MINUTES / _AFTER_MINUTES         macro-release window 60 / 15 (CRITICAL -> TWINS_AGENT_MACRO_CRITICAL_RELEASE BLOCKING|ADVERSE, HIGH -> ADVERSE, MEDIUM -> CAUTION)
 * Stage 5 / Task 4 (news + index constituents; see the agent docs for the full list):
 *   TWINS_AGENT_NEWS_PROVIDER / TWINS_AGENT_SENTIMENT_PROVIDER / TWINS_AGENT_CONSTITUENT_PROVIDER / TWINS_AGENT_MARKET_DATA_PROVIDER   none | file:<path> (default none -> UNAVAILABLE, never a pass)
 *   TWINS_AGENT_NEWS_*  (LOOKBACK_MINUTES 1440, NEAR_TERM_MINUTES 120, SENTIMENT_THRESHOLD 0.3, MIN_RELIABILITY 0.5, STALE_CAUTION_MINUTES 120, STALE_UNAVAILABLE_MINUTES 1440, CRITICAL_ADVERSE BLOCKING, ...)
 *   TWINS_AGENT_SENTIMENT_AGGREGATE_CAUTION / _ADVERSE / TWINS_AGENT_SENTIMENT_MIN_SAMPLE   0.2 / 0.5 / 5
 *   TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS (default BANKNIFTY,FINNIFTY,MIDCPNIFTY,NIFTY,SENSEX: other underlyings -> the constituent agent is not applicable), TWINS_AGENT_CONSTITUENT_QUOTE_MARKET (NSE)
 *   TWINS_AGENT_CONSTITUENT_*  (TOP_COUNT 10, MIN_WEIGHT 1, MIN_COVERED_WEIGHT 60, MIN_USABLE_SHARE 0.7, MOVE_*, IMPACT_*, CRITICAL_WEIGHT 5, CRITICAL_EVENT BLOCKING, STALE_*, NEWS_*, ...)
 * Stage 5 / Task 5 (technical structure + price action):
 *   TWINS_AGENT_OHLC_PROVIDER / TWINS_AGENT_LAST_PRICE_PROVIDER   none | file:<path> (default none -> UNAVAILABLE, never a pass); TWINS_AGENT_OHLC_MARKET (NSE), TWINS_AGENT_OHLC_STALE_CAUTION_MINUTES 120,
 *     _STALE_UNAVAILABLE_MINUTES 1440, _MAX_BAR_AGE_DAYS 5, _FUTURE_TOLERANCE_MINUTES 5, _PRICE_DISCONNECT_PCT 5
 *   TWINS_AGENT_TECH_*  (MIN_BARS 60, SHORT_LOOKBACK 10, LONG_LOOKBACK 30, TREND_CAUTION_PCT 1, TREND_ADVERSE_PCT 4, SWING_STRENGTH 2, BREAKOUT_LOOKBACK 20, SR_PROXIMITY_PCT 0.75, FAST_MA 10, SLOW_MA 30, RSI_PERIOD 14,
 *     RSI_STRETCHED 75, MOMENTUM_AGAINST 15, RANGE_EFFICIENCY 0.25, BREAKDOWN_AGAINST ADVERSE, INVALIDATION BLOCKING)
 *   TWINS_AGENT_PA_*  (MIN_BARS 30, ATR_PERIOD 14, PATTERN_WINDOW 3, MIN_BODY_ATR 0.5, WICK_RATIO 0.6, STRONG_RANGE_ATR 1.5, GAP_*_PCT 0.5 / 1.5, CONSECUTIVE_* 3 / 5, EXPANSION_* 2 / 3.5, CONTRACTION_RATIO 0.5,
 *     EXTREME_LOOKBACK 20, EXTREME_PROXIMITY_PCT 0.75, EXHAUSTION_RUN 3, CRITICAL_REVERSAL ADVERSE)
 * Enable / disable and weights use the engine settings (TWINS_AGENT_ENGINE_DISABLED_AGENTS, TWINS_AGENT_ENGINE_WEIGHTS).
 */
export const AGENT_RULES_VERSION = "agent-rules-v1";
export type Severity2 = "ADVERSE" | "BLOCKING";
export interface AgentRulesConfig {
  version: string;
  signal: { staleCautionMinutes: number; staleAdverseMinutes: number; staleBlockMinutes: number; futureToleranceMinutes: number; targetOrdering: "strict" | "non_strict"; targetOrderViolation: Severity2; ambiguousRevision: Severity2 };
  instrument: { maxExpiryHorizonDays: number; beyondHorizon: Severity2; missingLotSize: Severity2; referenceMaxAgeDays: number; referenceSource: string };
  calendar: {
    holidaySource: string; economicSource: string; sessions: Record<string, SessionConfig>; lookAheadMinutes: number;
    criticalBefore: number; criticalAfter: number; criticalSeverity: Severity2; highBefore: number; highAfter: number;
    signalOutsideSession: Severity3; expiryDay: Severity4; expiryApproaching: Severity4; expiryApproachingDays: number; nearCloseMinutes: number; calendarMaxAgeDays: number;
  };
  macro: {
    source: string; trendLookbackSessions: number; trendSupportivePct: number; trendCautionPct: number; trendAdversePct: number;
    volCaution: number; volAdverse: number; volBlock: number; volSpikePct: number; moveCaution: number; moveAdverse: number; moveBlock: number; gapCaution: number; gapAdverse: number;
    breadthRiskOff: number; breadthRiskOn: number; globalCaution: number; globalAdverse: number; currencyCaution: number; staleCautionMinutes: number; unavailableMinutes: number;
    releaseBefore: number; releaseAfter: number; criticalRelease: Severity2;
  };
  news: {
    source: string; sentimentSource: string; lookbackMinutes: number; nearTermMinutes: number; sentimentThreshold: number; aggregateCaution: number; aggregateAdverse: number; aggregateMinSample: number;
    minReliability: number; staleCautionMinutes: number; unavailableMinutes: number; futureToleranceMinutes: number; maxItems: number; criticalAdverse: Severity2;
  };
  constituent: {
    constituentSource: string; marketDataSource: string; topCount: number; minWeight: number; minCoveredWeight: number; minUsableShare: number; moveCaution: number; moveAdverse: number; extremeMove: number;
    impactCaution: number; impactAdverse: number; singleContributionAdverse: number; sectorConcentration: number; staleCautionMinutes: number; unavailableMinutes: number; criticalWeight: number; criticalEvent: Severity2;
    newsLookbackMinutes: number; nearTermMinutes: number; sentimentThreshold: number; minReliability: number;
    /** Underlyings treated as INDEX signals (others: the agent is not applicable) and the cash-market code used for quotes and news. */
    indexUnderlyings: string[]; quoteMarket: string;
  };
  ohlc: { source: string; priceSource: string; market: string; staleCautionMinutes: number; unavailableMinutes: number; maxBarAgeDays: number; futureToleranceMinutes: number; priceDisconnectPct: number };
  technical: {
    minBars: number; shortLookback: number; longLookback: number; trendCautionPct: number; trendAdversePct: number; swingStrength: number; breakoutLookback: number; srProximityPct: number;
    fastMa: number; slowMa: number; rsiPeriod: number; rsiStretched: number; momentumAgainst: number; rangeEfficiency: number; breakdownAgainst: Severity2; invalidation: Severity2;
  };
  priceAction: {
    minBars: number; atrPeriod: number; patternWindow: number; minBodyAtr: number; wickRatio: number; strongRangeAtr: number; gapCautionPct: number; gapAdversePct: number; consecutiveCaution: number;
    consecutiveAdverse: number; expansionRatio: number; expansionAdverseRatio: number; contractionRatio: number; extremeLookback: number; extremeProximityPct: number; exhaustionRun: number; criticalReversal: Severity2;
  };
}
export type Severity3 = "CAUTION" | "ADVERSE" | "BLOCKING";
export type Severity4 = "INFO" | "CAUTION" | "ADVERSE";
export interface SessionConfig { utcOffsetMinutes: number; open: string; close: string }
const IST: SessionConfig = { utcOffsetMinutes: 330, open: "09:15", close: "15:30" };
export const DEFAULT_AGENT_RULES: AgentRulesConfig = {
  version: AGENT_RULES_VERSION,
  signal: { staleCautionMinutes: 10, staleAdverseMinutes: 30, staleBlockMinutes: 120, futureToleranceMinutes: 5, targetOrdering: "strict", targetOrderViolation: "ADVERSE", ambiguousRevision: "BLOCKING" },
  instrument: { maxExpiryHorizonDays: 90, beyondHorizon: "ADVERSE", missingLotSize: "BLOCKING", referenceMaxAgeDays: 30, referenceSource: "none" },
  calendar: {
    holidaySource: "none", economicSource: "none", sessions: { NSE: IST, BSE: IST, NFO: IST, BFO: IST }, lookAheadMinutes: 240, criticalBefore: 60, criticalAfter: 30, criticalSeverity: "BLOCKING", highBefore: 120, highAfter: 30,
    signalOutsideSession: "CAUTION", expiryDay: "CAUTION", expiryApproaching: "INFO", expiryApproachingDays: 2, nearCloseMinutes: 15, calendarMaxAgeDays: 30,
  },
  macro: {
    source: "none", trendLookbackSessions: 5, trendSupportivePct: 0.5, trendCautionPct: 0.75, trendAdversePct: 2, volCaution: 20, volAdverse: 25, volBlock: 40, volSpikePct: 15, moveCaution: 1.5, moveAdverse: 3, moveBlock: 7,
    gapCaution: 1, gapAdverse: 2, breadthRiskOff: 0.3, breadthRiskOn: 0.7, globalCaution: 1, globalAdverse: 2, currencyCaution: 1, staleCautionMinutes: 60, unavailableMinutes: 1440, releaseBefore: 60, releaseAfter: 15, criticalRelease: "BLOCKING",
  },
  news: {
    source: "none", sentimentSource: "none", lookbackMinutes: 1440, nearTermMinutes: 120, sentimentThreshold: 0.3, aggregateCaution: 0.2, aggregateAdverse: 0.5, aggregateMinSample: 5, minReliability: 0.5,
    staleCautionMinutes: 120, unavailableMinutes: 1440, futureToleranceMinutes: 5, maxItems: 500, criticalAdverse: "BLOCKING",
  },
  constituent: {
    constituentSource: "none", marketDataSource: "none", topCount: 10, minWeight: 1, minCoveredWeight: 60, minUsableShare: 0.7, moveCaution: 1, moveAdverse: 2, extremeMove: 10, impactCaution: 0.3, impactAdverse: 0.75,
    singleContributionAdverse: 0.4, sectorConcentration: 0.5, staleCautionMinutes: 60, unavailableMinutes: 1440, criticalWeight: 5, criticalEvent: "BLOCKING", newsLookbackMinutes: 1440, nearTermMinutes: 120,
    sentimentThreshold: 0.3, minReliability: 0.5, indexUnderlyings: ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTY", "SENSEX"], quoteMarket: "NSE",
  },
  ohlc: { source: "none", priceSource: "none", market: "NSE", staleCautionMinutes: 120, unavailableMinutes: 1440, maxBarAgeDays: 5, futureToleranceMinutes: 5, priceDisconnectPct: 5 },
  technical: {
    minBars: 60, shortLookback: 10, longLookback: 30, trendCautionPct: 1, trendAdversePct: 4, swingStrength: 2, breakoutLookback: 20, srProximityPct: 0.75, fastMa: 10, slowMa: 30, rsiPeriod: 14, rsiStretched: 75,
    momentumAgainst: 15, rangeEfficiency: 0.25, breakdownAgainst: "ADVERSE", invalidation: "BLOCKING",
  },
  priceAction: {
    minBars: 30, atrPeriod: 14, patternWindow: 3, minBodyAtr: 0.5, wickRatio: 0.6, strongRangeAtr: 1.5, gapCautionPct: 0.5, gapAdversePct: 1.5, consecutiveCaution: 3, consecutiveAdverse: 5, expansionRatio: 2, expansionAdverseRatio: 3.5,
    contractionRatio: 0.5, extremeLookback: 20, extremeProximityPct: 0.75, exhaustionRun: 3, criticalReversal: "ADVERSE",
  },
};
const bad = (what: string): never => { throw new AgentContractError("INVALID_ENGINE_CONFIG", `invalid agent rules configuration: ${what}`); };
const int = (env: Record<string, string | undefined>, name: string, def: number, lo: number, hi: number): number => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d{1,5}$/.test(v) || Number(v) < lo || Number(v) > hi) bad(name);
  return Number(v);
};
const dec = (env: Record<string, string | undefined>, name: string, def: number, lo: number, hi: number): number => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d{1,5}(?:\.\d{1,4})?$/.test(v) || Number(v) < lo || Number(v) > hi) bad(name);
  return Number(v);
};
const src = (env: Record<string, string | undefined>, name: string): string => { const v = env[name]; return v === undefined || v === "" ? "none" : v; };
const sessionsOf = (env: Record<string, string | undefined>): Record<string, SessionConfig> => {
  const v = env["TWINS_AGENT_CALENDAR_SESSIONS"];
  if (v === undefined || v.trim() === "") return DEFAULT_AGENT_RULES.calendar.sessions;
  let o: unknown;
  try { o = JSON.parse(v); } catch { return bad("TWINS_AGENT_CALENDAR_SESSIONS is not JSON"); }
  if (typeof o !== "object" || o === null || Array.isArray(o)) bad("TWINS_AGENT_CALENDAR_SESSIONS");
  return o as Record<string, SessionConfig>;
};
const pick = <T extends string>(env: Record<string, string | undefined>, name: string, allowed: readonly T[], def: T): T => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!(allowed as readonly string[]).includes(v)) bad(name);
  return v as T;
};

export function validateAgentRules(c: AgentRulesConfig): AgentRulesConfig {
  const s = c.signal, i = c.instrument;
  if (!(s.staleCautionMinutes >= 1 && s.staleCautionMinutes < s.staleAdverseMinutes && s.staleAdverseMinutes < s.staleBlockMinutes && s.staleBlockMinutes <= 10_080)) bad("staleness thresholds must be strictly increasing");
  if (!(s.futureToleranceMinutes >= 0 && s.futureToleranceMinutes <= 60)) bad("future tolerance");
  if (!(i.maxExpiryHorizonDays >= 1 && i.maxExpiryHorizonDays <= 730) || !(i.referenceMaxAgeDays >= 1 && i.referenceMaxAgeDays <= 365)) bad("instrument horizon / age");
  if (!(i.referenceSource === "none" || /^file:.{1,400}$/.test(i.referenceSource))) bad("instrument reference source");
  const k = c.calendar, m = c.macro;
  const hhmm = (x: unknown): number => { if (typeof x !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) return bad("session time"); return Number(x.slice(0, 2)) * 60 + Number(x.slice(3)); };
  if (Object.keys(k.sessions).length === 0) bad("no market sessions");
  for (const [code, ss] of Object.entries(k.sessions)) {
    if (!/^[A-Z0-9]{2,20}$/.test(code) || !Number.isInteger(ss.utcOffsetMinutes) || ss.utcOffsetMinutes < -720 || ss.utcOffsetMinutes > 840 || hhmm(ss.open) >= hhmm(ss.close)) bad(`session ${code}`);
  }
  for (const src of [k.holidaySource, k.economicSource, m.source]) if (!(src === "none" || /^file:.{1,400}$/.test(src))) bad("provider source");
  if (!(k.lookAheadMinutes >= 1 && k.lookAheadMinutes <= 10_080) || ![k.criticalBefore, k.criticalAfter, k.highBefore, k.highAfter].every((x) => Number.isInteger(x) && x >= 0 && x <= 1440)) bad("event windows");
  if (!(k.expiryApproachingDays >= 1 && k.expiryApproachingDays <= 30) || !(k.nearCloseMinutes >= 0 && k.nearCloseMinutes <= 120) || !(k.calendarMaxAgeDays >= 1 && k.calendarMaxAgeDays <= 365)) bad("calendar limits");
  const asc = (...x: number[]): boolean => x.every((v, i) => Number.isFinite(v) && v >= 0 && (i === 0 || v > (x[i - 1] as number)));
  if (!(Number.isInteger(m.trendLookbackSessions) && m.trendLookbackSessions >= 1 && m.trendLookbackSessions <= 60)) bad("trend lookback");
  if (!asc(m.trendCautionPct, m.trendAdversePct) || !(m.trendSupportivePct >= 0 && m.trendSupportivePct <= 20) || !asc(m.volCaution, m.volAdverse, m.volBlock) || !asc(m.moveCaution, m.moveAdverse, m.moveBlock) || !asc(m.gapCaution, m.gapAdverse) || !asc(m.globalCaution, m.globalAdverse)) bad("macro thresholds must be non-negative and strictly increasing");
  if (!(m.volSpikePct > 0 && m.currencyCaution > 0) || !(m.breadthRiskOff > 0 && m.breadthRiskOff < m.breadthRiskOn && m.breadthRiskOn < 1)) bad("macro thresholds");
  const n = c.news, ct = c.constituent;
  for (const src of [n.source, n.sentimentSource, ct.constituentSource, ct.marketDataSource]) if (!(src === "none" || /^file:.{1,400}$/.test(src))) bad("provider source");
  if (!(n.lookbackMinutes >= 1 && n.lookbackMinutes <= 20_160 && n.nearTermMinutes >= 1 && n.nearTermMinutes <= n.lookbackMinutes) || !(n.sentimentThreshold > 0 && n.sentimentThreshold <= 1) || !asc(n.aggregateCaution, n.aggregateAdverse) || n.aggregateAdverse > 1) bad("news windows / thresholds");
  if (!(n.aggregateMinSample >= 1 && n.aggregateMinSample <= 10_000) || !(n.minReliability >= 0 && n.minReliability <= 1) || !(n.staleCautionMinutes >= 1 && n.staleCautionMinutes < n.unavailableMinutes && n.unavailableMinutes <= 20_160) || !(n.futureToleranceMinutes >= 0 && n.futureToleranceMinutes <= 60) || !(n.maxItems >= 1 && n.maxItems <= 5000)) bad("news limits");
  if (!(ct.topCount >= 1 && ct.topCount <= 100) || !(ct.minWeight >= 0 && ct.minWeight <= 100) || !(ct.minCoveredWeight > 0 && ct.minCoveredWeight <= 100) || !(ct.minUsableShare > 0 && ct.minUsableShare <= 1) || !asc(ct.moveCaution, ct.moveAdverse, ct.extremeMove) || !asc(ct.impactCaution, ct.impactAdverse)) bad("constituent thresholds");
  if (!(ct.singleContributionAdverse > 0) || !(ct.sectorConcentration > 0 && ct.sectorConcentration <= 1) || !(ct.staleCautionMinutes >= 1 && ct.staleCautionMinutes < ct.unavailableMinutes && ct.unavailableMinutes <= 20_160) || !(ct.criticalWeight >= 0 && ct.criticalWeight <= 100)) bad("constituent limits");
  const o = c.ohlc, t = c.technical, pa = c.priceAction;
  for (const src2 of [o.source, o.priceSource]) if (!(src2 === "none" || /^file:.{1,400}$/.test(src2))) bad("provider source");
  if (!/^[A-Z0-9]{2,20}$/.test(o.market) || !(o.staleCautionMinutes >= 1 && o.staleCautionMinutes < o.unavailableMinutes && o.unavailableMinutes <= 20_160) || !(o.maxBarAgeDays >= 1 && o.maxBarAgeDays <= 400) || !(o.futureToleranceMinutes >= 0 && o.futureToleranceMinutes <= 60) || !(o.priceDisconnectPct > 0 && o.priceDisconnectPct <= 50)) bad("ohlc limits");
  const ints = (...x: number[]): boolean => x.every((v) => Number.isInteger(v) && v >= 1);
  if (!ints(t.minBars, t.shortLookback, t.longLookback, t.swingStrength, t.breakoutLookback, t.fastMa, t.slowMa, t.rsiPeriod) || t.minBars > 1000 || !(t.shortLookback < t.longLookback) || !(t.fastMa < t.slowMa) || t.minBars < Math.max(t.longLookback + 1, t.slowMa + 1, t.breakoutLookback + 1, t.rsiPeriod + 2, 4 * t.swingStrength + 2)) bad("technical lookbacks (minBars must cover every lookback)");
  if (!asc(t.trendCautionPct, t.trendAdversePct) || !(t.srProximityPct > 0 && t.srProximityPct <= 20) || !(t.rsiStretched > 50 && t.rsiStretched <= 100) || !(t.momentumAgainst > 0 && t.momentumAgainst <= 50) || !(t.rangeEfficiency > 0 && t.rangeEfficiency < 1)) bad("technical thresholds");
  if (!ints(pa.minBars, pa.atrPeriod, pa.patternWindow, pa.consecutiveCaution, pa.consecutiveAdverse, pa.extremeLookback, pa.exhaustionRun) || pa.minBars > 1000 || pa.minBars < Math.max(pa.atrPeriod + 2, pa.extremeLookback + 1, pa.consecutiveAdverse + 1) || pa.consecutiveCaution >= pa.consecutiveAdverse) bad("price-action windows");
  if (!(pa.minBodyAtr > 0 && pa.minBodyAtr <= 5) || !(pa.wickRatio > 0.3 && pa.wickRatio < 1) || !(pa.strongRangeAtr > 0 && pa.strongRangeAtr <= 10) || !asc(pa.gapCautionPct, pa.gapAdversePct) || !(pa.expansionRatio > 1 && pa.expansionRatio < pa.expansionAdverseRatio) || !(pa.contractionRatio > 0 && pa.contractionRatio < 1) || !(pa.extremeProximityPct > 0 && pa.extremeProximityPct <= 20)) bad("price-action thresholds");
  if (ct.indexUnderlyings.some((x) => !/^[A-Z0-9&._-]{1,30}$/.test(x)) || !/^[A-Z0-9]{2,20}$/.test(ct.quoteMarket)) bad("constituent index underlyings / quote market");
  if (!(ct.newsLookbackMinutes >= 1 && ct.newsLookbackMinutes <= 20_160 && ct.nearTermMinutes >= 1 && ct.nearTermMinutes <= ct.newsLookbackMinutes) || !(ct.sentimentThreshold > 0 && ct.sentimentThreshold <= 1) || !(ct.minReliability >= 0 && ct.minReliability <= 1)) bad("constituent news limits");
  if (!(m.staleCautionMinutes >= 1 && m.staleCautionMinutes < m.unavailableMinutes && m.unavailableMinutes <= 20_160) || !(m.releaseBefore >= 0 && m.releaseBefore <= 1440 && m.releaseAfter >= 0 && m.releaseAfter <= 1440)) bad("macro staleness / release windows");
  return c;
}
export function loadAgentRulesConfig(env: Record<string, string | undefined> = process.env): AgentRulesConfig {
  const d = DEFAULT_AGENT_RULES;
  const P = "TWINS_AGENT_";
  return validateAgentRules({
    version: AGENT_RULES_VERSION,
    signal: {
      staleCautionMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES", d.signal.staleCautionMinutes, 1, 10_080), staleAdverseMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_ADVERSE_MINUTES", d.signal.staleAdverseMinutes, 1, 10_080),
      staleBlockMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_BLOCK_MINUTES", d.signal.staleBlockMinutes, 1, 10_080), futureToleranceMinutes: int(env, "TWINS_AGENT_SIGNAL_FUTURE_TOLERANCE_MINUTES", d.signal.futureToleranceMinutes, 0, 60),
      targetOrdering: pick(env, "TWINS_AGENT_TARGET_ORDERING", ["strict", "non_strict"], d.signal.targetOrdering), targetOrderViolation: pick(env, "TWINS_AGENT_TARGET_ORDER_VIOLATION", ["ADVERSE", "BLOCKING"], d.signal.targetOrderViolation),
      ambiguousRevision: pick(env, "TWINS_AGENT_REVISION_AMBIGUOUS", ["ADVERSE", "BLOCKING"], d.signal.ambiguousRevision),
    },
    instrument: {
      maxExpiryHorizonDays: int(env, "TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS", d.instrument.maxExpiryHorizonDays, 1, 730), beyondHorizon: pick(env, "TWINS_AGENT_EXPIRY_BEYOND_HORIZON", ["ADVERSE", "BLOCKING"], d.instrument.beyondHorizon),
      missingLotSize: pick(env, "TWINS_AGENT_MISSING_LOT_SIZE", ["ADVERSE", "BLOCKING"], d.instrument.missingLotSize), referenceMaxAgeDays: int(env, "TWINS_AGENT_REFERENCE_MAX_AGE_DAYS", d.instrument.referenceMaxAgeDays, 1, 365),
      referenceSource: env["TWINS_AGENT_INSTRUMENT_REFERENCE"] === undefined || env["TWINS_AGENT_INSTRUMENT_REFERENCE"] === "" ? d.instrument.referenceSource : (env["TWINS_AGENT_INSTRUMENT_REFERENCE"] as string),
    },
    calendar: {
      holidaySource: src(env, "TWINS_AGENT_HOLIDAY_CALENDAR"), economicSource: src(env, "TWINS_AGENT_ECONOMIC_CALENDAR"), sessions: sessionsOf(env),
      lookAheadMinutes: int(env, "TWINS_AGENT_CALENDAR_LOOKAHEAD_MINUTES", d.calendar.lookAheadMinutes, 1, 10_080),
      criticalBefore: int(env, "TWINS_AGENT_CRITICAL_BLACKOUT_BEFORE_MINUTES", d.calendar.criticalBefore, 0, 1440), criticalAfter: int(env, "TWINS_AGENT_CRITICAL_BLACKOUT_AFTER_MINUTES", d.calendar.criticalAfter, 0, 1440),
      criticalSeverity: pick(env, "TWINS_AGENT_CRITICAL_EVENT_BLACKOUT", ["ADVERSE", "BLOCKING"], d.calendar.criticalSeverity),
      highBefore: int(env, "TWINS_AGENT_HIGH_EVENT_BEFORE_MINUTES", d.calendar.highBefore, 0, 1440), highAfter: int(env, "TWINS_AGENT_HIGH_EVENT_AFTER_MINUTES", d.calendar.highAfter, 0, 1440),
      signalOutsideSession: pick(env, "TWINS_AGENT_SIGNAL_OUTSIDE_SESSION", ["CAUTION", "ADVERSE", "BLOCKING"], d.calendar.signalOutsideSession),
      expiryDay: pick(env, "TWINS_AGENT_EXPIRY_DAY_SEVERITY", ["INFO", "CAUTION", "ADVERSE"], d.calendar.expiryDay), expiryApproaching: pick(env, "TWINS_AGENT_EXPIRY_APPROACHING_SEVERITY", ["INFO", "CAUTION", "ADVERSE"], d.calendar.expiryApproaching),
      expiryApproachingDays: int(env, "TWINS_AGENT_EXPIRY_APPROACHING_DAYS", d.calendar.expiryApproachingDays, 1, 30), nearCloseMinutes: int(env, "TWINS_AGENT_NEAR_CLOSE_MINUTES", d.calendar.nearCloseMinutes, 0, 120),
      calendarMaxAgeDays: int(env, "TWINS_AGENT_CALENDAR_MAX_AGE_DAYS", d.calendar.calendarMaxAgeDays, 1, 365),
    },
    macro: {
      source: src(env, "TWINS_AGENT_MACRO_PROVIDER"), trendLookbackSessions: int(env, "TWINS_AGENT_MACRO_TREND_LOOKBACK_SESSIONS", d.macro.trendLookbackSessions, 1, 60),
      trendSupportivePct: dec(env, "TWINS_AGENT_MACRO_TREND_SUPPORTIVE_PCT", d.macro.trendSupportivePct, 0, 20), trendCautionPct: dec(env, "TWINS_AGENT_MACRO_TREND_CAUTION_PCT", d.macro.trendCautionPct, 0, 50), trendAdversePct: dec(env, "TWINS_AGENT_MACRO_TREND_ADVERSE_PCT", d.macro.trendAdversePct, 0, 50),
      volCaution: dec(env, "TWINS_AGENT_MACRO_VOL_CAUTION", d.macro.volCaution, 0, 200), volAdverse: dec(env, "TWINS_AGENT_MACRO_VOL_ADVERSE", d.macro.volAdverse, 0, 200), volBlock: dec(env, "TWINS_AGENT_MACRO_VOL_BLOCK", d.macro.volBlock, 0, 200), volSpikePct: dec(env, "TWINS_AGENT_MACRO_VOL_SPIKE_PCT", d.macro.volSpikePct, 0.1, 500),
      moveCaution: dec(env, "TWINS_AGENT_MACRO_INDEX_MOVE_CAUTION", d.macro.moveCaution, 0, 50), moveAdverse: dec(env, "TWINS_AGENT_MACRO_INDEX_MOVE_ADVERSE", d.macro.moveAdverse, 0, 50), moveBlock: dec(env, "TWINS_AGENT_MACRO_INDEX_MOVE_BLOCK", d.macro.moveBlock, 0, 50),
      gapCaution: dec(env, "TWINS_AGENT_MACRO_GAP_CAUTION", d.macro.gapCaution, 0, 50), gapAdverse: dec(env, "TWINS_AGENT_MACRO_GAP_ADVERSE", d.macro.gapAdverse, 0, 50),
      breadthRiskOff: dec(env, "TWINS_AGENT_MACRO_BREADTH_RISK_OFF", d.macro.breadthRiskOff, 0, 1), breadthRiskOn: dec(env, "TWINS_AGENT_MACRO_BREADTH_RISK_ON", d.macro.breadthRiskOn, 0, 1),
      globalCaution: dec(env, "TWINS_AGENT_MACRO_GLOBAL_CAUTION", d.macro.globalCaution, 0, 50), globalAdverse: dec(env, "TWINS_AGENT_MACRO_GLOBAL_ADVERSE", d.macro.globalAdverse, 0, 50), currencyCaution: dec(env, "TWINS_AGENT_MACRO_CURRENCY_CAUTION", d.macro.currencyCaution, 0.01, 50),
      staleCautionMinutes: int(env, "TWINS_AGENT_MACRO_STALE_CAUTION_MINUTES", d.macro.staleCautionMinutes, 1, 20_160), unavailableMinutes: int(env, "TWINS_AGENT_MACRO_STALE_UNAVAILABLE_MINUTES", d.macro.unavailableMinutes, 1, 20_160),
      releaseBefore: int(env, "TWINS_AGENT_MACRO_RELEASE_BEFORE_MINUTES", d.macro.releaseBefore, 0, 1440), releaseAfter: int(env, "TWINS_AGENT_MACRO_RELEASE_AFTER_MINUTES", d.macro.releaseAfter, 0, 1440),
      criticalRelease: pick(env, "TWINS_AGENT_MACRO_CRITICAL_RELEASE", ["ADVERSE", "BLOCKING"], d.macro.criticalRelease),
    },
    news: {
      source: src(env, "TWINS_AGENT_NEWS_PROVIDER"), sentimentSource: src(env, "TWINS_AGENT_SENTIMENT_PROVIDER"), lookbackMinutes: int(env, "TWINS_AGENT_NEWS_LOOKBACK_MINUTES", d.news.lookbackMinutes, 1, 20_160),
      nearTermMinutes: int(env, "TWINS_AGENT_NEWS_NEAR_TERM_MINUTES", d.news.nearTermMinutes, 1, 20_160), sentimentThreshold: dec(env, "TWINS_AGENT_NEWS_SENTIMENT_THRESHOLD", d.news.sentimentThreshold, 0.01, 1),
      aggregateCaution: dec(env, "TWINS_AGENT_SENTIMENT_AGGREGATE_CAUTION", d.news.aggregateCaution, 0, 1), aggregateAdverse: dec(env, "TWINS_AGENT_SENTIMENT_AGGREGATE_ADVERSE", d.news.aggregateAdverse, 0, 1),
      aggregateMinSample: int(env, "TWINS_AGENT_SENTIMENT_MIN_SAMPLE", d.news.aggregateMinSample, 1, 10_000), minReliability: dec(env, "TWINS_AGENT_NEWS_MIN_RELIABILITY", d.news.minReliability, 0, 1),
      staleCautionMinutes: int(env, "TWINS_AGENT_NEWS_STALE_CAUTION_MINUTES", d.news.staleCautionMinutes, 1, 20_160), unavailableMinutes: int(env, "TWINS_AGENT_NEWS_STALE_UNAVAILABLE_MINUTES", d.news.unavailableMinutes, 1, 20_160),
      futureToleranceMinutes: int(env, "TWINS_AGENT_NEWS_FUTURE_TOLERANCE_MINUTES", d.news.futureToleranceMinutes, 0, 60), maxItems: int(env, "TWINS_AGENT_NEWS_MAX_ITEMS", d.news.maxItems, 1, 5000),
      criticalAdverse: pick(env, "TWINS_AGENT_NEWS_CRITICAL_ADVERSE", ["ADVERSE", "BLOCKING"], d.news.criticalAdverse),
    },
    constituent: {
      constituentSource: src(env, "TWINS_AGENT_CONSTITUENT_PROVIDER"), marketDataSource: src(env, "TWINS_AGENT_MARKET_DATA_PROVIDER"), topCount: int(env, "TWINS_AGENT_CONSTITUENT_TOP_COUNT", d.constituent.topCount, 1, 100),
      minWeight: dec(env, "TWINS_AGENT_CONSTITUENT_MIN_WEIGHT", d.constituent.minWeight, 0, 100), minCoveredWeight: dec(env, "TWINS_AGENT_CONSTITUENT_MIN_COVERED_WEIGHT", d.constituent.minCoveredWeight, 0.1, 100),
      minUsableShare: dec(env, "TWINS_AGENT_CONSTITUENT_MIN_USABLE_SHARE", d.constituent.minUsableShare, 0.01, 1), moveCaution: dec(env, "TWINS_AGENT_CONSTITUENT_MOVE_CAUTION", d.constituent.moveCaution, 0, 100),
      moveAdverse: dec(env, "TWINS_AGENT_CONSTITUENT_MOVE_ADVERSE", d.constituent.moveAdverse, 0, 100), extremeMove: dec(env, "TWINS_AGENT_CONSTITUENT_EXTREME_MOVE", d.constituent.extremeMove, 0, 100),
      impactCaution: dec(env, "TWINS_AGENT_CONSTITUENT_IMPACT_CAUTION", d.constituent.impactCaution, 0, 100), impactAdverse: dec(env, "TWINS_AGENT_CONSTITUENT_IMPACT_ADVERSE", d.constituent.impactAdverse, 0, 100),
      singleContributionAdverse: dec(env, "TWINS_AGENT_CONSTITUENT_SINGLE_CONTRIBUTION_ADVERSE", d.constituent.singleContributionAdverse, 0.01, 100), sectorConcentration: dec(env, "TWINS_AGENT_CONSTITUENT_SECTOR_CONCENTRATION", d.constituent.sectorConcentration, 0.01, 1),
      staleCautionMinutes: int(env, "TWINS_AGENT_CONSTITUENT_STALE_CAUTION_MINUTES", d.constituent.staleCautionMinutes, 1, 20_160), unavailableMinutes: int(env, "TWINS_AGENT_CONSTITUENT_STALE_UNAVAILABLE_MINUTES", d.constituent.unavailableMinutes, 1, 20_160),
      criticalWeight: dec(env, "TWINS_AGENT_CONSTITUENT_CRITICAL_WEIGHT", d.constituent.criticalWeight, 0, 100), criticalEvent: pick(env, "TWINS_AGENT_CONSTITUENT_CRITICAL_EVENT", ["ADVERSE", "BLOCKING"], d.constituent.criticalEvent),
      newsLookbackMinutes: int(env, "TWINS_AGENT_CONSTITUENT_NEWS_LOOKBACK_MINUTES", d.constituent.newsLookbackMinutes, 1, 20_160), nearTermMinutes: int(env, "TWINS_AGENT_CONSTITUENT_NEWS_NEAR_TERM_MINUTES", d.constituent.nearTermMinutes, 1, 20_160),
      sentimentThreshold: dec(env, "TWINS_AGENT_CONSTITUENT_SENTIMENT_THRESHOLD", d.constituent.sentimentThreshold, 0.01, 1), minReliability: dec(env, "TWINS_AGENT_CONSTITUENT_MIN_RELIABILITY", d.constituent.minReliability, 0, 1),
      indexUnderlyings: ((): string[] => { const v = env["TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS"]; if (v === undefined || v.trim() === "") return d.constituent.indexUnderlyings; const l = v.split(",").map((x) => x.trim()); if (l.some((x) => !/^[A-Z0-9&._-]{1,30}$/.test(x)) || new Set(l).size !== l.length) bad("TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS"); return l.sort(); })(),
      quoteMarket: ((): string => { const v = env["TWINS_AGENT_CONSTITUENT_QUOTE_MARKET"]; if (v === undefined || v === "") return d.constituent.quoteMarket; if (!/^[A-Z0-9]{2,20}$/.test(v)) bad("TWINS_AGENT_CONSTITUENT_QUOTE_MARKET"); return v; })(),
    },
    ohlc: {
      source: src(env, P + "OHLC_PROVIDER"), priceSource: src(env, P + "LAST_PRICE_PROVIDER"), market: ((): string => { const v = env[P + "OHLC_MARKET"]; if (v === undefined || v === "") return d.ohlc.market; if (!/^[A-Z0-9]{2,20}$/.test(v)) bad(P + "OHLC_MARKET"); return v; })(),
      staleCautionMinutes: int(env, P + "OHLC_STALE_CAUTION_MINUTES", d.ohlc.staleCautionMinutes, 1, 20_160), unavailableMinutes: int(env, P + "OHLC_STALE_UNAVAILABLE_MINUTES", d.ohlc.unavailableMinutes, 1, 20_160),
      maxBarAgeDays: int(env, P + "OHLC_MAX_BAR_AGE_DAYS", d.ohlc.maxBarAgeDays, 1, 400), futureToleranceMinutes: int(env, P + "OHLC_FUTURE_TOLERANCE_MINUTES", d.ohlc.futureToleranceMinutes, 0, 60),
      priceDisconnectPct: dec(env, P + "OHLC_PRICE_DISCONNECT_PCT", d.ohlc.priceDisconnectPct, 0.01, 50),
    },
    technical: {
      minBars: int(env, P + "TECH_MIN_BARS", d.technical.minBars, 1, 1000), shortLookback: int(env, P + "TECH_SHORT_LOOKBACK", d.technical.shortLookback, 1, 1000), longLookback: int(env, P + "TECH_LONG_LOOKBACK", d.technical.longLookback, 1, 1000),
      trendCautionPct: dec(env, P + "TECH_TREND_CAUTION_PCT", d.technical.trendCautionPct, 0, 100), trendAdversePct: dec(env, P + "TECH_TREND_ADVERSE_PCT", d.technical.trendAdversePct, 0, 100),
      swingStrength: int(env, P + "TECH_SWING_STRENGTH", d.technical.swingStrength, 1, 20), breakoutLookback: int(env, P + "TECH_BREAKOUT_LOOKBACK", d.technical.breakoutLookback, 1, 1000), srProximityPct: dec(env, P + "TECH_SR_PROXIMITY_PCT", d.technical.srProximityPct, 0.01, 20),
      fastMa: int(env, P + "TECH_FAST_MA", d.technical.fastMa, 1, 500), slowMa: int(env, P + "TECH_SLOW_MA", d.technical.slowMa, 1, 500), rsiPeriod: int(env, P + "TECH_RSI_PERIOD", d.technical.rsiPeriod, 1, 200),
      rsiStretched: dec(env, P + "TECH_RSI_STRETCHED", d.technical.rsiStretched, 50.01, 100), momentumAgainst: dec(env, P + "TECH_MOMENTUM_AGAINST", d.technical.momentumAgainst, 0.01, 50), rangeEfficiency: dec(env, P + "TECH_RANGE_EFFICIENCY", d.technical.rangeEfficiency, 0.01, 0.99),
      breakdownAgainst: pick(env, P + "TECH_BREAKDOWN_AGAINST", ["ADVERSE", "BLOCKING"], d.technical.breakdownAgainst), invalidation: pick(env, P + "TECH_INVALIDATION", ["ADVERSE", "BLOCKING"], d.technical.invalidation),
    },
    priceAction: {
      minBars: int(env, P + "PA_MIN_BARS", d.priceAction.minBars, 1, 1000), atrPeriod: int(env, P + "PA_ATR_PERIOD", d.priceAction.atrPeriod, 1, 500), patternWindow: int(env, P + "PA_PATTERN_WINDOW", d.priceAction.patternWindow, 1, 20),
      minBodyAtr: dec(env, P + "PA_MIN_BODY_ATR", d.priceAction.minBodyAtr, 0.01, 5), wickRatio: dec(env, P + "PA_WICK_RATIO", d.priceAction.wickRatio, 0.31, 0.99), strongRangeAtr: dec(env, P + "PA_STRONG_RANGE_ATR", d.priceAction.strongRangeAtr, 0.01, 10),
      gapCautionPct: dec(env, P + "PA_GAP_CAUTION_PCT", d.priceAction.gapCautionPct, 0, 50), gapAdversePct: dec(env, P + "PA_GAP_ADVERSE_PCT", d.priceAction.gapAdversePct, 0, 50),
      consecutiveCaution: int(env, P + "PA_CONSECUTIVE_CAUTION", d.priceAction.consecutiveCaution, 1, 100), consecutiveAdverse: int(env, P + "PA_CONSECUTIVE_ADVERSE", d.priceAction.consecutiveAdverse, 1, 100),
      expansionRatio: dec(env, P + "PA_EXPANSION_RATIO", d.priceAction.expansionRatio, 1.01, 50), expansionAdverseRatio: dec(env, P + "PA_EXPANSION_ADVERSE_RATIO", d.priceAction.expansionAdverseRatio, 1.02, 50),
      contractionRatio: dec(env, P + "PA_CONTRACTION_RATIO", d.priceAction.contractionRatio, 0.01, 0.99), extremeLookback: int(env, P + "PA_EXTREME_LOOKBACK", d.priceAction.extremeLookback, 1, 1000),
      extremeProximityPct: dec(env, P + "PA_EXTREME_PROXIMITY_PCT", d.priceAction.extremeProximityPct, 0.01, 20), exhaustionRun: int(env, P + "PA_EXHAUSTION_RUN", d.priceAction.exhaustionRun, 1, 50),
      criticalReversal: pick(env, P + "PA_CRITICAL_REVERSAL", ["ADVERSE", "BLOCKING"], d.priceAction.criticalReversal),
    },
  });
}
