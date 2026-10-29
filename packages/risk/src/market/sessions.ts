import { MARKET_SESSION_KEYS, type MarketRiskConfig, type SessionDef } from "./config";

/**
 * Trading sessions (pure, timezone-aware via Intl). A session is open from its open time (inclusive) to its close time (exclusive) in its own time zone on
 * its trading weekdays, unless the date is a holiday. NO holidays are hardcoded: the calendar is an interface with an EMPTY default (docs/twins/MARKET_RISK_GATES.md);
 * until an owner-maintained calendar is supplied, a market holiday that falls on a weekday looks like a normal trading day to this code.
 */
export interface HolidayCalendar {
  /** `localDate` is YYYY-MM-DD in the session's own time zone. */
  isHoliday(sessionKey: string, localDate: string): boolean;
}
export const emptyHolidayCalendar: HolidayCalendar = { isHoliday: () => false };
/** A calendar from an explicit list (tests, or an owner-maintained file loaded elsewhere). */
export const staticHolidayCalendar = (holidays: Record<string, readonly string[]>): HolidayCalendar => ({ isHoliday: (key, date) => (holidays[key] ?? []).includes(date) });

export interface LocalParts { date: string; minutes: number; isoWeekday: number; time: string }

export function localParts(at: Date, timezone: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  const hour = Number(p["hour"]) % 24;
  const iso = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p["weekday"] as string] as number;
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, minutes: hour * 60 + Number(p["minute"]), isoWeekday: iso, time: `${String(hour).padStart(2, "0")}:${p["minute"]}` };
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** UTC instant of a local wall-clock time on a local date in a zone (two-pass offset resolution; sessions never fall in a DST gap). */
export function localToInstant(localDate: string, hhmm: string, timezone: string): Date {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess), timezone);
    const [ly, lm, ld] = lp.date.split("-").map(Number) as [number, number, number];
    const shown = Date.UTC(ly, lm - 1, ld, Math.floor(lp.minutes / 60), lp.minutes % 60);
    const wanted = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
    guess += wanted - shown;
  }
  return new Date(guess);
}

export type SessionState = "OPEN" | "CLOSED" | "HOLIDAY" | "WEEKEND" | "NO_SESSION";
export interface SessionStatus {
  state: SessionState;
  sessionKey: string | null;
  market: string;
  timezone: string | null;
  localDate: string | null;
  localTime: string | null;
  opens: string | null;
  closes: string | null;
}

export function sessionKeyOf(market: string | null | undefined): string | null {
  return MARKET_SESSION_KEYS[(market ?? "").trim().toUpperCase()] ?? null;
}

export function sessionStatus(at: Date, market: string | null | undefined, config: Pick<MarketRiskConfig, "sessions">, holidays: HolidayCalendar): SessionStatus {
  const code = (market ?? "").trim().toUpperCase();
  const key = sessionKeyOf(code);
  const def: SessionDef | undefined = key ? config.sessions[key] : undefined;
  if (!key || !def) return { state: "NO_SESSION", sessionKey: key, market: code, timezone: null, localDate: null, localTime: null, opens: null, closes: null };
  const lp = localParts(at, def.timezone);
  const base = { sessionKey: key, market: code, timezone: def.timezone, localDate: lp.date, localTime: lp.time, opens: def.open, closes: def.close };
  if (!def.days.includes(lp.isoWeekday)) return { state: "WEEKEND", ...base };
  if (holidays.isHoliday(key, lp.date)) return { state: "HOLIDAY", ...base };
  return { state: lp.minutes >= toMinutes(def.open) && lp.minutes < toMinutes(def.close) ? "OPEN" : "CLOSED", ...base };
}
