import { DEFAULT_AGENT_RULES, memoryConstituentProvider, memoryMarketData, memoryNewsProvider, memorySentimentProvider, type AgentRulesConfig, type Constituent, type ConstituentProvider, type MarketDataProvider, type NewsItem, type NewsProvider, type SentimentProvider, type SentimentSnapshot } from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";
import { at } from "./calendarMacroFixtures";

/** SYNTHETIC news / sentiment / constituent fixtures for the Task 4 agents (clock: NOW = Monday 2025-01-06 09:35 IST). */
let counter = 0;
export const newsItem = (o: Partial<NewsItem> & { minutesAgo?: number } = {}): NewsItem => {
  counter += 1;
  const { minutesAgo, ...rest } = o;
  return { id: `n-${counter}`, publishedAt: at(-(minutesAgo ?? 30)), sourceLabel: "SynthWire", headline: `Synthetic headline number ${counter}`, symbols: ["ACME"], markets: ["NSE"], sentimentLabel: "POSITIVE", sentimentScore: 0.6, impact: "MEDIUM", category: "company", reference: null, sourceReliability: 0.9, ...rest };
};
export const newsFeed = (items: unknown[] = [], o: { asOf?: string | null } = {}): NewsProvider => memoryNewsProvider({ name: "synthetic-news", asOf: o.asOf === undefined ? at(-5) : o.asOf, items });
export const sentimentFeed = (entries: Record<string, SentimentSnapshot> = {}): SentimentProvider => memorySentimentProvider({ name: "synthetic-sentiment", entries });
export const aggregate = (score: number, o: Partial<SentimentSnapshot> = {}): SentimentSnapshot => ({ score, label: score > 0.2 ? "POSITIVE" : score < -0.2 ? "NEGATIVE" : "NEUTRAL", sampleSize: 20, asOf: at(-10), ...o });

export const SECTORS: Record<string, string> = { AAA: "Financials", BBB: "Financials", CCC: "Technology", DDD: "Financials", EEE: "Technology", FFF: "Energy", GGG: "Energy", HHH: "Autos", III: "Autos", JJJ: "Pharma", KKK: "Pharma", LLL: "Pharma" };
export const WEIGHTS: Record<string, number> = { AAA: 12, BBB: 10, CCC: 8, DDD: 7, EEE: 6, FFF: 5, GGG: 4, HHH: 3, III: 2.5, JJJ: 2, KKK: 1.5, LLL: 1 }; // total 62
export const constituentRow = (symbol: string, o: Partial<Constituent> = {}): Constituent => ({ symbol, index: "NIFTY", weight: WEIGHTS[symbol] ?? 1, sector: SECTORS[symbol] ?? "Other", recentChangePct: 0.5, dataAsOf: at(-5), newsRefs: [], ...o });
export const constituentSet = (o: { index?: string; changes?: Record<string, number | null>; rows?: Constituent[]; asOf?: string } = {}) => ({
  index: o.index ?? "NIFTY", asOf: o.asOf ?? at(-5),
  constituents: o.rows ?? Object.keys(WEIGHTS).map((s) => constituentRow(s, { index: o.index ?? "NIFTY", ...(o.changes && s in o.changes ? { recentChangePct: o.changes[s] ?? null } : {}) })),
});
export const constituents = (set = constituentSet()): ConstituentProvider => memoryConstituentProvider({ name: "synthetic-constituents", sets: [set] });
export const quotes = (changes: Record<string, number>, asOf: string = at(-3)): MarketDataProvider =>
  memoryMarketData({ name: "synthetic-quotes", quotes: Object.fromEntries(Object.entries(changes).map(([s, c]) => [`NSE:${s}`, { changePct1d: c, asOf }])) });
export const allChange = (c: number): Record<string, number> => Object.fromEntries(Object.keys(WEIGHTS).map((s) => [s, c]));
export const rulesWithNews = (over: { news?: Partial<AgentRulesConfig["news"]>; constituent?: Partial<AgentRulesConfig["constituent"]> } = {}): AgentRulesConfig => ({
  ...DEFAULT_AGENT_RULES, news: { ...DEFAULT_AGENT_RULES.news, ...over.news }, constituent: { ...DEFAULT_AGENT_RULES.constituent, ...over.constituent },
});
export { NOW };
