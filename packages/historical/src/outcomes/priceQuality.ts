/**
 * Provider-independent price-data checks (G-30 / G-32 contract). Pure functions over bars in the existing `twins-historical-bars-v1` shape (a bar covers [ts, ts + interval)); they add what that format lacks:
 * point-in-time availability (a bar is knowable only when it has CLOSED and had been RETRIEVED), session / holiday / gap checks against an explicit calendar, and staleness. Nothing is repaired or invented:
 * a problem is reported with a code and the caller decides. The calendar is supplied by the caller (no calendar is assumed here).
 */
export interface PriceBar { ts: Date; open: number; high: number; low: number; close: number; volume?: number | null }
export interface SessionSpec {
  /** Offset of the exchange's local time from UTC in minutes (India: 330). */
  tzOffsetMinutes: number; startMinute: number; endMinute: number;
  /** Local dates (YYYY-MM-DD) on which the exchange was closed; weekends are always closed. */
  holidays: ReadonlySet<string>;
  /** Local dates with a shortened session: date -> end minute. */
  earlyClose?: ReadonlyMap<string, number>;
}
export const INDIA_EQUITY_SESSION = (holidays: ReadonlySet<string>, earlyClose?: ReadonlyMap<string, number>): SessionSpec => ({ tzOffsetMinutes: 330, startMinute: 9 * 60 + 15, endMinute: 15 * 60 + 30, holidays, ...(earlyClose ? { earlyClose } : {}) });

export const barCloseTime = (b: { ts: Date }, intervalSeconds: number): Date => new Date(b.ts.getTime() + intervalSeconds * 1000);
/** Bars knowable at `asOf`: closed by then, and (when the retrieval time is known) retrieved by then. Nothing retrieved after `asOf` is visible to a decision at `asOf`. */
export function barsKnownAt<T extends { ts: Date }>(bars: readonly T[], intervalSeconds: number, asOf: Date, retrievedAt?: Date): T[] {
  if (retrievedAt && asOf.getTime() < retrievedAt.getTime()) return [];
  return bars.filter((b) => barCloseTime(b, intervalSeconds).getTime() <= asOf.getTime());
}

const localParts = (d: Date, tz: number): { date: string; minute: number; dow: number } => { const l = new Date(d.getTime() + tz * 60_000); return { date: l.toISOString().slice(0, 10), minute: l.getUTCHours() * 60 + l.getUTCMinutes(), dow: l.getUTCDay() }; };
export const isTradingDay = (date: string, s: SessionSpec): boolean => { const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6 && !s.holidays.has(date); };
/** The bar start times the session should contain for one local date ([] on a non-trading day). */
export function expectedBarStarts(date: string, intervalSeconds: number, s: SessionSpec): Date[] {
  if (!isTradingDay(date, s)) return [];
  const end = s.earlyClose?.get(date) ?? s.endMinute, step = intervalSeconds / 60, out: Date[] = [];
  const midnightUtc = Date.parse(`${date}T00:00:00Z`) - s.tzOffsetMinutes * 60_000;
  for (let m = s.startMinute; m + step <= end; m += step) out.push(new Date(midnightUtc + m * 60_000));
  return out;
}
export type PriceIssue = "UNSORTED_OR_DUPLICATE" | "NON_FINITE_OR_INVALID_OHLC" | "BAR_ON_NON_TRADING_DAY" | "BAR_OUTSIDE_SESSION" | "MISSING_BARS" | "STALE";
export interface PriceAssessment { status: "GOOD" | "DEGRADED" | "INSUFFICIENT"; issues: PriceIssue[]; expected: number; present: number; missing: number; maxMissingFraction: number }
/** Assesses intraday bars for the given local dates. INSUFFICIENT when the data is unusable (invalid or no expected bars present), DEGRADED when bars are missing beyond the tolerance or other issues exist. */
export function assessBars(bars: readonly PriceBar[], dates: readonly string[], intervalSeconds: number, s: SessionSpec, o: { maxMissingFraction?: number; now?: Date; maxAgeSeconds?: number } = {}): PriceAssessment {
  const tol = o.maxMissingFraction ?? 0.05, issues = new Set<PriceIssue>();
  let prev = -Infinity;
  for (const b of bars) {
    const t = b.ts.getTime(); if (!(t > prev)) issues.add("UNSORTED_OR_DUPLICATE"); prev = t;
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite) || b.high < b.low || b.open > b.high || b.open < b.low || b.close > b.high || b.close < b.low || b.low < 0) issues.add("NON_FINITE_OR_INVALID_OHLC");
    const p = localParts(b.ts, s.tzOffsetMinutes);
    if (!isTradingDay(p.date, s)) issues.add("BAR_ON_NON_TRADING_DAY");
    else if (p.minute < s.startMinute || p.minute + intervalSeconds / 60 > (s.earlyClose?.get(p.date) ?? s.endMinute)) issues.add("BAR_OUTSIDE_SESSION");
  }
  const have = new Set(bars.map((b) => b.ts.getTime())); let expected = 0, present = 0;
  for (const d of dates) for (const e of expectedBarStarts(d, intervalSeconds, s)) { expected++; if (have.has(e.getTime())) present++; }
  const missing = expected - present, frac = expected === 0 ? 0 : missing / expected;
  if (frac > tol) issues.add("MISSING_BARS");
  if (o.now && o.maxAgeSeconds !== undefined && bars.length > 0) { const last = Math.max(...bars.map((b) => barCloseTime(b, intervalSeconds).getTime())); if (o.now.getTime() - last > o.maxAgeSeconds * 1000) issues.add("STALE"); }
  const unusable = issues.has("NON_FINITE_OR_INVALID_OHLC") || (expected > 0 && present === 0);
  return { status: unusable ? "INSUFFICIENT" : issues.size > 0 ? "DEGRADED" : "GOOD", issues: [...issues].sort(), expected, present, missing, maxMissingFraction: tol };
}
