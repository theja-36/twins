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
  if (!(m.staleCautionMinutes >= 1 && m.staleCautionMinutes < m.unavailableMinutes && m.unavailableMinutes <= 20_160) || !(m.releaseBefore >= 0 && m.releaseBefore <= 1440 && m.releaseAfter >= 0 && m.releaseAfter <= 1440)) bad("macro staleness / release windows");
  return c;
}
export function loadAgentRulesConfig(env: Record<string, string | undefined> = process.env): AgentRulesConfig {
  const d = DEFAULT_AGENT_RULES;
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
  });
}
