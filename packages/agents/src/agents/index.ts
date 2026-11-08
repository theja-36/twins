import { AgentRegistry } from "../registry";
import { fileInstrumentReference, type HistoricalInstrumentReference, type InstrumentReference } from "./instrumentReference";
import { instrumentVerificationAgent } from "./instrumentVerification";
import { signalIntegrityAgent } from "./signalIntegrity";
import type { AgentRulesConfig } from "./rules";
import { fileEconomicCalendar, fileHolidayCalendar, type EconomicCalendarProvider, type HolidayCalendarProvider } from "./calendarProviders";
import { fileMacroProvider, type MacroContextProvider } from "./macroProvider";
import { marketCalendarAgent } from "./marketCalendar";
import { macroGlobalAgent } from "./macroGlobal";
import { fileNewsProvider, fileSentimentProvider, type NewsProvider, type SentimentProvider } from "./newsProviders";
import { fileConstituentProvider, fileMarketData, type ConstituentProvider, type MarketDataProvider } from "./constituentProviders";
import { newsSentimentAgent } from "./newsSentiment";
import { indexConstituentAgent } from "./indexConstituent";
import { fileLastPriceProvider, fileOhlcProvider, type LastPriceProvider, type OhlcProvider } from "./ohlcProviders";
import { technicalStructureAgent } from "./technicalStructure";
import { priceActionAgent } from "./priceAction";
import { fileOptionsChainProvider, fileOptionsQuoteProvider, fileQuoteProvider, type OptionsChainProvider, type OptionsQuoteProvider, type QuoteProvider } from "./quoteProviders";
import { liquidityAgent } from "./liquidity";
import { optionsRiskAgent } from "./optionsRisk";
import { fileOutcomeProvider, filePatternProvider, type HistoricalOutcomeProvider, type HistoricalPatternProvider } from "./historicalProviders";
import { historicalPatternAgent } from "./historicalPattern";
import { independentChallengerAgent } from "./independentChallenger";
import { marketContextAgent, type RegimeProvider } from "./marketContext";

export * from "./common";
export * from "./rules";
export * from "./instrumentReference";
export * from "./signalIntegrity";
export * from "./instrumentVerification";
export * from "./calendarProviders";
export * from "./macroProvider";
export * from "./marketCalendar";
export * from "./macroGlobal";
export * from "./newsProviders";
export * from "./constituentProviders";
export * from "./newsSentiment";
export * from "./indexConstituent";
export * from "./ohlcProviders";
export * from "./ohlcCommon";
export * from "./technicalStructure";
export * from "./priceAction";
export * from "./quoteProviders";
export * from "./quoteCommon";
export * from "./liquidity";
export * from "./optionsRisk";
export * from "./historicalProviders";
export * from "./historicalPattern";
export * from "./independentChallenger";
export * from "./marketContext";

/** The production research agents, in the order they are listed (Stage 5 / Tasks 2-7). Later tasks append to this list; nothing else is registered. */
export const PRODUCTION_AGENT_IDS = ["signal-integrity-v1", "instrument-verification-v1", "market-calendar-v1", "macro-global-v1", "news-sentiment-v1", "index-constituent-impact-v1", "technical-structure-v1", "price-action-v1", "liquidity-v1", "options-risk-v1", "historical-pattern-v1", "market-context-v1", "independent-challenger-v1"] as const;

export interface ProductionRegistryOptions {
  rules: AgentRulesConfig; instrumentReference?: InstrumentReference | null; historicalReference?: HistoricalInstrumentReference;
  holidayCalendar?: HolidayCalendarProvider | null; economicCalendar?: EconomicCalendarProvider | null; macroProvider?: MacroContextProvider | null;
  newsProvider?: NewsProvider | null; sentimentProvider?: SentimentProvider | null; constituentProvider?: ConstituentProvider | null; marketDataProvider?: MarketDataProvider | null;
  ohlcProvider?: OhlcProvider | null; lastPriceProvider?: LastPriceProvider | null;
  quoteProvider?: QuoteProvider | null; optionsQuoteProvider?: OptionsQuoteProvider | null; optionsChainProvider?: OptionsChainProvider | null;
  historicalPatternProvider?: HistoricalPatternProvider | null; historicalOutcomeProvider?: HistoricalOutcomeProvider | null;
  regimeProvider?: RegimeProvider | null;
}
/** Registers the production agents. Used only when the engine is explicitly enabled; a missing provider makes its agent report UNAVAILABLE (never a pass). */
export function createProductionRegistry(o: ProductionRegistryOptions): AgentRegistry {
  const r = new AgentRegistry();
  r.register(signalIntegrityAgent(o.rules));
  r.register(instrumentVerificationAgent(o.rules, o.instrumentReference ?? null, o.historicalReference));
  r.register(marketCalendarAgent(o.rules, o.holidayCalendar ?? null, o.economicCalendar ?? null));
  r.register(macroGlobalAgent(o.rules, o.macroProvider ?? null));
  r.register(newsSentimentAgent(o.rules, o.newsProvider ?? null, o.sentimentProvider ?? null));
  r.register(indexConstituentAgent(o.rules, o.constituentProvider ?? null, o.marketDataProvider ?? null, o.newsProvider ?? null));
  r.register(technicalStructureAgent(o.rules, o.ohlcProvider ?? null, o.lastPriceProvider ?? null));
  r.register(priceActionAgent(o.rules, o.ohlcProvider ?? null, o.lastPriceProvider ?? null));
  r.register(liquidityAgent(o.rules, o.quoteProvider ?? null, o.lastPriceProvider ?? null));
  r.register(optionsRiskAgent(o.rules, o.optionsQuoteProvider ?? null, o.optionsChainProvider ?? null, o.ohlcProvider ?? null, o.lastPriceProvider ?? null));
  r.register(historicalPatternAgent(o.rules, o.historicalPatternProvider ?? null, o.historicalOutcomeProvider ?? null, o.ohlcProvider ?? null, o.lastPriceProvider ?? null));
  r.register(marketContextAgent(o.regimeProvider ?? null));
  // the challenger runs after (and reads the results of) every other registered research agent; disabling one of them requires disabling the challenger too
  r.register(independentChallengerAgent(o.rules, r.snapshot().map((c) => c.agentId)));
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
/** Resolves the news / sentiment / constituent / market-data provider settings (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveNewsConstituentProviders(rules: AgentRulesConfig): { newsProvider: NewsProvider | null; sentimentProvider: SentimentProvider | null; constituentProvider: ConstituentProvider | null; marketDataProvider: MarketDataProvider | null } {
  const n = fileSource(rules.news.source, "news provider"), s = fileSource(rules.news.sentimentSource, "sentiment provider"), c = fileSource(rules.constituent.constituentSource, "constituent provider"), m = fileSource(rules.constituent.marketDataSource, "market-data provider");
  return { newsProvider: n === null ? null : fileNewsProvider(n), sentimentProvider: s === null ? null : fileSentimentProvider(s), constituentProvider: c === null ? null : fileConstituentProvider(c), marketDataProvider: m === null ? null : fileMarketData(m) };
}
/** Resolves the OHLC and last-price provider settings (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveOhlcProviders(rules: AgentRulesConfig): { ohlcProvider: OhlcProvider | null; lastPriceProvider: LastPriceProvider | null } {
  const o = fileSource(rules.ohlc.source, "OHLC provider"), p = fileSource(rules.ohlc.priceSource, "last-price provider");
  return { ohlcProvider: o === null ? null : fileOhlcProvider(o), lastPriceProvider: p === null ? null : fileLastPriceProvider(p) };
}
/** Resolves the quote / option-quote / option-chain provider settings (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveQuoteProviders(rules: AgentRulesConfig): { quoteProvider: QuoteProvider | null; optionsQuoteProvider: OptionsQuoteProvider | null; optionsChainProvider: OptionsChainProvider | null } {
  const q = fileSource(rules.quotes.source, "quote provider"), o = fileSource(rules.quotes.optionSource, "option quote provider"), c = fileSource(rules.quotes.chainSource, "option chain provider");
  return { quoteProvider: q === null ? null : fileQuoteProvider(q), optionsQuoteProvider: o === null ? null : fileOptionsQuoteProvider(o), optionsChainProvider: c === null ? null : fileOptionsChainProvider(c) };
}
/** Resolves the historical pattern / outcome provider settings (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveHistoricalProviders(rules: AgentRulesConfig): { historicalPatternProvider: HistoricalPatternProvider | null; historicalOutcomeProvider: HistoricalOutcomeProvider | null } {
  const p = fileSource(rules.historical.patternSource, "historical pattern provider"), o = fileSource(rules.historical.outcomeSource, "historical outcome provider");
  return { historicalPatternProvider: p === null ? null : filePatternProvider(p), historicalOutcomeProvider: o === null ? null : fileOutcomeProvider(o) };
}
