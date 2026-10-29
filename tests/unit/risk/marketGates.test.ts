import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAlert } from "../../../packages/alerting/src/index";
import {
  assessExpiry, DEFAULT_MARKET_CONFIG, emptyHolidayCalendar, evaluateMarketGates, evaluateMarketRisk, loadMarketRiskConfig, localToInstant, marketAlerts, marketDataFailureAlert, MARKET_REASONS, parseSession, sessionStatus,
  staticHolidayCalendar, type EventWindow, type MarketGateInput, type MarketSnapshot,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, resetRuntimeState } from "../../../packages/runtime-state/src/index";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;
afterEach(() => configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }));

const cfg = DEFAULT_MARKET_CONFIG;
const NOW = new Date("2024-06-12T04:30:00Z"); // Wednesday 10:00 IST
const snap = (over: Partial<MarketSnapshot> = {}, now = NOW): MarketSnapshot => ({ last: 100, bid: 99.95, ask: 100.05, bidQty: 5_000, askQty: 5_000, volume: 1_000_000, openInterest: 50_000, timestamp: new Date(now.getTime() - 5_000), ...over });
const input = (over: Partial<MarketGateInput> = {}): MarketGateInput => ({ now: NOW, market: "NSE", instrumentType: "equity", symbol: "RELIANCE", expiry: null, entryPrice: 100, snapshot: snap(), windows: [], circuitBreaker: { blocked: false, blockedBy: [] }, ...over });
const run = (over: Partial<MarketGateInput> = {}, config = cfg, holidays = emptyHolidayCalendar) => evaluateMarketGates(input(over), config, holidays);
const win = (over: Partial<EventWindow> = {}): EventWindow => ({ id: "w1", market: "NSE", scope: "MARKET", scopeValue: null, startsAt: new Date(NOW.getTime() - 3_600_000), endsAt: new Date(NOW.getTime() + 3_600_000), severity: "CRITICAL", reasonCode: "rbi_policy", ...over });

describe("defaults", () => {
  it("India 09:15-15:30 IST, US 09:30-16:00 New York, Japan 09:00-15:00 Tokyo, Monday-Friday; empty holiday calendar", () => {
    expect(cfg.sessions).toEqual({
      IN: { timezone: "Asia/Kolkata", open: "09:15", close: "15:30", days: [1, 2, 3, 4, 5] },
      US: { timezone: "America/New_York", open: "09:30", close: "16:00", days: [1, 2, 3, 4, 5] },
      JP: { timezone: "Asia/Tokyo", open: "09:00", close: "15:00", days: [1, 2, 3, 4, 5] },
    });
    expect(emptyHolidayCalendar.isHoliday("IN", "2024-01-26")).toBe(false);
    expect(cfg.minMinutesToExpiry).toEqual({ option: 30, future: 30 });
    expect(cfg.maxDataAgeSeconds).toBe(60);
  });
});

describe("market sessions (timezone-aware, table-driven)", () => {
  // [description, instant (UTC), market, expected state]
  const rows: Array<[string, string, string, string]> = [
    ["India: just before the open", "2024-06-12T03:44:00Z", "NSE", "CLOSED"], // 09:14 IST
    ["India: at the open (inclusive)", "2024-06-12T03:45:00Z", "NSE", "OPEN"], // 09:15 IST
    ["India: mid-session", "2024-06-12T08:00:00Z", "BSE", "OPEN"],
    ["India: last minute", "2024-06-12T09:59:00Z", "NFO", "OPEN"], // 15:29 IST
    ["India: at the close (exclusive)", "2024-06-12T10:00:00Z", "NSE", "CLOSED"], // 15:30 IST
    ["India: Saturday", "2024-06-15T05:00:00Z", "NSE", "WEEKEND"],
    ["India: Sunday", "2024-06-16T05:00:00Z", "NSE", "WEEKEND"],
    ["US: before the open (EDT)", "2024-06-12T13:29:00Z", "NYSE", "CLOSED"], // 09:29 EDT
    ["US: at the open (EDT)", "2024-06-12T13:30:00Z", "NASDAQ", "OPEN"], // 09:30 EDT
    ["US: at the close (EDT)", "2024-06-12T20:00:00Z", "NYSE", "CLOSED"], // 16:00 EDT
    ["US: the same wall-clock open in winter (EST)", "2024-01-10T14:30:00Z", "NYSE", "OPEN"], // 09:30 EST: the zone's DST is honoured
    ["US: 14:30Z in summer is only 10:30 EDT but 13:29Z in winter is 08:29 EST", "2024-01-10T13:29:00Z", "NYSE", "CLOSED"],
    ["US: Saturday", "2024-06-15T15:00:00Z", "NYSE", "WEEKEND"],
    ["Japan: before the open", "2024-06-12T23:59:00Z", "TSE", "CLOSED"], // 08:59 JST (Thursday)
    ["Japan: at the open", "2024-06-13T00:00:00Z", "JPX", "OPEN"], // 09:00 JST
    ["Japan: at the close", "2024-06-13T06:00:00Z", "TSE", "CLOSED"], // 15:00 JST
    ["Japan: Saturday JST although it is Friday evening UTC", "2024-06-14T16:00:00Z", "TSE", "WEEKEND"], // 01:00 JST Saturday
    ["unknown market: no session, never open", "2024-06-12T05:00:00Z", "LSE", "NO_SESSION"],
    ["missing market", "2024-06-12T05:00:00Z", "", "NO_SESSION"],
  ];
  it.each(rows)("%s", (_d, iso, market, state) => {
    expect(sessionStatus(new Date(iso), market, cfg, emptyHolidayCalendar).state).toBe(state);
  });
  it("holiday interface: a date supplied by the calendar is a HOLIDAY in the session's own zone; the default calendar has none", () => {
    const holidays = staticHolidayCalendar({ IN: ["2024-06-12"], US: ["2024-07-04"] });
    expect(sessionStatus(NOW, "NSE", cfg, holidays)).toMatchObject({ state: "HOLIDAY", localDate: "2024-06-12" });
    expect(sessionStatus(NOW, "NSE", cfg, emptyHolidayCalendar).state).toBe("OPEN");
    expect(sessionStatus(new Date("2024-07-04T15:00:00Z"), "NYSE", cfg, holidays).state).toBe("HOLIDAY");
    expect(sessionStatus(new Date("2024-07-04T15:00:00Z"), "NSE", cfg, holidays).state).toBe("CLOSED"); // 20:30 IST: closed, but NOT a holiday - another market's holiday does not apply
    // the local date, not the UTC date, is asked: 19:00 UTC on 2024-06-11 is already 2024-06-12 in India
    expect(sessionStatus(new Date("2024-06-11T19:00:00Z"), "NSE", cfg, holidays)).toMatchObject({ state: "HOLIDAY", localDate: "2024-06-12" });
  });
  it("sessions are configurable; a malformed override throws", () => {
    const c = loadMarketRiskConfig({ TWINS_MARKET_SESSION_IN: "10:00-14:00@Asia/Kolkata" });
    expect(sessionStatus(new Date("2024-06-12T03:45:00Z"), "NSE", c, emptyHolidayCalendar).state).toBe("CLOSED");
    for (const bad of ["15:30-09:15@Asia/Kolkata", "09:15-15:30", "09:15-15:30@Not/AZone", "9:15-15:30@Asia/Kolkata"]) expect(() => parseSession("X", bad), bad).toThrow();
  });
  it("local-to-instant conversion honours the zone", () => {
    expect(localToInstant("2024-06-12", "15:30", "Asia/Kolkata").toISOString()).toBe("2024-06-12T10:00:00.000Z");
    expect(localToInstant("2024-06-12", "16:00", "America/New_York").toISOString()).toBe("2024-06-12T20:00:00.000Z");
    expect(localToInstant("2024-01-10", "16:00", "America/New_York").toISOString()).toBe("2024-01-10T21:00:00.000Z");
  });
});

describe("contract expiry rules (table-driven)", () => {
  // [description, kind, expiry, now, expected status]
  const rows: Array<[string, string, string | null, string, string]> = [
    ["equity has no expiry", "equity", null, "2024-06-12T05:00:00Z", "NOT_APPLICABLE"],
    ["option expiring next week", "option", "2024-06-20", "2024-06-12T05:00:00Z", "OK"],
    ["option expired yesterday", "option", "2024-06-11", "2024-06-12T05:00:00Z", "EXPIRED"],
    ["option after its expiry-day close", "option", "2024-06-12", "2024-06-12T10:00:00Z", "EXPIRED"], // 15:30 IST
    ["option 29 minutes before the close on expiry day", "option", "2024-06-12", "2024-06-12T09:31:00Z", "TOO_SOON"], // 15:01 IST
    ["option exactly 30 minutes before the close", "option", "2024-06-12", "2024-06-12T09:30:00Z", "OK"], // 15:00 IST
    ["future 10 minutes before the close", "future", "2024-06-12", "2024-06-12T09:50:00Z", "TOO_SOON"],
    ["missing expiry on an option", "option", null, "2024-06-12T05:00:00Z", "INVALID"],
    ["not a date", "option", "next friday", "2024-06-12T05:00:00Z", "INVALID"],
    ["impossible calendar date", "option", "2024-02-30", "2024-06-12T05:00:00Z", "INVALID"],
    ["wrong format", "future", "12-06-2024", "2024-06-12T05:00:00Z", "INVALID"],
  ];
  it.each(rows)("%s", (_d, kind, expiry, now, status) => {
    expect(assessExpiry({ kind, expiry, at: new Date(now), market: "NSE" }, cfg).status).toBe(status);
  });
  it("an option with an unknown market has no session and is INVALID, never guessed", () => {
    expect(assessExpiry({ kind: "option", expiry: "2024-06-20", at: NOW, market: "LSE" }, cfg).status).toBe("INVALID");
  });
  it("expiry-day detection uses the local date, and the minimum time to expiry is configurable", () => {
    expect(assessExpiry({ kind: "option", expiry: "2024-06-12", at: NOW, market: "NSE" }, cfg)).toMatchObject({ status: "OK", expiryDay: true, minutesToExpiry: 330 });
    expect(assessExpiry({ kind: "option", expiry: "2024-06-13", at: NOW, market: "NSE" }, cfg).expiryDay).toBe(false);
    const c = loadMarketRiskConfig({ TWINS_MARKET_MIN_MINUTES_TO_EXPIRY_OPTION: "121" });
    expect(assessExpiry({ kind: "option", expiry: "2024-06-12", at: new Date("2024-06-12T08:00:00Z"), market: "NSE" }, c).status).toBe("TOO_SOON"); // 13:30 IST: 120 minutes remain, the configured minimum is 121
  });
});

describe("the gate engine", () => {
  it("a healthy equity decision in an open session passes every gate", () => {
    const r = run();
    expect(r).toMatchObject({ outcome: "PASSED", reasonCode: null, failures: [], conditions: [] });
    expect(Object.values(r.gates).filter((g) => g.result === "FAIL")).toEqual([]);
    expect(r.snapshot).toMatchObject({ outcome: "PASSED", thresholds: { maxSpreadPct: 0.5, minBidQty: 100 }, observed: { ageSeconds: 5 } });
  });
  // [description, input override, expected primary reason]
  const reject: Array<[string, Partial<MarketGateInput>, string]> = [
    ["market closed (evening)", { now: new Date("2024-06-12T12:00:00Z") , snapshot: snap({}, new Date("2024-06-12T12:00:00Z")) }, "MARKET_CLOSED"],
    ["weekend", { now: new Date("2024-06-15T05:00:00Z"), snapshot: snap({}, new Date("2024-06-15T05:00:00Z")) }, "MARKET_CLOSED"],
    ["unknown market", { market: "LSE" }, "MARKET_CLOSED"],
    ["expired option", { instrumentType: "option", expiry: "2024-06-11", entryPrice: 100 }, "EXPIRED_CONTRACT"],
    ["option 20 minutes before expiry", { now: new Date("2024-06-12T09:40:00Z"), instrumentType: "option", expiry: "2024-06-12", snapshot: snap({}, new Date("2024-06-12T09:40:00Z")) }, "EXPIRY_TOO_SOON"],
    ["option without an expiry", { instrumentType: "option", expiry: null }, "INVALID_MARKET_DATA"],
    ["CRITICAL blackout for the market", { windows: [win()] }, "EVENT_BLACKOUT_ACTIVE"],
    ["CRITICAL blackout for ALL markets", { windows: [win({ market: "ALL" })] }, "EVENT_BLACKOUT_ACTIVE"],
    ["CRITICAL blackout for the symbol", { windows: [win({ scope: "SYMBOL", scopeValue: "RELIANCE" })] }, "EVENT_BLACKOUT_ACTIVE"],
    ["circuit breaker open", { circuitBreaker: { blocked: true, blockedBy: ["DAILY"] } }, "CIRCUIT_BREAKER_ACTIVE"],
    ["stale data (61 s)", { snapshot: snap({ timestamp: new Date(NOW.getTime() - 61_000) }) }, "STALE_MARKET_DATA"],
    ["data from the future", { snapshot: snap({ timestamp: new Date(NOW.getTime() + 60_000) }) }, "INVALID_MARKET_DATA"],
    ["no timestamp", { snapshot: snap({ timestamp: null }) }, "INVALID_MARKET_DATA"],
    ["crossed market (bid > ask)", { snapshot: snap({ bid: 101, ask: 100 }) }, "INVALID_MARKET_DATA"],
    ["zero bid", { snapshot: snap({ bid: 0 }) }, "INVALID_MARKET_DATA"],
    ["missing ask", { snapshot: snap({ ask: null }) }, "INVALID_MARKET_DATA"],
    ["negative volume", { snapshot: snap({ volume: -1 }) }, "INVALID_MARKET_DATA"],
    ["NaN last price", { snapshot: snap({ last: Number.NaN }) }, "INVALID_MARKET_DATA"],
    ["entry price far from last (sanity)", { entryPrice: 120 }, "INVALID_MARKET_DATA"],
    ["missing entry price", { entryPrice: null }, "INVALID_MARKET_DATA"],
    ["bid quantity below the minimum", { snapshot: snap({ bidQty: 99 }) }, "INSUFFICIENT_LIQUIDITY"],
    ["ask quantity below the minimum", { snapshot: snap({ askQty: 10 }) }, "INSUFFICIENT_LIQUIDITY"],
    ["volume below the minimum", { snapshot: snap({ volume: 9_999 }) }, "INSUFFICIENT_LIQUIDITY"],
    ["spread 0.6% (> 0.5%)", { snapshot: snap({ bid: 99.7, ask: 100.3 }) }, "SPREAD_TOO_WIDE"],
    ["unsupported instrument type", { instrumentType: "fx" }, "INVALID_MARKET_DATA"],
  ];
  it.each(reject)("rejects: %s", (_d, over, reason) => {
    const r = run(over);
    expect({ outcome: r.outcome, reason: r.reasonCode }).toEqual({ outcome: "REJECTED", reason });
    expect(MARKET_REASONS).toContain(r.reasonCode);
    expect(r.failures.length).toBeGreaterThan(0);
  });
  // [description, snapshot override, expected outcome]: thresholds sit exactly on the line
  const edge: Array<[string, Partial<MarketSnapshot>, string]> = [
    ["bid/ask quantity exactly at the minimum", { bidQty: 100, askQty: 100 }, "PASSED"],
    ["volume exactly at the minimum", { volume: 10_000 }, "PASSED"],
    ["data exactly at the maximum age", { timestamp: new Date(NOW.getTime() - 60_000) }, "PASSED"],
    ["spread exactly 0.5%", { bid: 99.75062344, ask: 100.24937656 }, "PASSED"],
    ["spread just above 0.5%", { bid: 99.74, ask: 100.26 }, "REJECTED"],
  ];
  it.each(edge)("threshold edge: %s", (_d, over, outcome) => {
    expect(run({ snapshot: snap(over) }).outcome).toBe(outcome);
  });
  it("options and futures need open interest and a minimum volume / OI; equity does not", () => {
    const opt = (o: Partial<MarketSnapshot>) => run({ instrumentType: "option", expiry: "2024-06-20", market: "NFO", snapshot: snap({ volume: 500, openInterest: 5_000, ...o }) });
    expect(opt({}).outcome).toBe("PASSED");
    expect(opt({ openInterest: null })).toMatchObject({ outcome: "REJECTED", reasonCode: "INVALID_MARKET_DATA" });
    expect(opt({ openInterest: 999 })).toMatchObject({ outcome: "REJECTED", reasonCode: "INSUFFICIENT_LIQUIDITY" });
    expect(opt({ volume: 99 })).toMatchObject({ reasonCode: "INSUFFICIENT_LIQUIDITY" });
    expect(run({ snapshot: snap({ openInterest: null }) }).outcome).toBe("PASSED"); // equity: OI not applicable
    expect(run({ instrumentType: "option", market: "NFO", expiry: "2024-06-20", snapshot: snap({ bid: 98, ask: 102, volume: 500, openInterest: 5_000 }) }).outcome).toBe("PASSED"); // a 4% option spread is within the 5% option limit
    expect(run({ instrumentType: "option", market: "NFO", expiry: "2024-06-20", snapshot: snap({ bid: 96, ask: 104, volume: 500, openInterest: 5_000 }) }).reasonCode).toBe("SPREAD_TOO_WIDE"); // 8%
  });
  it("expiry day is stricter: the same data that passes a normal day fails the stricter liquidity / spread rule with EXPIRY_DAY_RESTRICTION; blocking is configurable", () => {
    const base = { instrumentType: "option", market: "NFO", expiry: "2024-06-12", entryPrice: 100 } as const;
    // normal thresholds (qty 50, spread 5%) pass, the expiry-day ones (qty 100, spread 2.5%) fail
    expect(run({ ...base, expiry: "2024-06-20", snapshot: snap({ bidQty: 60, askQty: 60, volume: 500, openInterest: 5_000 }) }).outcome).toBe("PASSED");
    expect(run({ ...base, snapshot: snap({ bidQty: 60, askQty: 60, volume: 500, openInterest: 5_000 }) })).toMatchObject({ outcome: "REJECTED", reasonCode: "EXPIRY_DAY_RESTRICTION" });
    expect(run({ ...base, snapshot: snap({ bid: 97, ask: 103, bidQty: 500, askQty: 500, volume: 5_000, openInterest: 50_000 }) })).toMatchObject({ outcome: "REJECTED", reasonCode: "SPREAD_TOO_WIDE" }); // 6% breaks even the NORMAL 5% limit
    expect(run({ ...base, snapshot: snap({ bid: 98.6, ask: 101.4, bidQty: 500, askQty: 500, volume: 5_000, openInterest: 50_000 }) })).toMatchObject({ outcome: "REJECTED", reasonCode: "EXPIRY_DAY_RESTRICTION" }); // 2.8%: inside the normal 5% but over the expiry-day 2.5%
    expect(run({ ...base, snapshot: snap({ bidQty: 500, askQty: 500, volume: 5_000, openInterest: 50_000, bid: 99.5, ask: 100.5 }) }).outcome).toBe("PASSED"); // healthy even by the stricter rules
    const blocked = loadMarketRiskConfig({ TWINS_MARKET_EXPIRY_DAY_BLOCK: "true" });
    expect(run({ ...base, snapshot: snap({ bidQty: 500, askQty: 500, volume: 5_000, openInterest: 50_000 }) }, blocked)).toMatchObject({ outcome: "REJECTED", reasonCode: "EXPIRY_DAY_RESTRICTION" });
  });
  it("event windows: only ACTIVE windows of the right market / scope count; WARNING makes the decision CONDITIONAL (never PASSED), CRITICAL rejects", () => {
    expect(run({ windows: [win({ startsAt: new Date(NOW.getTime() + 1000) })] }).outcome).toBe("PASSED"); // not started
    expect(run({ windows: [win({ endsAt: new Date(NOW.getTime()) })] }).outcome).toBe("PASSED"); // ended (end exclusive)
    expect(run({ windows: [win({ market: "NYSE" })] }).outcome).toBe("PASSED"); // another market
    expect(run({ windows: [win({ scope: "SYMBOL", scopeValue: "TCS" })] }).outcome).toBe("PASSED"); // another symbol
    const warning = run({ windows: [win({ severity: "WARNING" })] });
    expect(warning).toMatchObject({ outcome: "CONDITIONAL", reasonCode: null, conditions: ["EVENT_BLACKOUT_WARNING"] });
    expect(run({ windows: [win({ severity: "WARNING" }), win({ id: "w2", severity: "CRITICAL" })] })).toMatchObject({ outcome: "REJECTED", reasonCode: "EVENT_BLACKOUT_ACTIVE" });
    expect(run({ windows: [win({ severity: "WARNING" })], snapshot: snap({ bidQty: 1 }) })).toMatchObject({ outcome: "REJECTED", reasonCode: "INSUFFICIENT_LIQUIDITY" }); // a WARNING never softens a failure
  });
  it("every failure is listed and the primary reason follows the fixed precedence", () => {
    const r = run({ circuitBreaker: { blocked: true, blockedBy: ["WEEKLY"] }, now: new Date("2024-06-15T05:00:00Z"), windows: [win({ startsAt: new Date("2024-06-14T00:00:00Z"), endsAt: new Date("2024-06-16T00:00:00Z") })], snapshot: snap({ bidQty: 1, bid: 99, ask: 105 }, new Date("2024-06-15T05:00:00Z")) });
    expect(r.reasonCode).toBe("CIRCUIT_BREAKER_ACTIVE");
    expect(new Set(r.failures.map((f) => f.reason))).toEqual(new Set(["CIRCUIT_BREAKER_ACTIVE", "MARKET_CLOSED", "EVENT_BLACKOUT_ACTIVE", "INSUFFICIENT_LIQUIDITY", "SPREAD_TOO_WIDE"]));
    expect(run({ now: new Date("2024-06-12T12:00:00Z"), snapshot: snap({}, new Date("2024-06-12T12:00:00Z")) }, cfg, staticHolidayCalendar({ IN: ["2024-06-12"] })).reasonCode).toBe("MARKET_HOLIDAY");
  });
  it("observed values, thresholds and gate results are stored; the input hash ignores the clock but changes with the data", () => {
    const a = run();
    expect(a.gates["spread"]).toMatchObject({ result: "PASS", observed: expect.any(Number), threshold: { normal: 0.5 } });
    expect(a.gates["liquidity"]).toMatchObject({ result: "PASS", observed: { bidQty: 5000 } });
    expect(run().inputHash).toBe(a.inputHash);
    expect(run({ snapshot: snap({ bidQty: 5_001 }) }).inputHash).not.toBe(a.inputHash);
    expect(run({ now: new Date(NOW.getTime() + 1_000), snapshot: snap() }).inputHash).toBe(a.inputHash); // same snapshot, same verdict: same evaluation
  });
  it("per-kind thresholds are configurable and a malformed value throws", () => {
    const c = loadMarketRiskConfig({ TWINS_MARKET_MIN_QTY_EQUITY: "10000", TWINS_MARKET_MAX_SPREAD_PCT_EQUITY: "0.01", TWINS_MARKET_MAX_DATA_AGE_SECONDS: "5" });
    expect(c.thresholds.equity).toMatchObject({ minBidQty: 10_000, maxSpreadPct: 0.01 });
    expect(c.source).toMatchObject({ maxDataAgeSeconds: "env" });
    expect(run({}, c).failures.map((f) => f.reason)).toEqual(expect.arrayContaining(["INSUFFICIENT_LIQUIDITY", "SPREAD_TOO_WIDE"]));
    for (const env of [{ TWINS_MARKET_MIN_QTY_EQUITY: "0" }, { TWINS_MARKET_MAX_SPREAD_PCT_OPTION: "abc" }, { TWINS_MARKET_EXPIRY_DAY_BLOCK: "yes" }, { TWINS_MARKET_MAX_DATA_AGE_SECONDS: "0" }, { TWINS_MARKET_EXPIRY_DAY_SPREAD_MULT: "2" }]) expect(() => loadMarketRiskConfig(env), JSON.stringify(env)).toThrow();
  });
});

describe("alerts: WARNING for data and liquidity problems, none for normal closed-market rejections, CRITICAL only for operational failures; redacted", () => {
  const alertsFor = (over: Partial<MarketGateInput>) => marketAlerts(run(over), "equity");
  it("stale data, wide spread, low liquidity and approaching expiry raise WARNING", () => {
    expect(alertsFor({ snapshot: snap({ timestamp: new Date(NOW.getTime() - 120_000) }) }).map((a) => a.code)).toEqual(["stale_market_data"]);
    expect(alertsFor({ snapshot: snap({ bid: 99, ask: 101 }) })[0]).toMatchObject({ severity: "WARNING", event: "risk.market_gate.warning", code: "spread_too_wide" });
    expect(alertsFor({ snapshot: snap({ bidQty: 1 }) })[0]).toMatchObject({ severity: "WARNING", code: "insufficient_liquidity" });
    expect(marketAlerts(run({ now: new Date("2024-06-12T09:40:00Z"), instrumentType: "option", expiry: "2024-06-12", snapshot: snap({}, new Date("2024-06-12T09:40:00Z")) }), "option")[0]).toMatchObject({ severity: "WARNING", code: "expiry_too_soon" });
  });
  it("no alert for a closed market, holiday, weekend, expired contract, blackout or circuit breaker (normal rejections)", () => {
    expect(alertsFor({ now: new Date("2024-06-15T05:00:00Z"), snapshot: snap({}, new Date("2024-06-15T05:00:00Z")) })).toEqual([]);
    expect(alertsFor({ windows: [win()] })).toEqual([]);
    expect(alertsFor({ circuitBreaker: { blocked: true, blockedBy: ["DAILY"] } })).toEqual([]);
    expect(alertsFor({ instrumentType: "option", expiry: "2024-06-11" })).toEqual([]);
  });
  it("a provider failure is CRITICAL, 'no data' is a WARNING; the built alert carries only reason and kind and redacts secret-shaped values", () => {
    expect(marketDataFailureAlert("option", "CRITICAL", "MARKET_DATA_UNAVAILABLE")).toMatchObject({ severity: "CRITICAL", event: "risk.market_gate.data_unavailable" });
    expect(marketDataFailureAlert("option", "WARNING", "MARKET_DATA_UNAVAILABLE").severity).toBe("WARNING");
    const a = marketAlerts(run({ snapshot: snap({ bidQty: 1 }) }), "equity")[0];
    const built = buildAlert({ ...a!, details: { ...a!.details, symbol: "RELIANCE", price: 100, rawText: "BUY RELIANCE", password: "hunter2", name: "Bearer abcdefgh12345678" } }, { environment: "test", service: "worker" });
    expect(built.details).toEqual({ reason: "INSUFFICIENT_LIQUIDITY", kind: "equity", name: "[redacted]" });
    expect(JSON.stringify(built)).not.toMatch(/RELIANCE|hunter2|Bearer|BUY/);
  });
});

describe("fail closed and architecture", () => {
  it("runtime state is checked first: kill switch, intake off, unreadable and unconfigured all refuse without touching the database or the provider", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let called = 0;
    const provider = { name: "p", getSnapshot: async () => { called++; return snap(); } };
    for (const set of [(s: ReturnType<typeof inMemoryStateSource>) => s.set({ KILL_SWITCH_ACTIVE: true }), (s: ReturnType<typeof inMemoryStateSource>) => s.set({ INTAKE_ENABLED: false }), (s: ReturnType<typeof inMemoryStateSource>) => s.failWith(new Error("down"))]) {
      const source = inMemoryStateSource();
      set(source);
      configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
      await expect(evaluateMarketRisk(untouchable, id, { provider })).rejects.toMatchObject({ code: "safety_refused" });
    }
    resetRuntimeState();
    await expect(evaluateMarketRisk(untouchable, id, { provider })).rejects.toMatchObject({ code: "safety_refused" });
    expect(called).toBe(0);
  });
  it("without a market-data provider nothing is evaluated or approved (market_data_unavailable), before the database", async () => {
    configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 });
    await expect(evaluateMarketRisk(untouchable, "11111111-1111-4111-8111-111111111111", {})).rejects.toMatchObject({ code: "market_data_unavailable" });
  });
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((x) => (statSync(join(ROOT, dir, x)).isDirectory() ? files(`${dir}/${x}`) : x.endsWith(".ts") ? [`${dir}/${x}`] : []));
  it("the pure modules do no I/O; nothing under market/ references orders, fills, positions, brokers, Telegram, approval cards or an external API", () => {
    for (const f of ["config", "sessions", "expiry", "engine"].map((n) => `packages/risk/src/market/${n}.ts`)) {
      const code = strip(read(f));
      expect([...code.matchAll(/from\s+"([^"]+)"/g)].every((m) => m[1] === "node:crypto" || (m[1] as string).startsWith("./")), f).toBe(true);
      expect(code, f).not.toMatch(/Date\.now|new Date\(\)|Math\.random|fetch\(|process\.env\.[A-Z]/);
    }
    for (const f of files("packages/risk/src/market")) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|decisions|claimReviewCards)\b|zerodha|kite|broker|telegram|sendMessage|approval card|https?:\/\//i);
  });
  it("only the market record module appends risk decisions from market/, the window module is the only writer of event_blackout_windows, and the worker has NO provider configured", () => {
    expect(strip(read("packages/risk/src/market/record.ts"))).not.toMatch(/\.insert\(|(db|tx)\.update\(|\.delete\(/);
    const writers = files("packages/risk/src").concat(files("services"), files("apps"), files("scripts")).filter((f) => /\.insert\(\s*schema\.eventBlackoutWindows\b|insert into event_blackout_windows\b/i.test(strip(read(f))));
    expect(writers).toEqual(["packages/risk/src/market/windows.ts"]);
    const worker = strip(read("services/worker/src/index.ts"));
    expect(worker).toMatch(/let marketDataProvider: MarketDataProvider \| undefined;/);
    const configurers = [...files("services"), ...files("apps"), ...files("scripts")].filter((f) => /configureMarketDataProvider\(/.test(strip(read(f))) && f !== "services/worker/src/index.ts" && !f.includes("/dist/"));
    expect(configurers).toEqual([]); // no production process injects a market-data provider (none exists)
  });
  it("migration 0018 installs the blackout chain ENABLE ALWAYS and the market-review check (NOT VALID)", () => {
    const sql = read("packages/database/drizzle/0018_market_risk_gates.sql");
    for (const t of ["event_blackout_windows_a_integrity_before_insert", "event_blackout_windows_chain_before_insert", "event_blackout_windows_no_update_delete", "event_blackout_windows_no_truncate"]) expect(sql, t).toContain(`ENABLE ALWAYS TRIGGER "${t}"`);
    expect(sql).toMatch(/risk_decisions_market_review_check[^;]*NOT VALID/);
  });
});
