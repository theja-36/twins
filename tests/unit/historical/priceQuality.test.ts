import { describe, expect, it } from "vitest";
import { INDIA_EQUITY_SESSION, assessBars, barCloseTime, barsKnownAt, expectedBarStarts, isTradingDay, type PriceBar } from "../../../packages/historical/src/outcomes/priceQuality";

/** SYNTHETIC bars and a SYNTHETIC calendar: these tests pin the rules (point-in-time, sessions, holidays, gaps, staleness), not any real market's data. */
const S = INDIA_EQUITY_SESSION(new Set(["2030-01-16"]), new Map([["2030-01-18", 12 * 60]]));
const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);
const bar = (ts: Date, p = 100): PriceBar => ({ ts, open: p, high: p + 1, low: p - 1, close: p, volume: 10 });
const day = (date: string, iv: number) => expectedBarStarts(date, iv, S).map((t) => bar(t));

describe("sessions and holidays", () => {
  it("weekends and declared holidays have no expected bars; a normal day has 75 five-minute bars; an early close shortens the day", () => {
    expect(isTradingDay("2030-01-12", S)).toBe(false); // Saturday
    expect(expectedBarStarts("2030-01-16", 300, S)).toEqual([]); // declared holiday
    expect(expectedBarStarts("2030-01-15", 300, S)).toHaveLength(75); // 09:15-15:30 IST
    expect(expectedBarStarts("2030-01-15", 300, S)[0]).toEqual(ist("2030-01-15", "09:15"));
    expect(expectedBarStarts("2030-01-18", 300, S)).toHaveLength(33); // 09:15-12:00
  });
});
describe("point-in-time availability", () => {
  const bars = [bar(ist("2030-01-15", "09:15")), bar(ist("2030-01-15", "09:20")), bar(ist("2030-01-15", "09:25"))];
  it("a bar is knowable only after it has CLOSED", () => {
    expect(barCloseTime(bars[0]!, 300)).toEqual(ist("2030-01-15", "09:20"));
    expect(barsKnownAt(bars, 300, ist("2030-01-15", "09:22"))).toHaveLength(1); // the 09:20 bar is still open
    expect(barsKnownAt(bars, 300, ist("2030-01-15", "09:20"))).toHaveLength(1); // closing at exactly as-of counts
    expect(barsKnownAt(bars, 300, ist("2030-01-15", "09:30"))).toHaveLength(3);
  });
  it("data retrieved AFTER the as-of instant is invisible to a decision at as-of, however old its bars are", () => {
    expect(barsKnownAt(bars, 300, ist("2030-01-15", "09:30"), ist("2030-01-16", "10:00"))).toEqual([]);
    expect(barsKnownAt(bars, 300, ist("2030-01-17", "10:00"), ist("2030-01-16", "10:00"))).toHaveLength(3);
  });
});
describe("assessing a series", () => {
  const dates = ["2030-01-15"];
  it("a complete session is GOOD", () => { expect(assessBars(day("2030-01-15", 300), dates, 300, S)).toMatchObject({ status: "GOOD", issues: [], expected: 75, present: 75, missing: 0 }); });
  it("a few missing bars within tolerance stay GOOD; many missing bars are DEGRADED", () => {
    const some = day("2030-01-15", 300).filter((_, i) => i % 40 !== 0); // 2 missing of 75
    expect(assessBars(some, dates, 300, S).status).toBe("GOOD");
    const half = day("2030-01-15", 300).filter((_, i) => i % 2 === 0);
    expect(assessBars(half, dates, 300, S)).toMatchObject({ status: "DEGRADED", issues: ["MISSING_BARS"] });
  });
  it("no expected bar present at all is INSUFFICIENT", () => { expect(assessBars([], dates, 300, S)).toMatchObject({ status: "INSUFFICIENT", missing: 75 }); });
  it("a bar on a holiday, a weekend or outside the session is flagged, never silently accepted", () => {
    const withHoliday = [...day("2030-01-15", 300), bar(ist("2030-01-16", "10:00"))];
    expect(assessBars(withHoliday, dates, 300, S).issues).toContain("BAR_ON_NON_TRADING_DAY");
    const after = [...day("2030-01-15", 300), bar(ist("2030-01-15", "15:30"))];
    expect(assessBars(after, dates, 300, S).issues).toContain("BAR_OUTSIDE_SESSION");
    expect(assessBars([...day("2030-01-15", 300), bar(ist("2030-01-12", "10:00"))], dates, 300, S).issues).toContain("BAR_ON_NON_TRADING_DAY");
  });
  it("duplicate or unsorted timestamps and invalid OHLC are reported; invalid OHLC makes the series INSUFFICIENT", () => {
    const d = day("2030-01-15", 300); const dup = [d[0]!, d[0]!, ...d.slice(1)];
    expect(assessBars(dup, dates, 300, S).issues).toContain("UNSORTED_OR_DUPLICATE");
    expect(assessBars([...d.slice(0, 5), { ...d[5]!, high: 90, low: 110 }, ...d.slice(6)], dates, 300, S)).toMatchObject({ status: "INSUFFICIENT" });
    expect(assessBars([{ ...d[0]!, close: Number.NaN }, ...d.slice(1)], dates, 300, S).issues).toContain("NON_FINITE_OR_INVALID_OHLC");
  });
  it("staleness is judged against the caller's clock and limit", () => {
    const d = day("2030-01-15", 300), last = barCloseTime(d[d.length - 1]!, 300);
    expect(assessBars(d, dates, 300, S, { now: new Date(last.getTime() + 60_000), maxAgeSeconds: 120 }).issues).not.toContain("STALE");
    expect(assessBars(d, dates, 300, S, { now: new Date(last.getTime() + 3_600_000), maxAgeSeconds: 120 }).issues).toContain("STALE");
  });
});
