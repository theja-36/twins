import { describe, expect, it } from "vitest";
import { AgentUnavailableError, marketCalendarAgent, MARKET_CALENDAR_AGENT_ID, type AgentRulesConfig, type EconomicCalendarProvider, type HolidayCalendarProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, NOW, SIGNAL_TIME } from "../../support/agentFixtures";
import { at, economicCalendar, event, holidayCalendar, rulesWith } from "../../support/calendarMacroFixtures";

const run = async (inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; holidays?: HolidayCalendarProvider | null; economic?: EconomicCalendarProvider | null; now?: Date } = {}) =>
  (await evalAgents([marketCalendarAgent(o.rules ?? rulesWith(), o.holidays === undefined ? holidayCalendar() : o.holidays, o.economic === undefined ? economicCalendar() : o.economic)], inp, {}, [], o.now ?? NOW)).byId(MARKET_CALENDAR_AGENT_ID);
const utc = (s: string): Date => new Date(s);

describe("Market Calendar Agent: sessions", () => {
  it("market open + no events + regular day = SUPPORTIVE with no findings and evidence", async () => {
    const r = await run();
    expect(r).toMatchObject({ agentId: "market-calendar-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90, findings: [] });
    expect(r.outputSnapshot).toMatchObject({ sessionState: "OPEN", eventsConsidered: 0, minutesToClose: 355, holidayCalendar: "synthetic-holidays", economicCalendar: "synthetic-economic" });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "holiday_calendar", "economic_calendar"]));
  });
  it.each<[string, string, string, string]>([
    ["market closed (after the close)", "2025-01-06T10:30:00.000Z", "MARKET_CLOSED", "AFTER_CLOSE"],
    ["market not yet open", "2025-01-06T03:30:00.000Z", "MARKET_NOT_OPEN", "BEFORE_OPEN"],
    ["weekend (Saturday)", "2025-01-04T05:00:00.000Z", "MARKET_WEEKEND", "WEEKEND"],
    ["weekend (Sunday)", "2025-01-05T05:00:00.000Z", "MARKET_WEEKEND", "WEEKEND"],
    ["a holiday", "2025-03-14T05:00:00.000Z", "MARKET_HOLIDAY", "HOLIDAY"],
    ["exactly at the close", "2025-01-06T10:00:00.000Z", "MARKET_CLOSED", "AFTER_CLOSE"],
  ])("%s => BLOCKING %s", async (_n, when, code, state) => {
    const r = await run(inputs(), { now: utc(when) });
    expect(r).toMatchObject({ status: "COMPLETED", verdict: "BLOCKING", confidence: 100 });
    expect(codesOf(r)).toContain(code);
    expect(r.outputSnapshot["sessionState"]).toBe(state);
  });
  it("exactly at the open is OPEN", async () => { expect((await run(inputs(), { now: utc("2025-01-06T03:45:00.000Z") })).outputSnapshot["sessionState"]).toBe("OPEN"); });
  it("an early-close day: before the early close = CAUTION, after it = BLOCKING market closed", async () => {
    const before = await run(inputs(), { now: utc("2025-01-08T05:00:00.000Z") });
    expect(before.verdict).toBe("CAUTION");
    expect(codesOf(before)).toContain("EARLY_CLOSE_SESSION");
    const after = await run(inputs(), { now: utc("2025-01-08T08:30:00.000Z") }); // 14:00 IST, after the 13:30 early close
    expect(after.verdict).toBe("BLOCKING");
    expect(codesOf(after)).toContain("MARKET_CLOSED");
  });
  it("closing within the configured minutes = CAUTION (and configurable)", async () => {
    const r = await run(inputs(), { now: utc("2025-01-06T09:50:00.000Z") });
    expect(r.verdict).toBe("CAUTION");
    expect(codesOf(r)).toContain("NEAR_MARKET_CLOSE");
    expect((await run(inputs(), { now: utc("2025-01-06T09:50:00.000Z"), rules: rulesWith({ calendar: { nearCloseMinutes: 5 } }) })).verdict).toBe("SUPPORTIVE");
  });
  it("an unknown market is BLOCKING (no session is configured for it) and a missing market is BLOCKING", async () => {
    const u = await run(inputs({ rd: { market: "XYZ" } }));
    expect(u.verdict).toBe("BLOCKING"); expect(codesOf(u)).toEqual(["MARKET_UNKNOWN"]);
    const m = await run(inputs({ rd: { market: null } }));
    expect(m.verdict).toBe("BLOCKING"); expect(codesOf(m)).toEqual(["MARKET_MISSING"]);
  });
  it("the market code is case-insensitive and another configured market uses its own session and offset", async () => {
    expect((await run(inputs({ rd: { market: "nse" } }))).verdict).toBe("SUPPORTIVE");
    const rules = rulesWith({ calendar: { sessions: { LSE: { utcOffsetMinutes: 0, open: "08:00", close: "16:30" } } } });
    const hol = holidayCalendar({ markets: { LSE: { from: "2025-01-01", to: "2025-12-31", days: [] } } });
    expect((await run(inputs({ rd: { market: "LSE" }, sc: { signalTimestamp: "2025-01-06T09:55:00.000Z" } }), { rules, holidays: hol, now: utc("2025-01-06T10:00:00.000Z") })).verdict).toBe("SUPPORTIVE");
    expect((await run(inputs({ rd: { market: "LSE" } }), { rules, holidays: hol, now: utc("2025-01-06T17:00:00.000Z") })).verdict).toBe("BLOCKING");
  });
  it("a signal sent outside trading hours is a CAUTION by default (configurable), a signal sent in-session is not", async () => {
    const r = await run(inputs({ sc: { signalTimestamp: "2025-01-04T05:00:00.000Z" } })); // Saturday
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("SIGNAL_OUTSIDE_SESSION");
    expect((await run(inputs({ sc: { signalTimestamp: "2025-01-04T05:00:00.000Z" } }), { rules: rulesWith({ calendar: { signalOutsideSession: "BLOCKING" } }) })).verdict).toBe("BLOCKING");
    expect((await run(inputs({ sc: { signalTimestamp: SIGNAL_TIME } }))).verdict).toBe("SUPPORTIVE");
    const unknown = await run(inputs({ sc: { signalTimestamp: null } }));
    expect(unknown.verdict).toBe("CAUTION"); expect(codesOf(unknown)).toContain("SIGNAL_TIME_UNKNOWN");
    expect(codesOf(await run(inputs({ sc: { signalTimestamp: "2024-06-03T05:00:00.000Z" } })))).toContain("SIGNAL_DAY_NOT_COVERED"); // outside the holiday calendar's range
  });
});

describe("Market Calendar Agent: expiry", () => {
  it("expiry day = CAUTION (default), approaching = INFO (no verdict change), further away = nothing", async () => {
    const today = await run(optionInputs({ rd: { expiry: "2025-01-06" } }));
    expect(today.verdict).toBe("CAUTION"); expect(codesOf(today)).toContain("EXPIRY_DAY"); expect(today.outputSnapshot["daysToExpiry"]).toBe(0);
    const soon = await run(optionInputs({ rd: { expiry: "2025-01-07" } }));
    expect(soon.verdict).toBe("SUPPORTIVE"); expect(codesOf(soon)).toEqual(["EXPIRY_APPROACHING"]); expect(soon.findings[0]!.severity).toBe("INFO");
    const far = await run(optionInputs({ rd: { expiry: "2025-01-23" } }));
    expect(codesOf(far)).toEqual([]); expect(far.outputSnapshot["daysToExpiry"]).toBe(17);
  });
  it("the severities and the approaching window are configurable", async () => {
    const rules = rulesWith({ calendar: { expiryDay: "ADVERSE", expiryApproaching: "CAUTION", expiryApproachingDays: 3 } });
    expect((await run(optionInputs({ rd: { expiry: "2025-01-06" } }), { rules })).verdict).toBe("ADVERSE");
    expect((await run(optionInputs({ rd: { expiry: "2025-01-09" } }), { rules })).verdict).toBe("CAUTION");
    expect((await run(optionInputs({ rd: { expiry: "2025-01-10" } }), { rules })).verdict).toBe("SUPPORTIVE");
  });
  it("the expiry day is judged in the market's local calendar (late evening UTC is already the next IST day)", async () => {
    const r = await run(optionInputs({ rd: { expiry: "2025-01-06" } }), { now: utc("2025-01-06T18:45:00.000Z") }); // 00:15 IST on the 7th, also closed
    expect(codesOf(r)).toContain("EXPIRY_PASSED");
  });
  it("a passed expiry = BLOCKING; an expiry on a weekend or a holiday = CAUTION; equities have no expiry check", async () => {
    const passed = await run(optionInputs({ rd: { expiry: "2025-01-03" } }));
    expect(passed.verdict).toBe("BLOCKING"); expect(codesOf(passed)).toContain("EXPIRY_PASSED");
    const sunday = await run(optionInputs({ rd: { expiry: "2025-01-26" } }));
    expect(codesOf(sunday)).toContain("EXPIRY_ON_NON_TRADING_DAY");
    const holiday = await run(optionInputs({ rd: { expiry: "2025-01-30" } }));
    expect(holiday.verdict).toBe("CAUTION"); expect(codesOf(holiday)).toContain("EXPIRY_ON_NON_TRADING_DAY");
    expect((await run(inputs({ rd: { expiry: "2025-01-06" } }))).outputSnapshot["daysToExpiry"]).toBeUndefined();
    expect(codesOf(await run(optionInputs({ rd: { expiry: "not-a-date" } })))).toEqual([]); // malformed expiries are the integrity / instrument agents' concern
  });
});

describe("Market Calendar Agent: scheduled events", () => {
  const withEvents = (...e: Array<Parameters<typeof event>[0]>) => economicCalendar(e.map(event));
  it.each<[string, Parameters<typeof event>[0], string, string]>([
    ["a CRITICAL event inside the blackout (30 min ahead)", { minutes: 30, impact: "CRITICAL" }, "BLOCKING", "CRITICAL_EVENT_BLACKOUT"],
    ["a CRITICAL event exactly at the blackout edge (60 min ahead)", { minutes: 60, impact: "CRITICAL" }, "BLOCKING", "CRITICAL_EVENT_BLACKOUT"],
    ["a CRITICAL event that just happened (20 min ago)", { minutes: -20, impact: "CRITICAL" }, "BLOCKING", "CRITICAL_EVENT_BLACKOUT"],
    ["a CRITICAL event ahead but outside the blackout (120 min)", { minutes: 120, impact: "CRITICAL" }, "ADVERSE", "CRITICAL_EVENT_UPCOMING"],
    ["a CRITICAL event beyond the look-ahead (300 min)", { minutes: 300, impact: "CRITICAL" }, "SUPPORTIVE", ""],
    ["a CRITICAL event long past (-45 min)", { minutes: -45, impact: "CRITICAL" }, "SUPPORTIVE", ""],
    ["a HIGH event near (60 min)", { minutes: 60, impact: "HIGH" }, "ADVERSE", "HIGH_IMPACT_EVENT_NEAR"],
    ["a HIGH event that just happened (-10)", { minutes: -10, impact: "HIGH" }, "ADVERSE", "HIGH_IMPACT_EVENT_NEAR"],
    ["a HIGH event later in the look-ahead (200 min)", { minutes: 200, impact: "HIGH" }, "CAUTION", "HIGH_IMPACT_EVENT_UPCOMING"],
    ["a MEDIUM event (90 min)", { minutes: 90, impact: "MEDIUM" }, "CAUTION", "MEDIUM_IMPACT_EVENT"],
    ["a MEDIUM event beyond the look-ahead", { minutes: 400, impact: "MEDIUM" }, "SUPPORTIVE", ""],
    ["a LOW event (INFO only)", { minutes: 30, impact: "LOW" }, "SUPPORTIVE", "LOW_IMPACT_EVENT"],
    ["an event for ALL markets", { minutes: 30, impact: "CRITICAL", markets: ["ALL"] }, "BLOCKING", "CRITICAL_EVENT_BLACKOUT"],
    ["an event for another market only", { minutes: 30, impact: "CRITICAL", markets: ["LSE"] }, "SUPPORTIVE", ""],
  ])("%s => %s", async (_n, ev, verdict, code) => {
    const r = await run(inputs(), { economic: withEvents(ev) });
    expect(r.verdict).toBe(verdict);
    if (code) expect(codesOf(r)).toContain(code); else expect(r.findings).toEqual([]);
  });
  it("no events = SUPPORTIVE; the worst event decides; the finding carries only ids, impact and timing (the name is sanitized)", async () => {
    expect((await run()).verdict).toBe("SUPPORTIVE");
    const r = await run(inputs(), { economic: withEvents({ minutes: 90, impact: "MEDIUM" }, { minutes: 45, impact: "HIGH", name: "Rate <script>x</script> decision" }, { minutes: 30, impact: "CRITICAL" }) });
    expect(r.verdict).toBe("BLOCKING");
    expect(codesOf(r)).toEqual(["CRITICAL_EVENT_BLACKOUT", "HIGH_IMPACT_EVENT_NEAR", "MEDIUM_IMPACT_EVENT"]);
    expect(r.findings[0]!.summary).toContain("Synthetic release");
    expect(JSON.stringify(r.findings)).not.toContain("<script>");
    expect(r.outputSnapshot["eventsConsidered"]).toBe(3);
  });
  it("the windows and the blackout severity are configurable", async () => {
    const e = withEvents({ minutes: 45, impact: "CRITICAL" });
    expect((await run(inputs(), { economic: e, rules: rulesWith({ calendar: { criticalBefore: 30 } }) })).verdict).toBe("ADVERSE"); // outside the shortened blackout, inside the look-ahead
    expect((await run(inputs(), { economic: e, rules: rulesWith({ calendar: { criticalSeverity: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    expect((await run(inputs(), { economic: withEvents({ minutes: 200, impact: "HIGH" }), rules: rulesWith({ calendar: { lookAheadMinutes: 100 } }) })).verdict).toBe("SUPPORTIVE");
    expect((await run(inputs(), { economic: withEvents({ minutes: 150, impact: "HIGH" }), rules: rulesWith({ calendar: { highBefore: 200 } }) })).verdict).toBe("ADVERSE");
  });
  it("a stale or undated calendar snapshot = CAUTION; partial coverage of the look-ahead = CAUTION", async () => {
    const stale = await run(inputs(), { holidays: holidayCalendar({ asOf: "2024-10-01T00:00:00.000Z" }) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("HOLIDAY_CALENDAR_STALE");
    expect(codesOf(await run(inputs(), { economic: economicCalendar([], { asOf: null }) }))).toContain("ECONOMIC_CALENDAR_AS_OF_UNKNOWN");
    const partial = await run(inputs(), { economic: economicCalendar([], { coverage: { from: "2025-01-01T00:00:00.000Z", to: at(60) } }) });
    expect(codesOf(partial)).toContain("CALENDAR_COVERAGE_PARTIAL");
  });
});

describe("Market Calendar Agent: providers unavailable or malformed => UNAVAILABLE, never a pass", () => {
  const expectUnavailable = async (r: Awaited<ReturnType<typeof run>>, code: string) => {
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
  };
  it("no holiday calendar / no economic calendar configured", async () => {
    await expectUnavailable(await run(inputs(), { holidays: null }), "HOLIDAY_CALENDAR_NOT_CONFIGURED");
    await expectUnavailable(await run(inputs(), { economic: null }), "ECONOMIC_CALENDAR_NOT_CONFIGURED");
  });
  it("a provider that throws (its message is never stored)", async () => {
    const boom = new Error("connection to calendar-host failed SECRET-DETAIL");
    const badHol: HolidayCalendarProvider = { name: "x", asOf: null, day: async () => { throw boom; } };
    const badEco: EconomicCalendarProvider = { name: "x", asOf: null, coverage: { from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, events: async () => { throw boom; } };
    const a = await run(inputs(), { holidays: badHol });
    await expectUnavailable(a, "CALENDAR_PROVIDER_UNAVAILABLE");
    const b = await run(inputs(), { economic: badEco });
    await expectUnavailable(b, "CALENDAR_PROVIDER_UNAVAILABLE");
    expect(JSON.stringify([a, b])).not.toContain("SECRET-DETAIL");
  });
  it("a date or window the calendars do not cover", async () => {
    await expectUnavailable(await run(inputs(), { now: utc("2026-02-02T05:00:00.000Z") }), "HOLIDAY_CALENDAR_DATE_NOT_COVERED");
    await expectUnavailable(await run(inputs(), { holidays: holidayCalendar({ markets: { LSE: { from: "2025-01-01", to: "2025-12-31", days: [] } } }) }), "HOLIDAY_CALENDAR_DATE_NOT_COVERED");
    await expectUnavailable(await run(inputs(), { economic: economicCalendar([], { coverage: { from: "2025-02-01T00:00:00.000Z", to: "2025-03-01T00:00:00.000Z" } }) }), "ECONOMIC_CALENDAR_NOT_COVERING_NOW");
  });
  it.each<[string, unknown]>([
    ["an event without an impact", { id: "a", name: "n", at: at(10), markets: ["NSE"] }],
    ["an unknown impact", { id: "a", name: "n", at: at(10), impact: "SEVERE", markets: ["NSE"] }],
    ["an event time without an offset", { id: "a", name: "n", at: "2025-01-06T09:45:00", impact: "HIGH", markets: ["NSE"] }],
    ["an empty market list", { id: "a", name: "n", at: at(10), impact: "HIGH", markets: [] }],
    ["a non-object event", "garbage"],
    ["an unsafe id", { id: "a b/../c", name: "n", at: at(10), impact: "HIGH", markets: ["NSE"] }],
  ])("malformed economic data (%s)", async (_n, bad) => {
    await expectUnavailable(await run(inputs(), { economic: economicCalendar([bad]) }), "CALENDAR_DATA_MALFORMED");
  });
  it("malformed holiday data (wrong date, non-boolean holiday) and a non-array event list", async () => {
    const wrongDate: HolidayCalendarProvider = { name: "x", asOf: null, day: async () => ({ date: "2000-01-01", holiday: false, holidayName: null, earlyCloseLocal: null }) };
    await expectUnavailable(await run(inputs(), { holidays: wrongDate }), "CALENDAR_DATA_MALFORMED");
    const badFlag: HolidayCalendarProvider = { name: "x", asOf: null, day: async (_m, d) => ({ date: d, holiday: "no" as never, holidayName: null, earlyCloseLocal: null }) };
    await expectUnavailable(await run(inputs(), { holidays: badFlag }), "CALENDAR_DATA_MALFORMED");
    const notList: EconomicCalendarProvider = { name: "x", asOf: null, coverage: { from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, events: async () => ({}) as never };
    await expectUnavailable(await run(inputs(), { economic: notList }), "CALENDAR_DATA_MALFORMED");
  });
  it("a missing required input is SKIPPED by the orchestrator before the agent runs (a required agent then makes the run INCOMPLETE)", async () => {
    const r = (await evalAgents([marketCalendarAgent(rulesWith(), holidayCalendar(), economicCalendar())], { ...inputs(), signal_context: null }, {}, [], NOW)).byId(MARKET_CALENDAR_AGENT_ID);
    expect(r).toMatchObject({ status: "SKIPPED", verdict: "UNAVAILABLE", errorCode: "MISSING_REQUIRED_INPUT" });
  });
  it("AgentUnavailableError from a provider is passed through unchanged", async () => {
    const p: HolidayCalendarProvider = { name: "x", asOf: null, day: async () => { throw new AgentUnavailableError("MY_CODE", "m"); } };
    await expectUnavailable(await run(inputs(), { holidays: p }), "MY_CODE");
  });
});

describe("Market Calendar Agent: determinism and isolation", () => {
  it("the same inputs and clock give the same result; the agent never reads the system clock (a different clock changes the outcome)", async () => {
    const a = await run(), b = await run();
    expect(a.outputSnapshot).toEqual(b.outputSnapshot);
    expect(a.findings).toEqual(b.findings);
    expect((await run(inputs(), { now: utc("2025-01-06T11:00:00.000Z") })).verdict).toBe("BLOCKING");
  });
  it("the contract is valid, can block, is not advisory and has no dependencies", async () => {
    const c = marketCalendarAgent(rulesWith(), null, null).contract;
    expect(c).toMatchObject({ agentId: "market-calendar-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision", "signal_context"] });
  });
  it("no input, finding or output contains message text (the agent only ever sees parsed fields)", async () => {
    const r = await run(inputs({ sc: { signalTimestamp: "2025-01-04T05:00:00.000Z" } }), { economic: economicCalendar([event({ minutes: 30, impact: "HIGH" })]) });
    expect(JSON.stringify([r.inputSnapshot, r.outputSnapshot, r.findings])).not.toMatch(/rawText|raw_text|telegram/i);
  });
});
