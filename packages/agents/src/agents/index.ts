import { AgentRegistry } from "../registry";
import { fileInstrumentReference, type HistoricalInstrumentReference, type InstrumentReference } from "./instrumentReference";
import { instrumentVerificationAgent } from "./instrumentVerification";
import { signalIntegrityAgent } from "./signalIntegrity";
import type { AgentRulesConfig } from "./rules";
import { fileEconomicCalendar, fileHolidayCalendar, type EconomicCalendarProvider, type HolidayCalendarProvider } from "./calendarProviders";
import { fileMacroProvider, type MacroContextProvider } from "./macroProvider";
import { marketCalendarAgent } from "./marketCalendar";
import { macroGlobalAgent } from "./macroGlobal";

export * from "./common";
export * from "./rules";
export * from "./instrumentReference";
export * from "./signalIntegrity";
export * from "./instrumentVerification";
export * from "./calendarProviders";
export * from "./macroProvider";
export * from "./marketCalendar";
export * from "./macroGlobal";

/** The production research agents, in the order they are listed (Stage 5 / Tasks 2-3). Later tasks append to this list; nothing else is registered. */
export const PRODUCTION_AGENT_IDS = ["signal-integrity-v1", "instrument-verification-v1", "market-calendar-v1", "macro-global-v1"] as const;

export interface ProductionRegistryOptions {
  rules: AgentRulesConfig; instrumentReference?: InstrumentReference | null; historicalReference?: HistoricalInstrumentReference;
  holidayCalendar?: HolidayCalendarProvider | null; economicCalendar?: EconomicCalendarProvider | null; macroProvider?: MacroContextProvider | null;
}
/** Registers the production agents. Used only when the engine is explicitly enabled; a missing provider makes its agent report UNAVAILABLE (never a pass). */
export function createProductionRegistry(o: ProductionRegistryOptions): AgentRegistry {
  const r = new AgentRegistry();
  r.register(signalIntegrityAgent(o.rules));
  r.register(instrumentVerificationAgent(o.rules, o.instrumentReference ?? null, o.historicalReference));
  r.register(marketCalendarAgent(o.rules, o.holidayCalendar ?? null, o.economicCalendar ?? null));
  r.register(macroGlobalAgent(o.rules, o.macroProvider ?? null));
  return r;
}
/** Resolves `TWINS_AGENT_INSTRUMENT_REFERENCE` (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveInstrumentReference(source: string): InstrumentReference | null {
  if (source === "none") return null;
  if (source.startsWith("file:")) return fileInstrumentReference(source.slice(5));
  throw new Error("unsupported instrument reference source");
}

const fileSource = (source: string, what: string): string | null => {
  if (source === "none") return null;
  if (source.startsWith("file:")) return source.slice(5);
  throw new Error(`unsupported ${what} source`);
};
/** Resolves the calendar and macro provider settings (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveCalendarMacroProviders(rules: AgentRulesConfig): { holidayCalendar: HolidayCalendarProvider | null; economicCalendar: EconomicCalendarProvider | null; macroProvider: MacroContextProvider | null } {
  const h = fileSource(rules.calendar.holidaySource, "holiday calendar"), e = fileSource(rules.calendar.economicSource, "economic calendar"), m = fileSource(rules.macro.source, "macro provider");
  return { holidayCalendar: h === null ? null : fileHolidayCalendar(h), economicCalendar: e === null ? null : fileEconomicCalendar(e), macroProvider: m === null ? null : fileMacroProvider(m) };
}
