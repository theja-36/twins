import { describe, expect, it } from "vitest";
import { KiteError, feedWindowOpen, istParts, loadMarketHours, marketState, msUntilFeedWindow } from "../../../packages/kite/src/index";

const cfg = loadMarketHours({ TWINS_KITE_HOLIDAYS: "2026-11-10, 2026-12-25" });
const at = (iso: string) => new Date(iso);
// IST = UTC + 5:30 : 09:15 IST = 03:45Z, 15:30 IST = 10:00Z, 09:00 IST = 03:30Z

describe("market state (IST, weekdays, holidays from configuration)", () => {
  it("open, pre-open, before-open and after-close on a trading day (Tue 2026-11-03)", () => {
    expect(marketState(at("2026-11-03T03:00:00Z"), cfg)).toBe("before_open"); // 08:30 IST
    expect(marketState(at("2026-11-03T03:30:00Z"), cfg)).toBe("pre_open");    // 09:00
    expect(marketState(at("2026-11-03T03:44:59Z"), cfg)).toBe("pre_open");
    expect(marketState(at("2026-11-03T03:45:00Z"), cfg)).toBe("open");        // 09:15
    expect(marketState(at("2026-11-03T09:59:59Z"), cfg)).toBe("open");
    expect(marketState(at("2026-11-03T10:00:00Z"), cfg)).toBe("after_close"); // 15:30
  });
  it("weekends and configured holidays are closed, whatever the clock says", () => {
    expect(marketState(at("2026-11-07T05:00:00Z"), cfg)).toBe("weekend"); // Saturday
    expect(marketState(at("2026-11-08T05:00:00Z"), cfg)).toBe("weekend");
    expect(marketState(at("2026-11-10T05:00:00Z"), cfg)).toBe("holiday");
    expect(feedWindowOpen(at("2026-11-10T05:00:00Z"), cfg)).toBe(false);
  });
  it("the IST date rolls over at 18:30Z, not at midnight UTC", () => {
    expect(istParts(at("2026-11-03T18:29:00Z"))).toMatchObject({ date: "2026-11-03" });
    expect(istParts(at("2026-11-03T18:31:00Z"))).toMatchObject({ date: "2026-11-04", minute: 1 });
  });
  it("the feed window runs from 5 minutes before pre-open to 10 minutes after close (defaults) and is closed outside it", () => {
    expect(feedWindowOpen(at("2026-11-03T03:24:59Z"), cfg)).toBe(false); // 08:54:59
    expect(feedWindowOpen(at("2026-11-03T03:25:00Z"), cfg)).toBe(true);  // 08:55
    expect(feedWindowOpen(at("2026-11-03T10:09:59Z"), cfg)).toBe(true);  // 15:39:59
    expect(feedWindowOpen(at("2026-11-03T10:10:00Z"), cfg)).toBe(false); // 15:40
  });
  it("msUntilFeedWindow: 0 inside, the exact gap before, and it skips weekends and holidays", () => {
    expect(msUntilFeedWindow(at("2026-11-03T05:00:00Z"), cfg)).toBe(0);
    expect(msUntilFeedWindow(at("2026-11-03T03:00:00Z"), cfg)).toBe(25 * 60_000); // 08:30 -> 08:55 IST
    const eve = at("2026-11-03T11:00:00Z"); // 16:30 IST Tuesday -> Wednesday 08:55 IST
    expect(new Date(eve.getTime() + (msUntilFeedWindow(eve, cfg) as number)).toISOString()).toBe("2026-11-04T03:25:00.000Z");
    // Friday evening -> Monday 08:55 IST
    const fri = at("2026-11-06T11:00:00Z"); // 16:30 IST Friday
    const ms = msUntilFeedWindow(fri, cfg) as number;
    expect(new Date(fri.getTime() + ms).toISOString()).toBe("2026-11-09T03:25:00.000Z");
    // Monday 2026-11-09 evening -> Tuesday 11-10 is a holiday -> Wednesday 11-11
    const mon = at("2026-11-09T11:00:00Z");
    expect(new Date(mon.getTime() + (msUntilFeedWindow(mon, cfg) as number)).toISOString()).toBe("2026-11-11T03:25:00.000Z");
  });
  it("configuration: holidays must be real dates; padding must be a small integer; garbage throws", () => {
    for (const bad of ["2026-13-01", "10/11/2026", "2026-02-30x", "abc"]) expect(() => loadMarketHours({ TWINS_KITE_HOLIDAYS: bad }), bad).toThrow(KiteError);
    expect(() => loadMarketHours({ TWINS_KITE_CONNECT_BEFORE_MINUTES: "999" })).toThrow(KiteError);
    expect(() => loadMarketHours({ TWINS_KITE_DISCONNECT_AFTER_MINUTES: "-1" })).toThrow(KiteError);
    expect(loadMarketHours({}).holidays.size).toBe(0);
    expect(loadMarketHours({ TWINS_KITE_CONNECT_BEFORE_MINUTES: "10" }).connectBeforeMinutes).toBe(10);
  });
});
