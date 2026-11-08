import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry, createProductionRegistry, DEFAULT_AGENT_RULES, DEFAULT_REQUIRED_AGENTS, ECONOMIC_CALENDAR_FORMAT, fileEconomicCalendar, fileHolidayCalendar, fileMacroProvider, HOLIDAY_CALENDAR_FORMAT, loadAgentEngineConfig,
  loadAgentRulesConfig, MACRO_CONTEXT_FORMAT, parseEconomicCalendar, parseHolidayCalendar, parseMacroContext, PRODUCTION_AGENT_IDS, resolveCalendarMacroProviders, type AgentContractError,
} from "../../../packages/agents/src/index";

type Rec = Record<string, ReturnType<typeof JSON.parse>>;
const tmp = (name: string, body: unknown): string => { const d = mkdtempSync(join(tmpdir(), "twins-cal-")); const p = join(d, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const holidays = () => ({ format: HOLIDAY_CALENDAR_FORMAT, source: "synthetic", as_of: "2025-01-01T00:00:00Z", markets: { NSE: { from: "2025-01-01", to: "2025-12-31", days: [{ date: "2025-03-14", holiday: true, name: "Synthetic Holiday" }, { date: "2025-01-08", early_close: "13:30" }] } } });
const economic = () => ({ format: ECONOMIC_CALENDAR_FORMAT, source: "synthetic", as_of: "2025-01-01T00:00:00Z", coverage: { from: "2025-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z" }, events: [{ id: "evt-1", name: "Synthetic decision", at: "2025-01-06T09:00:00+05:30", impact: "CRITICAL", markets: ["NSE"], category: "central_bank" }] });
const macro = () => ({ format: MACRO_CONTEXT_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", contexts: { "NSE:*": {
  index: { symbol: "SYNTHIDX", level: 24500, previous_close: 24400, open: 24450, recent_closes: [24000, 24100, 24200, 24300, 24400] }, breadth: { advancers: 1200, decliners: 800 },
  volatility_index: { name: "SYNTHVIX", level: 14, change_pct_1d: -1 }, currency: { pair: "SYNTHFX", change_pct_1d: 0.1 }, global: [{ name: "SYNTHGLOBAL", session_status: "closed", change_pct_1d: 0.4 }],
  releases: [{ id: "rel-1", name: "Synthetic release", at: "2025-01-06T10:00:00Z", impact: "HIGH", markets: ["NSE"] }] } } });

describe("holiday calendar file (twins-holiday-calendar-v1)", () => {
  it("parses a valid file: regular days, holidays, early closes and uncovered dates", async () => {
    const p = fileHolidayCalendar(tmp("h.json", holidays()));
    expect(p).toMatchObject({ name: "file:synthetic", asOf: "2025-01-01T00:00:00.000Z" });
    expect(await p.day("NSE", "2025-03-14")).toEqual({ date: "2025-03-14", holiday: true, holidayName: "Synthetic Holiday", earlyCloseLocal: null });
    expect(await p.day("NSE", "2025-01-08")).toMatchObject({ holiday: false, earlyCloseLocal: "13:30" });
    expect(await p.day("nse", "2025-01-07")).toMatchObject({ holiday: false, earlyCloseLocal: null });
    expect(await p.day("NSE", "2026-01-01")).toBeNull();
    expect(await p.day("LSE", "2025-01-07")).toBeNull();
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "v0"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["an as_of without an offset", (b) => { b["as_of"] = "2025-01-01T00:00:00"; }],
    ["no markets", (b) => { b["markets"] = {}; }], ["a lower-case market", (b) => { b["markets"]["nse"] = b["markets"]["NSE"]; delete b["markets"]["NSE"]; }],
    ["a reversed range", (b) => { b["markets"]["NSE"].from = "2026-01-01"; }], ["an impossible date", (b) => { b["markets"]["NSE"].days[0].date = "2025-02-30"; }],
    ["a day outside the range", (b) => { b["markets"]["NSE"].days[0].date = "2024-03-14"; }], ["a duplicate day", (b) => { b["markets"]["NSE"].days.push({ ...b["markets"]["NSE"].days[0] }); }],
    ["a holiday with an early close", (b) => { b["markets"]["NSE"].days[0].early_close = "13:30"; }], ["a bad early close", (b) => { b["markets"]["NSE"].days[1].early_close = "25:99"; }],
    ["a day that is neither", (b) => { b["markets"]["NSE"].days.push({ date: "2025-05-01" }); }], ["a non-boolean holiday", (b) => { b["markets"]["NSE"].days[0].holiday = "yes"; }],
  ])("rejects %s (nothing is repaired)", (_n, mutate) => {
    const b = structuredClone(holidays()) as Rec;
    mutate(b);
    expect(() => parseHolidayCalendar(b)).toThrowError(expect.objectContaining({ code: "INVALID_CALENDAR_DATA" }) as AgentContractError);
  });
});

describe("economic calendar file (twins-economic-calendar-v1)", () => {
  it("parses a valid file and returns events inside a window (offsets normalised to UTC)", async () => {
    const p = fileEconomicCalendar(tmp("e.json", economic()));
    expect(p.coverage).toEqual({ from: "2025-01-01T00:00:00.000Z", to: "2025-12-31T00:00:00.000Z" });
    const ev = await p.events({ from: "2025-01-06T00:00:00Z", to: "2025-01-07T00:00:00Z" });
    expect(ev).toEqual([{ id: "evt-1", name: "Synthetic decision", at: "2025-01-06T03:30:00.000Z", impact: "CRITICAL", markets: ["NSE"], category: "central_bank" }]);
    expect(await p.events({ from: "2025-02-01T00:00:00Z", to: "2025-02-02T00:00:00Z" })).toEqual([]);
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["a missing coverage", (b) => { delete b["coverage"]; }], ["a reversed coverage", (b) => { b["coverage"] = { from: "2026-01-01T00:00:00Z", to: "2025-01-01T00:00:00Z" }; }],
    ["an event without an offset", (b) => { b["events"][0].at = "2025-01-06T09:00:00"; }], ["an unknown impact", (b) => { b["events"][0].impact = "HUGE"; }], ["no markets", (b) => { b["events"][0].markets = []; }],
    ["a duplicate id", (b) => { b["events"].push({ ...b["events"][0] }); }], ["events that are not a list", (b) => { b["events"] = {}; }],
  ])("rejects %s", (_n, mutate) => {
    const b = structuredClone(economic()) as Rec;
    mutate(b);
    expect(() => parseEconomicCalendar(b)).toThrowError(expect.objectContaining({ code: "INVALID_CALENDAR_DATA" }) as AgentContractError);
  });
});

describe("macro context file (twins-macro-context-v1)", () => {
  it("parses a valid file; the market-wide key serves any underlying and an exact key wins", async () => {
    const b = macro() as Rec;
    b["contexts"]["NSE:NIFTY"] = { index: { symbol: "NIFTY", level: 1, recent_closes: [1] } };
    const p = parseMacroContext(b);
    expect((await p.context({ market: "NSE", underlying: "RELIANCE" }))?.index?.symbol).toBe("SYNTHIDX");
    expect((await p.context({ market: "nse", underlying: "nifty" }))?.index?.symbol).toBe("NIFTY");
    expect(await p.context({ market: "LSE", underlying: "X" })).toBeNull();
    const s = await p.context({ market: "NSE", underlying: "RELIANCE" });
    expect(s).toMatchObject({ asOf: "2025-01-06T04:00:00.000Z", breadth: { advancers: 1200 }, volatilityIndex: { name: "SYNTHVIX", level: 14, changePct1d: -1 }, currency: { pair: "SYNTHFX" }, releases: [{ id: "rel-1", impact: "HIGH" }] });
    expect(fileMacroProvider(tmp("m.json", macro())).name).toBe("file:synthetic");
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["no contexts", (b) => { b["contexts"] = {}; }], ["a bad context key", (b) => { b["contexts"]["nse"] = b["contexts"]["NSE:*"]; delete b["contexts"]["NSE:*"]; }],
    ["a non-finite level", (b) => { b["contexts"]["NSE:*"].index.level = null; }], ["a negative close", (b) => { b["contexts"]["NSE:*"].index.recent_closes[0] = -1; }], ["a bad breadth", (b) => { b["contexts"]["NSE:*"].breadth.advancers = 1.5; }],
    ["a bad volatility level", (b) => { b["contexts"]["NSE:*"].volatility_index.level = "high"; }], ["a bad global session", (b) => { b["contexts"]["NSE:*"].global[0].session_status = "lunch"; }],
    ["a malformed release", (b) => { delete b["contexts"]["NSE:*"].releases[0].impact; }], ["an unsafe label", (b) => { b["contexts"]["NSE:*"].index.symbol = "A<b>"; }],
  ])("rejects %s", (_n, mutate) => {
    const b = structuredClone(macro()) as Rec;
    mutate(b);
    expect(() => parseMacroContext(b)).toThrowError(expect.objectContaining({ code: "INVALID_MACRO_DATA" }) as AgentContractError);
  });
});

describe("provider files are read safely", () => {
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-cal-"));
    writeFileSync(join(d, "bad.json"), "{nope"); writeFileSync(join(d, "x.csv"), "a,b"); writeFileSync(join(d, "id_rsa.json"), JSON.stringify(holidays()));
    const ok = tmp("ok.json", holidays());
    symlinkSync(ok, join(d, "link.json"));
    for (const p of [join(d, "bad.json"), join(d, "x.csv"), join(d, "id_rsa.json"), join(d, "link.json"), join(d, "missing.json")]) {
      expect(() => fileHolidayCalendar(p), p).toThrowError(expect.objectContaining({ code: "INVALID_CALENDAR_DATA" }) as AgentContractError);
      expect(() => fileEconomicCalendar(p), p).toThrow();
      expect(() => fileMacroProvider(p), p).toThrow();
    }
  });
  it("resolveCalendarMacroProviders: none => null, file: => provider, anything else / a bad file THROWS (start-up fails closed)", () => {
    expect(resolveCalendarMacroProviders(DEFAULT_AGENT_RULES)).toEqual({ holidayCalendar: null, economicCalendar: null, macroProvider: null });
    const rules = loadAgentRulesConfig({ TWINS_AGENT_HOLIDAY_CALENDAR: `file:${tmp("h.json", holidays())}`, TWINS_AGENT_ECONOMIC_CALENDAR: `file:${tmp("e.json", economic())}`, TWINS_AGENT_MACRO_PROVIDER: `file:${tmp("m.json", macro())}` });
    const r = resolveCalendarMacroProviders(rules);
    expect([r.holidayCalendar?.name, r.economicCalendar?.name, r.macroProvider?.name]).toEqual(["file:synthetic", "file:synthetic", "file:synthetic"]);
    expect(() => resolveCalendarMacroProviders(loadAgentRulesConfig({ TWINS_AGENT_MACRO_PROVIDER: `file:${tmp("bad.json", "{")}` }))).toThrow();
  });
});

describe("rule configuration for the calendar and macro agents (conservative defaults, strict overrides)", () => {
  it("defaults", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.calendar).toMatchObject({ holidaySource: "none", economicSource: "none", lookAheadMinutes: 240, criticalBefore: 60, criticalAfter: 30, criticalSeverity: "BLOCKING", highBefore: 120, expiryDay: "CAUTION", expiryApproaching: "INFO", signalOutsideSession: "CAUTION" });
    expect(Object.keys(DEFAULT_AGENT_RULES.calendar.sessions).sort()).toEqual(["BFO", "BSE", "NFO", "NSE"]);
    expect(DEFAULT_AGENT_RULES.calendar.sessions["NSE"]).toEqual({ utcOffsetMinutes: 330, open: "09:15", close: "15:30" });
    expect(DEFAULT_AGENT_RULES.macro).toMatchObject({ source: "none", trendLookbackSessions: 5, volCaution: 20, volAdverse: 25, volBlock: 40, moveBlock: 7, criticalRelease: "BLOCKING", staleCautionMinutes: 60, unavailableMinutes: 1440 });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_HOLIDAY_CALENDAR: "file:/d/h.json", TWINS_AGENT_ECONOMIC_CALENDAR: "file:/d/e.json", TWINS_AGENT_MACRO_PROVIDER: "file:/d/m.json",
      TWINS_AGENT_CALENDAR_SESSIONS: '{"LSE":{"utcOffsetMinutes":0,"open":"08:00","close":"16:30"}}', TWINS_AGENT_CALENDAR_LOOKAHEAD_MINUTES: "600", TWINS_AGENT_CRITICAL_BLACKOUT_BEFORE_MINUTES: "90", TWINS_AGENT_CRITICAL_BLACKOUT_AFTER_MINUTES: "45",
      TWINS_AGENT_CRITICAL_EVENT_BLACKOUT: "ADVERSE", TWINS_AGENT_HIGH_EVENT_BEFORE_MINUTES: "180", TWINS_AGENT_HIGH_EVENT_AFTER_MINUTES: "60", TWINS_AGENT_SIGNAL_OUTSIDE_SESSION: "BLOCKING", TWINS_AGENT_EXPIRY_DAY_SEVERITY: "ADVERSE",
      TWINS_AGENT_EXPIRY_APPROACHING_SEVERITY: "CAUTION", TWINS_AGENT_EXPIRY_APPROACHING_DAYS: "5", TWINS_AGENT_NEAR_CLOSE_MINUTES: "30", TWINS_AGENT_CALENDAR_MAX_AGE_DAYS: "7",
      TWINS_AGENT_MACRO_TREND_LOOKBACK_SESSIONS: "10", TWINS_AGENT_MACRO_TREND_SUPPORTIVE_PCT: "1", TWINS_AGENT_MACRO_TREND_CAUTION_PCT: "1.5", TWINS_AGENT_MACRO_TREND_ADVERSE_PCT: "3",
      TWINS_AGENT_MACRO_VOL_CAUTION: "18", TWINS_AGENT_MACRO_VOL_ADVERSE: "22", TWINS_AGENT_MACRO_VOL_BLOCK: "35", TWINS_AGENT_MACRO_VOL_SPIKE_PCT: "10", TWINS_AGENT_MACRO_INDEX_MOVE_CAUTION: "1", TWINS_AGENT_MACRO_INDEX_MOVE_ADVERSE: "2",
      TWINS_AGENT_MACRO_INDEX_MOVE_BLOCK: "5", TWINS_AGENT_MACRO_GAP_CAUTION: "0.5", TWINS_AGENT_MACRO_GAP_ADVERSE: "1.5", TWINS_AGENT_MACRO_BREADTH_RISK_OFF: "0.25", TWINS_AGENT_MACRO_BREADTH_RISK_ON: "0.75",
      TWINS_AGENT_MACRO_GLOBAL_CAUTION: "0.8", TWINS_AGENT_MACRO_GLOBAL_ADVERSE: "1.8", TWINS_AGENT_MACRO_CURRENCY_CAUTION: "0.5", TWINS_AGENT_MACRO_STALE_CAUTION_MINUTES: "30", TWINS_AGENT_MACRO_STALE_UNAVAILABLE_MINUTES: "720",
      TWINS_AGENT_MACRO_RELEASE_BEFORE_MINUTES: "90", TWINS_AGENT_MACRO_RELEASE_AFTER_MINUTES: "30", TWINS_AGENT_MACRO_CRITICAL_RELEASE: "ADVERSE",
    });
    expect(c.calendar).toEqual({
      holidaySource: "file:/d/h.json", economicSource: "file:/d/e.json", sessions: { LSE: { utcOffsetMinutes: 0, open: "08:00", close: "16:30" } }, lookAheadMinutes: 600, criticalBefore: 90, criticalAfter: 45, criticalSeverity: "ADVERSE",
      highBefore: 180, highAfter: 60, signalOutsideSession: "BLOCKING", expiryDay: "ADVERSE", expiryApproaching: "CAUTION", expiryApproachingDays: 5, nearCloseMinutes: 30, calendarMaxAgeDays: 7,
    });
    expect(c.macro).toEqual({
      source: "file:/d/m.json", trendLookbackSessions: 10, trendSupportivePct: 1, trendCautionPct: 1.5, trendAdversePct: 3, volCaution: 18, volAdverse: 22, volBlock: 35, volSpikePct: 10, moveCaution: 1, moveAdverse: 2, moveBlock: 5,
      gapCaution: 0.5, gapAdverse: 1.5, breadthRiskOff: 0.25, breadthRiskOn: 0.75, globalCaution: 0.8, globalAdverse: 1.8, currencyCaution: 0.5, staleCautionMinutes: 30, unavailableMinutes: 720, releaseBefore: 90, releaseAfter: 30, criticalRelease: "ADVERSE",
    });
  });
  it.each<[string, Record<string, string>]>([
    ["a bad provider source", { TWINS_AGENT_MACRO_PROVIDER: "https://feed" }], ["sessions that are not JSON", { TWINS_AGENT_CALENDAR_SESSIONS: "NSE" }], ["a session that closes before it opens", { TWINS_AGENT_CALENDAR_SESSIONS: '{"NSE":{"utcOffsetMinutes":330,"open":"15:30","close":"09:15"}}' }],
    ["a session with a bad time", { TWINS_AGENT_CALENDAR_SESSIONS: '{"NSE":{"utcOffsetMinutes":330,"open":"9:15","close":"15:30"}}' }], ["a session with an impossible offset", { TWINS_AGENT_CALENDAR_SESSIONS: '{"NSE":{"utcOffsetMinutes":9999,"open":"09:15","close":"15:30"}}' }],
    ["no sessions", { TWINS_AGENT_CALENDAR_SESSIONS: "{}" }], ["a zero look-ahead", { TWINS_AGENT_CALENDAR_LOOKAHEAD_MINUTES: "0" }], ["a bad severity", { TWINS_AGENT_CRITICAL_EVENT_BLACKOUT: "IGNORE" }],
    ["INFO as the signal-outside-session severity", { TWINS_AGENT_SIGNAL_OUTSIDE_SESSION: "INFO" }], ["a non-numeric window", { TWINS_AGENT_HIGH_EVENT_BEFORE_MINUTES: "soon" }],
    ["non-increasing volatility thresholds", { TWINS_AGENT_MACRO_VOL_CAUTION: "30", TWINS_AGENT_MACRO_VOL_ADVERSE: "25" }], ["non-increasing move thresholds", { TWINS_AGENT_MACRO_INDEX_MOVE_ADVERSE: "9" }],
    ["inverted breadth thresholds", { TWINS_AGENT_MACRO_BREADTH_RISK_OFF: "0.8" }], ["a zero lookback", { TWINS_AGENT_MACRO_TREND_LOOKBACK_SESSIONS: "0" }], ["stale caution above the unavailable limit", { TWINS_AGENT_MACRO_STALE_CAUTION_MINUTES: "2000" }],
    ["a negative number", { TWINS_AGENT_MACRO_GAP_CAUTION: "-1" }], ["a non-critical-release severity", { TWINS_AGENT_MACRO_CRITICAL_RELEASE: "CAUTION" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("registration, required set and worker wiring", () => {
  it("all thirteen production agents are registered (market-context is advisory context and NOT in the default required set) and the required set is only effective when the engine is explicitly enabled", () => {
    expect([...PRODUCTION_AGENT_IDS]).toEqual(["signal-integrity-v1", "instrument-verification-v1", "market-calendar-v1", "macro-global-v1", "news-sentiment-v1", "index-constituent-impact-v1", "technical-structure-v1", "price-action-v1", "liquidity-v1", "options-risk-v1", "historical-pattern-v1", "market-context-v1", "independent-challenger-v1"]);
    expect(createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).snapshot().map((c) => c.agentId)).toEqual(["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "instrument-verification-v1", "liquidity-v1", "macro-global-v1", "market-calendar-v1", "market-context-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1"]);
    expect([...DEFAULT_REQUIRED_AGENTS]).toEqual(["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "instrument-verification-v1", "liquidity-v1", "macro-global-v1", "market-calendar-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1"]);
    const off = loadAgentEngineConfig({});
    expect(off.enabled).toBe(false);
    expect(loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" })).toMatchObject({ enabled: true, requiredAgents: [...DEFAULT_REQUIRED_AGENTS] });
    expect(loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "" }).requiredAgents).toEqual([]);
    expect(loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_DISABLED_AGENTS: "macro-global-v1", TWINS_AGENT_ENGINE_REQUIRED: "market-calendar-v1" })).toMatchObject({ disabledAgents: ["macro-global-v1"], requiredAgents: ["market-calendar-v1"] });
    expect(() => loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_DISABLED_AGENTS: "macro-global-v1" })).toThrow(/required and disabled/); // disabling a default-required agent needs an explicit required list
  });
  it("the worker resolves the providers only when the engine is enabled and otherwise registers nothing", () => {
    const w = readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8");
    expect(w).toMatch(/const agentProviders = agentRules \? observeConfigLoad\(defaultWorkerLogger, \"agent-providers\", \(\) => \(\{ \.\.\.resolveCalendarMacroProviders\(agentRules\), \.\.\.resolveNewsConstituentProviders\(agentRules\), \.\.\.resolveOhlcProviders\(agentRules\), \.\.\.resolveQuoteProviders\(agentRules\), \.\.\.resolveHistoricalProviders\(agentRules\) \}\)\) : null;/);
    expect(w).toMatch(/\.\.\.\(agentProviders \?\? \{\}\)/);
    expect(w).toMatch(/if \(!agentRules\) return createDefaultRegistry\(\);/);
    expect(createDefaultRegistry().snapshot()).toEqual([]);
  });
  it("the new agent and provider sources read no message text, import no network / broker / LLM code, read no system clock and write nothing", () => {
    for (const f of ["marketCalendar.ts", "macroGlobal.ts", "calendarProviders.ts", "macroProvider.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(|schema\./i);
    }
  });
});
