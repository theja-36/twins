import { DEFAULT_AGENT_RULES, memoryEconomicCalendar, memoryHolidayCalendar, memoryMacroProvider, type AgentRulesConfig, type CalendarEvent, type EconomicCalendarProvider, type HolidayCalendarProvider, type MacroContextProvider, type MacroSnapshot } from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";

/** SYNTHETIC calendar / macro fixtures for the Task 3 agents. NOW = Monday 2025-01-06 09:35 IST (market open; closes 15:30 IST = 10:00Z). */
export const at = (minutes: number, from: Date = NOW): string => new Date(from.getTime() + minutes * 60_000).toISOString();
export const HOLIDAYS = {
  NSE: { from: "2025-01-01", to: "2025-12-31", days: [
    { date: "2025-03-14", holiday: true, name: "Synthetic Spring Holiday" },
    { date: "2025-01-08", earlyCloseLocal: "13:30" },
    { date: "2025-01-30", holiday: true, name: "Synthetic Expiry Holiday" },
  ] },
};
export const holidayCalendar = (o: { asOf?: string | null; markets?: Parameters<typeof memoryHolidayCalendar>[0]["markets"] } = {}): HolidayCalendarProvider =>
  memoryHolidayCalendar({ name: "synthetic-holidays", asOf: o.asOf === undefined ? "2025-01-01T00:00:00.000Z" : o.asOf, markets: o.markets ?? HOLIDAYS });
export const event = (o: Partial<CalendarEvent> & { minutes: number }): CalendarEvent => ({ id: `evt-${o.minutes}`, name: "Synthetic release", at: at(o.minutes), impact: "MEDIUM", markets: ["NSE"], ...o, ...(o.at ? {} : { at: at(o.minutes) }) } as CalendarEvent);
export const economicCalendar = (events: unknown[] = [], o: { asOf?: string | null; coverage?: { from: string; to: string } } = {}): EconomicCalendarProvider =>
  memoryEconomicCalendar({ name: "synthetic-economic", asOf: o.asOf === undefined ? "2025-01-05T00:00:00.000Z" : o.asOf, coverage: o.coverage ?? { from: "2025-01-01T00:00:00.000Z", to: "2025-12-31T00:00:00.000Z" }, events });

/** A bullish-friendly snapshot: +2.08% over 5 sessions, calm volatility, healthy breadth, nothing scheduled. */
export const snapshot = (o: Partial<MacroSnapshot> = {}): MacroSnapshot => ({
  asOf: at(-5),
  index: { symbol: "SYNTHIDX", level: 24500, previousClose: 24400, open: 24450, recentCloses: [24000, 24100, 24200, 24300, 24400] },
  breadth: { advancers: 1300, decliners: 700 },
  volatilityIndex: { name: "SYNTHVIX", level: 14, changePct1d: -1 },
  currency: { pair: "SYNTHFX", changePct1d: 0.1 },
  global: [{ name: "SYNTHGLOBAL", sessionStatus: "closed", changePct1d: 0.4 }],
  releases: [],
  ...o,
});
export const macroProvider = (s: MacroSnapshot | null = snapshot()): MacroContextProvider => memoryMacroProvider({ name: "synthetic-macro", contexts: s ? { "NSE:*": s } : {} });
export const rulesWith = (over: { calendar?: Partial<AgentRulesConfig["calendar"]>; macro?: Partial<AgentRulesConfig["macro"]> } = {}): AgentRulesConfig => ({
  ...DEFAULT_AGENT_RULES, calendar: { ...DEFAULT_AGENT_RULES.calendar, ...over.calendar }, macro: { ...DEFAULT_AGENT_RULES.macro, ...over.macro },
});
