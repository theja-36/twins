import { patternKeys, type Features } from "@twins/historical";
import {
  DEFAULT_AGENT_RULES, memoryOutcomeProvider, memoryPatternProvider, type AgentRulesConfig, type HistoricalOutcomeProvider, type HistoricalPatternProvider, type OutcomeDistribution, type PatternMatch,
} from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";
import { at } from "./calendarMacroFixtures";
import { fromCloses } from "./ohlcFixtures";

/** SYNTHETIC historical fixtures at NOW (2025-01-06T04:05Z): an equity BUY of ACME, a pattern library 5 days old with 120 evaluated outcomes. */
export const FEATURES: Features = {
  market: "NSE", instrumentType: "EQUITY", underlying: "ACME", optionType: "NA", side: "BUY", timeOfDay: "OPENING", dayOfWeek: "MON", expiryProximity: "NA", entryType: "level", stopDistance: "5_10PCT", rewardRisk: "1_2", targetStructure: "T1_T2_T3",
};
export const keysOf = (f: Features = FEATURES) => patternKeys(f).map((k) => k.keyText);
export const KEY4 = keysOf()[3] as string;
const daysAgo = (d: number): string => at(-d * 1440);
export const pattern = (o: Partial<PatternMatch> = {}): PatternMatch => ({
  keyText: KEY4, level: 4, status: "SUFFICIENT", sampleSize: 120, asOf: daysAgo(5), firstObserved: daysAgo(900), lastObserved: daysAgo(40), regimeMix: { TRENDING: 0.6, RANGE: 0.4 }, volatilityMix: { LOW: 0.2, NORMAL: 0.6, HIGH: 0.2 }, ...o,
});
export const outcome = (o: Partial<OutcomeDistribution> = {}): OutcomeDistribution => ({
  keyText: KEY4, evaluable: 120, entered: 100, wins: 65, losses: 35, noEntry: 15, expiredAfterEntry: 0, unverifiable: 10, netExpectancyR: 0.3, netExpectancyLowerBoundR: 0.1, averageWinnerR: 1.5, averageLoserR: -1, asOf: daysAgo(5), ...o,
});
export const patterns = (p: PatternMatch[] = [pattern()], name = "synthetic-patterns"): HistoricalPatternProvider => memoryPatternProvider({ name, asOf: daysAgo(5), patterns: p });
export const outcomes = (m: Record<string, OutcomeDistribution> = { [KEY4]: outcome() }): HistoricalOutcomeProvider => memoryOutcomeProvider({ name: "synthetic-outcomes", outcomes: m });
/** 70 daily bars rising one point a day: a TRENDING regime and a NORMAL (about 1.2%) average true range. */
export const trendingBars = () => fromCloses(Array.from({ length: 70 }, (_, i) => 100 + i));
export const rulesWithHistory = (over: { historical?: Partial<AgentRulesConfig["historical"]>; challenger?: Partial<AgentRulesConfig["challenger"]> } = {}): AgentRulesConfig => ({
  ...DEFAULT_AGENT_RULES, historical: { ...DEFAULT_AGENT_RULES.historical, ...over.historical }, challenger: { ...DEFAULT_AGENT_RULES.challenger, ...over.challenger },
});
export { NOW, at };
