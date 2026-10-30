import {
  DEFAULT_AGENT_RULES, memoryOptionsChainProvider, memoryOptionsQuoteProvider, memoryQuoteProvider, type AgentRulesConfig, type InstrumentQuote, type OptionChain, type OptionQuote, type OptionsChainProvider,
  type OptionsQuoteProvider, type QuoteProvider,
} from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";
import { at } from "./calendarMacroFixtures";

/** SYNTHETIC quote fixtures at NOW (2025-01-06T04:05Z). The equity is ACME, the option NIFTY 24500 CE expiring 2025-01-30 (about 24 days out). */
export const goodQuote = (o: Partial<InstrumentQuote> = {}): InstrumentQuote => ({ bid: 99.95, ask: 100.05, last: 100, volume: 500_000, avgVolume: 1_000_000, openInterest: null, bidDepth: 5000, askDepth: 5000, asOf: at(-1), ...o });
export const quotes = (q: InstrumentQuote, key = "NSE:ACME"): QuoteProvider => memoryQuoteProvider({ name: "synthetic-quotes", quotes: { [key]: q } });
export const goodOption = (o: Partial<OptionQuote> = {}): OptionQuote => ({
  premium: 120, bid: 119, ask: 121, iv: 15, ivPrevious: 14.5, delta: 0.5, gamma: 0.0004, theta: -4, vega: 12, openInterest: 50_000, volume: 20_000, underlyingPrice: 24_500, asOf: at(-1), ...o,
});
export const OPTION_KEY = "NSE:NIFTY:2025-01-30:24500:CE";
export const optionQuotes = (q: OptionQuote, key = OPTION_KEY): OptionsQuoteProvider => memoryOptionsQuoteProvider({ name: "synthetic-option-quotes", quotes: { [key]: q } });
export const goodChain = (o: Partial<OptionChain> = {}): OptionChain => ({
  underlyingPrice: 24_500, asOf: at(-1), rows: [
    { strike: 24_400, optionType: "CE", iv: 15.5, openInterest: 40_000, volume: 9000 }, { strike: 24_500, optionType: "CE", iv: 15, openInterest: 50_000, volume: 20_000 },
    { strike: 24_500, optionType: "PE", iv: 15.2, openInterest: 45_000, volume: 18_000 }, { strike: 24_600, optionType: "CE", iv: 14.8, openInterest: 30_000, volume: 7000 },
  ], ...o,
});
export const chains = (c: OptionChain, key = "NSE:NIFTY:2025-01-30"): OptionsChainProvider => memoryOptionsChainProvider({ name: "synthetic-option-chains", chains: { [key]: c } });
/** An option decision at NOW, optionally with a different expiry (the quote key follows). */
export const rulesWithQuotes = (over: { quotes?: Partial<AgentRulesConfig["quotes"]>; liquidity?: Partial<AgentRulesConfig["liquidity"]>; optionsRisk?: Partial<AgentRulesConfig["optionsRisk"]> } = {}): AgentRulesConfig => ({
  ...DEFAULT_AGENT_RULES, quotes: { ...DEFAULT_AGENT_RULES.quotes, ...over.quotes }, liquidity: { ...DEFAULT_AGENT_RULES.liquidity, ...over.liquidity }, optionsRisk: { ...DEFAULT_AGENT_RULES.optionsRisk, ...over.optionsRisk },
});
export { NOW, at };
