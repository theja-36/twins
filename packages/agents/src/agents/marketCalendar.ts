import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, isRealDate, nonEmpty } from "./common";
import { validateCalendarEvent, type CalendarEvent, type DayInfo, type EconomicCalendarProvider, type HolidayCalendarProvider } from "./calendarProviders";
import type { AgentRulesConfig, SessionConfig } from "./rules";

/**
 * Market Calendar Agent (`market-calendar-v1`, Stage 5 / Task 3). Identifies session, holiday, expiry and scheduled-event risk using INJECTED calendar providers (no external API). It works
 * on parsed fields and the engine clock only (never message text), never guesses, and never approves anything.
 *
 *   BLOCKING: unknown / missing market; weekend, holiday, or outside trading hours at the engine clock; a contract that has already expired; a CRITICAL event inside the blackout window
 *   ADVERSE : a HIGH-impact event inside its window (before / after); a CRITICAL event ahead inside the look-ahead but outside the blackout
 *   CAUTION : a MEDIUM event in the look-ahead; a HIGH event later in the look-ahead; early close; close within N minutes; expiry day; the signal was sent outside trading hours; partial coverage / old snapshot
 *   INFO    : LOW events; expiry approaching (configurable)
 *   UNAVAILABLE (never a pass): a provider is not configured, fails, does not cover the date / window, or returns malformed data
 *   verdict = the worst level; a clean calendar = SUPPORTIVE. Events are judged against the ENGINE CLOCK (the agent runs when the decision is made, i.e. at the signal); the signal's own time
 *   is checked against the session separately.
 */
export const MARKET_CALENDAR_AGENT_ID = "market-calendar-v1";
const DAY = 86_400_000;
const MIN = 60_000;

export function marketCalendarContract(): AgentContract {
  return {
    agentId: MARKET_CALENDAR_AGENT_ID, agentName: "Market Calendar Agent", version: "1.0.0",
    requiredInputs: ["risk_decision", "signal_context"], optionalInputs: [],
    outputSchema: { fields: { ...COMMON_OUTPUT_FIELDS, sessionState: { type: "string" }, minutesToClose: { type: "number" }, daysToExpiry: { type: "number" }, eventsConsidered: { type: "number" }, holidayCalendar: { type: "string" }, economicCalendar: { type: "string" } } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; expiry?: string | null };
type Sc = { signalTimestamp?: string | null };

const hm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
interface Local { date: string; minutes: number; dow: number }
const localOf = (t: number, offsetMin: number): Local => { const d = new Date(t + offsetMin * MIN); return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; };
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const validDay = (d: DayInfo | null, date: string): DayInfo | null => {
  if (d === null) return null;
  if (!d || typeof d !== "object" || d.date !== date || typeof d.holiday !== "boolean" || (d.earlyCloseLocal !== null && !(typeof d.earlyCloseLocal === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.earlyCloseLocal)))) return unavailable("CALENDAR_DATA_MALFORMED", "the holiday calendar returned malformed data");
  return d;
};
const safe = (s: string, n = 60): string => s.replace(/[^A-Za-z0-9 .,&()/'-]/g, "_").slice(0, n);

type SessionState = "OPEN" | "BEFORE_OPEN" | "AFTER_CLOSE" | "WEEKEND" | "HOLIDAY";
interface Session { state: SessionState; date: string; day: DayInfo | null; closeMinutes: number; minutesToClose: number | null }
/** The session state of a market at an instant. `day` is null for a weekend (the provider is not consulted) and when the provider does not cover the date. */
async function sessionAt(t: number, cfg: SessionConfig, market: string, holidays: HolidayCalendarProvider, guard: <T>(fn: () => Promise<T>) => Promise<T>): Promise<Session | { uncovered: true; date: string }> {
  const l = localOf(t, cfg.utcOffsetMinutes);
  if (l.dow === 0 || l.dow === 6) return { state: "WEEKEND", date: l.date, day: null, closeMinutes: hm(cfg.close), minutesToClose: null };
  const day = validDay(await guard(() => holidays.day(market, l.date)), l.date);
  if (day === null) return { uncovered: true, date: l.date };
  const closeMinutes = day.earlyCloseLocal ? Math.min(hm(day.earlyCloseLocal), hm(cfg.close)) : hm(cfg.close);
  if (day.holiday) return { state: "HOLIDAY", date: l.date, day, closeMinutes, minutesToClose: null };
  const open = hm(cfg.open);
  const state: SessionState = l.minutes < open ? "BEFORE_OPEN" : l.minutes >= closeMinutes ? "AFTER_CLOSE" : "OPEN";
  return { state, date: l.date, day, closeMinutes, minutesToClose: state === "OPEN" ? closeMinutes - l.minutes : null };
}

export function marketCalendarAgent(rules: AgentRulesConfig, holidays: HolidayCalendarProvider | null, economic: EconomicCalendarProvider | null): AgentDefinition {
  const r = rules.calendar;
  return {
    contract: marketCalendarContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const sc = ctx.inputs["signal_context"] as Sc | null;
      if (!rd || !sc) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision or signal context is missing");
      if (!holidays) throw new AgentUnavailableError("HOLIDAY_CALENDAR_NOT_CONFIGURED", "no holiday calendar is configured; the session cannot be verified");
      if (!economic) throw new AgentUnavailableError("ECONOMIC_CALENDAR_NOT_CONFIGURED", "no economic calendar is configured; scheduled events cannot be checked");
      const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
        try { return await fn(); } catch (e) { if (e instanceof AgentUnavailableError) throw e; return unavailable("CALENDAR_PROVIDER_UNAVAILABLE", "a calendar provider is unavailable"); } // the provider's own message is never stored
      };
      const c = new Collector();
      const now = ctx.now.getTime();
      const market = (rd.market ?? "").trim().toUpperCase();

      c.check();
      if (!market) { c.add("BLOCKING", "MARKET_MISSING", "The market is not stated."); return c.output(evidenceRef("risk_decision", rd.id), { sessionState: "UNKNOWN", eventsConsidered: 0 }); }
      const cfg = r.sessions[market];
      if (!cfg) { c.add("BLOCKING", "MARKET_UNKNOWN", "The market has no configured trading session, so it is not supported."); return c.output(evidenceRef("risk_decision", rd.id), { sessionState: "UNKNOWN", eventsConsidered: 0 }); }

      // ── snapshot freshness ──
      c.check();
      for (const [label, asOf] of [["holiday", holidays.asOf], ["economic", economic.asOf]] as const) {
        if (asOf === null) c.add("CAUTION", `${label.toUpperCase()}_CALENDAR_AS_OF_UNKNOWN`, `The ${label} calendar carries no snapshot date.`);
        else if (now - Date.parse(asOf) > r.calendarMaxAgeDays * DAY) c.add("CAUTION", `${label.toUpperCase()}_CALENDAR_STALE`, `The ${label} calendar snapshot is older than ${r.calendarMaxAgeDays} days.`);
      }

      // ── the session now ──
      c.check();
      const sess = await sessionAt(now, cfg, market, holidays, guard);
      if ("uncovered" in sess) return unavailable("HOLIDAY_CALENDAR_DATE_NOT_COVERED", "the holiday calendar does not cover today's date for this market");
      const state = sess.state;
      if (state === "WEEKEND") c.add("BLOCKING", "MARKET_WEEKEND", "The market is closed at weekends.");
      else if (state === "HOLIDAY") c.add("BLOCKING", "MARKET_HOLIDAY", "The market is closed for a holiday.", { holiday: safe(sess.day?.holidayName ?? "unnamed") });
      else if (state === "BEFORE_OPEN") c.add("BLOCKING", "MARKET_NOT_OPEN", "The market has not opened yet.");
      else if (state === "AFTER_CLOSE") c.add("BLOCKING", "MARKET_CLOSED", "The market has closed for the day.");
      else {
        if (sess.day?.earlyCloseLocal) c.add("CAUTION", "EARLY_CLOSE_SESSION", "The market closes early today.", { closesAt: sess.day.earlyCloseLocal });
        if (sess.minutesToClose !== null && sess.minutesToClose <= r.nearCloseMinutes) c.add("CAUTION", "NEAR_MARKET_CLOSE", `The market closes within ${r.nearCloseMinutes} minutes.`, { minutesToClose: sess.minutesToClose });
      }

      // ── the signal's own time ──
      c.check();
      if (!nonEmpty(sc.signalTimestamp) || Number.isNaN(Date.parse(sc.signalTimestamp))) c.add("CAUTION", "SIGNAL_TIME_UNKNOWN", "The signal time is not known, so its session cannot be checked.");
      else {
        const s = await sessionAt(Date.parse(sc.signalTimestamp), cfg, market, holidays, guard);
        if ("uncovered" in s) c.add("CAUTION", "SIGNAL_DAY_NOT_COVERED", "The holiday calendar does not cover the day the signal was sent.");
        else if (s.state !== "OPEN") c.add(r.signalOutsideSession, "SIGNAL_OUTSIDE_SESSION", "The signal was sent outside trading hours.", { sessionState: s.state });
      }

      // ── expiry ──
      let daysToExpiry: number | undefined;
      const type = (rd.instrumentType ?? "").toLowerCase();
      if ((type === "future" || type === "option") && isRealDate(rd.expiry)) {
        c.check();
        const [y, m, d] = rd.expiry.split("-").map(Number) as [number, number, number];
        const days = Math.round(Date.UTC(y, m - 1, d) / DAY) - Math.floor((now + cfg.utcOffsetMinutes * MIN) / DAY);
        daysToExpiry = days;
        if (days < 0) c.add("BLOCKING", "EXPIRY_PASSED", "The contract has already expired.", { daysToExpiry: days });
        else {
          if (days === 0) c.add(r.expiryDay, "EXPIRY_DAY", "The contract expires today.");
          else if (days <= r.expiryApproachingDays) c.add(r.expiryApproaching, "EXPIRY_APPROACHING", `The contract expires in ${days} day(s).`, { daysToExpiry: days });
          const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
          const eday = dow === 0 || dow === 6 ? null : validDay(await guard(() => holidays.day(market, rd.expiry as string)), rd.expiry);
          if (dow === 0 || dow === 6 || eday?.holiday) c.add("CAUTION", "EXPIRY_ON_NON_TRADING_DAY", "The stated expiry falls on a weekend or holiday.");
        }
      }

      // ── scheduled events ──
      c.check();
      const cov = economic.coverage;
      const covFrom = Date.parse(cov.from), covTo = Date.parse(cov.to);
      if (Number.isNaN(covFrom) || Number.isNaN(covTo) || now < covFrom || now > covTo) return unavailable("ECONOMIC_CALENDAR_NOT_COVERING_NOW", "the economic calendar does not cover the current time");
      const windowEnd = now + r.lookAheadMinutes * MIN;
      if (covTo < windowEnd) c.add("CAUTION", "CALENDAR_COVERAGE_PARTIAL", "The economic calendar does not cover the whole look-ahead window.");
      const lookBack = Math.max(r.criticalAfter, r.highAfter);
      const raw = await guard(() => economic.events({ from: new Date(now - lookBack * MIN).toISOString(), to: new Date(windowEnd).toISOString() }));
      if (!Array.isArray(raw)) return unavailable("CALENDAR_DATA_MALFORMED", "the economic calendar returned malformed data");
      const events: CalendarEvent[] = raw.map((x) => validateCalendarEvent(x) ?? unavailable("CALENDAR_DATA_MALFORMED", "the economic calendar returned malformed data"));
      let considered = 0;
      for (const e of events) {
        if (!e.markets.includes(market) && !e.markets.includes("ALL")) continue;
        const dt = (Date.parse(e.at) - now) / MIN; // minutes ahead (negative = already happened)
        const detail = { eventId: e.id, impact: e.impact, minutesAhead: Math.round(dt) };
        const name = safe(e.name);
        if (e.impact === "CRITICAL") {
          if (dt >= -r.criticalAfter && dt <= r.criticalBefore) { considered++; c.add(r.criticalSeverity, "CRITICAL_EVENT_BLACKOUT", `A critical scheduled event (${name}) is inside the blackout window.`, detail); }
          else if (dt > 0 && dt <= r.lookAheadMinutes) { considered++; c.add("ADVERSE", "CRITICAL_EVENT_UPCOMING", `A critical scheduled event (${name}) is ahead within the look-ahead window.`, detail); }
        } else if (e.impact === "HIGH") {
          if (dt >= -r.highAfter && dt <= r.highBefore) { considered++; c.add("ADVERSE", "HIGH_IMPACT_EVENT_NEAR", `A high-impact scheduled event (${name}) is near.`, detail); }
          else if (dt > 0 && dt <= r.lookAheadMinutes) { considered++; c.add("CAUTION", "HIGH_IMPACT_EVENT_UPCOMING", `A high-impact scheduled event (${name}) is ahead within the look-ahead window.`, detail); }
        } else if (dt >= -r.highAfter && dt <= r.lookAheadMinutes) {
          considered++;
          if (e.impact === "MEDIUM") c.add("CAUTION", "MEDIUM_IMPACT_EVENT", `A medium-impact scheduled event (${name}) is within the look-ahead window.`, detail);
          else c.add("INFO", "LOW_IMPACT_EVENT", `A low-impact scheduled event (${name}) is within the look-ahead window.`, detail);
        }
      }

      const ref = (p: { name: string; asOf: string | null }): string => `${p.name}${p.asOf ? `@${p.asOf}` : ""}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150);
      const evidence = [...evidenceRef("risk_decision", rd.id), ...evidenceRef("holiday_calendar", ref(holidays)), ...evidenceRef("economic_calendar", ref(economic))];
      return c.output(evidence, {
        sessionState: state, eventsConsidered: considered, holidayCalendar: holidays.name.slice(0, 80), economicCalendar: economic.name.slice(0, 80),
        ...(sess.minutesToClose === null ? {} : { minutesToClose: sess.minutesToClose }), ...(daysToExpiry === undefined ? {} : { daysToExpiry }),
      });
    },
  };
}
