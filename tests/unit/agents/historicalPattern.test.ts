import { describe, expect, it } from "vitest";
import {
  historicalPatternAgent, HISTORICAL_PATTERN_AGENT_ID, type AgentRulesConfig, type HistoricalOutcomeProvider, type HistoricalPatternProvider, type LastPriceProvider, type OhlcProvider, type OutcomeDistribution, type PatternMatch,
} from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW } from "../../support/agentFixtures";
import { FEATURES, keysOf, KEY4, outcome, outcomes, pattern, patterns, rulesWithHistory, trendingBars, at } from "../../support/agentHistoryFixtures";
import { ohlc, quiet } from "../../support/ohlcFixtures";

interface Opt { rules?: AgentRulesConfig; patterns?: HistoricalPatternProvider | null; outcomes?: HistoricalOutcomeProvider | null; ohlc?: OhlcProvider | null; price?: LastPriceProvider | null; inp?: Record<string, unknown> }
const inp0 = (sf: Record<string, unknown> = {}) => inputs({ sf: { ...FEATURES, ...sf } });
const run = async (o: Opt = {}) =>
  (await evalAgents([historicalPatternAgent(o.rules ?? rulesWithHistory(), o.patterns === undefined ? patterns() : o.patterns, o.outcomes === undefined ? outcomes() : o.outcomes, o.ohlc === undefined ? ohlc(trendingBars(), { symbol: "ACME" }) : o.ohlc, o.price ?? null)], o.inp ?? inp0(), {}, [], NOW)).byId(HISTORICAL_PATTERN_AGENT_ID);
const withOutcome = (o: Partial<OutcomeDistribution>) => ({ outcomes: outcomes({ [KEY4]: outcome(o) }) });

describe("Historical Pattern Agent: assessment", () => {
  it("supportive historical evidence = SUPPORTIVE with the distribution summarised", async () => {
    const r = await run();
    expect(r).toMatchObject({ agentId: "historical-pattern-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(r.outputSnapshot).toMatchObject({ patternProvider: "synthetic-patterns", outcomeProvider: "synthetic-outcomes", patternKey: KEY4, patternLevel: 4, evidenceStatus: "SUFFICIENT", sampleSize: 120, entered: 100, wins: 65, losses: 35, winRate: 0.65,
      netExpectancyR: 0.3, netExpectancyLowerBoundR: 0.1, payoffRatio: 1.5, currentRegime: "TRENDING", currentVolatility: "NORMAL", regimeShare: 0.6, volatilityShare: 0.6, supportiveMeasures: 2, dataAgeDays: 5, matchedLevels: "4", failedCodes: [] });
    expect(r.outputSnapshot["winRateLower"]).toBeGreaterThan(0.5);
    expect(codesOf(r)).toEqual(expect.arrayContaining(["WIN_RATE_SUPPORTIVE", "EXPECTANCY_SUPPORTIVE", "PAYOFF_RATIO"]));
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "historical_pattern"]));
  });
  it("strong adverse historical evidence = ADVERSE (the win-rate upper bound below 35% with a non-positive expectancy)", async () => {
    const r = await run(withOutcome({ wins: 15, losses: 85, netExpectancyR: -0.3, netExpectancyLowerBoundR: -0.45 }));
    expect(r.verdict).toBe("ADVERSE"); expect(codesOf(r)).toEqual(expect.arrayContaining(["WIN_RATE_ADVERSE", "EXPECTANCY_NEGATIVE"]));
  });
  it("a critical adverse pattern = ADVERSE by default and BLOCKING when configured; the sample must be large enough", async () => {
    const crit = withOutcome({ wins: 8, losses: 92, netExpectancyR: -0.5, netExpectancyLowerBoundR: -0.7 });
    const a = await run(crit); expect(a.verdict).toBe("ADVERSE"); expect(codesOf(a)).toContain("HISTORICAL_CRITICAL_ADVERSE");
    expect((await run({ ...crit, rules: rulesWithHistory({ historical: { criticalSeverity: "BLOCKING" } }) })).verdict).toBe("BLOCKING");
    const small = await run({ patterns: patterns([pattern({ sampleSize: 60 })]), outcomes: outcomes({ [KEY4]: outcome({ evaluable: 60, entered: 50, wins: 4, losses: 46, noEntry: 5, unverifiable: 3, netExpectancyR: -0.5 }) }) });
    expect(codesOf(small)).not.toContain("HISTORICAL_CRITICAL_ADVERSE"); expect(small.verdict).toBe("ADVERSE"); // only the ordinary adverse rules apply below the critical sample
  });
  it("mixed evidence: a good win rate with a non-positive expectancy = CAUTION; a win rate below even = CAUTION; one supportive measure = NEUTRAL", async () => {
    const a = await run(withOutcome({ netExpectancyR: -0.05, netExpectancyLowerBoundR: -0.2 })); expect(a.verdict).toBe("CAUTION"); expect(codesOf(a)).toContain("EXPECTANCY_NOT_POSITIVE");
    const b = await run(withOutcome({ wins: 40, losses: 60, netExpectancyR: 0.2, netExpectancyLowerBoundR: 0.05 })); expect(b.verdict).toBe("CAUTION"); expect(codesOf(b)).toContain("WIN_RATE_BELOW_EVEN");
    const c = await run(withOutcome({ wins: 45, losses: 55, netExpectancyR: 0.2, netExpectancyLowerBoundR: 0.05 })); expect(c).toMatchObject({ verdict: "NEUTRAL", confidence: 70 }); expect(codesOf(c)).toContain("WIN_RATE_UNDETERMINED");
    expect((await run(withOutcome({ netExpectancyR: null, netExpectancyLowerBoundR: null }))).verdict).toBe("CAUTION");
  });
  it("outcome distribution edge cases: all wins, no wins, no entered outcomes, expired-only", async () => {
    expect((await run(withOutcome({ wins: 100, losses: 0 }))).verdict).toBe("SUPPORTIVE");
    const none = await run(withOutcome({ wins: 0, losses: 100, netExpectancyR: -0.2, netExpectancyLowerBoundR: -0.3 })); expect(none.verdict).toBe("ADVERSE");
    expect(await run(withOutcome({ entered: 0, wins: 0, losses: 0, noEntry: 100, evaluable: 100 }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "INSUFFICIENT_SAMPLE" });
    const expired = await run(withOutcome({ wins: 50, losses: 30, expiredAfterEntry: 20 })); expect(expired.outputSnapshot).toMatchObject({ entered: 100, wins: 50, losses: 30 });
    expect((await run(withOutcome({ averageWinnerR: null, averageLoserR: null }))).outputSnapshot["payoffRatio"]).toBeUndefined();
  });
  it("many unverifiable outcomes and a low-quality pattern = CAUTION; a pattern not recently observed = CAUTION", async () => {
    const u = await run(withOutcome({ unverifiable: 200 })); expect(u.verdict).toBe("CAUTION"); expect(codesOf(u)).toContain("UNVERIFIABLE_SHARE_HIGH");
    const q = await run({ patterns: patterns([pattern({ status: "LOW_QUALITY_EVIDENCE" })]) }); expect(q.verdict).toBe("CAUTION"); expect(codesOf(q)).toContain("LOW_QUALITY_EVIDENCE");
    const old = await run({ patterns: patterns([pattern({ lastObserved: at(-400 * 1440) })]) }); expect(codesOf(old)).toContain("PATTERN_NOT_RECENT");
  });
  it("uses the deepest sufficient level and falls back when it is insufficient; a broad-only match is never SUPPORTIVE", async () => {
    const ks = keysOf();
    const l3 = pattern({ keyText: ks[2] as string, level: 3 });
    const both = await run({ patterns: patterns([pattern({ sampleSize: 10, status: "INSUFFICIENT_EVIDENCE" }), l3]), outcomes: outcomes({ [ks[2] as string]: outcome({ keyText: ks[2] as string }) }) });
    expect(both.outputSnapshot).toMatchObject({ patternLevel: 3, matchedLevels: "3,4" }); expect(both.verdict).toBe("SUPPORTIVE");
    const l1 = await run({ patterns: patterns([pattern({ keyText: ks[0] as string, level: 1 })]), outcomes: outcomes({ [ks[0] as string]: outcome({ keyText: ks[0] as string }) }) });
    expect(l1).toMatchObject({ verdict: "NEUTRAL", confidence: 70 }); expect(codesOf(l1)).toContain("PATTERN_BROAD");
    expect((await run({ patterns: patterns([pattern({ keyText: ks[0] as string, level: 1 })]), outcomes: outcomes({ [ks[0] as string]: outcome({ keyText: ks[0] as string }) }), rules: rulesWithHistory({ historical: { minLevelForSupport: 1 } }) })).verdict).toBe("SUPPORTIVE");
  });
});

describe("Historical Pattern Agent: regime and volatility similarity", () => {
  it("a regime that was rare in the historical sample = CAUTION (REGIME_MISMATCH)", async () => {
    const r = await run({ ohlc: ohlc(quiet(70, 100), { symbol: "ACME" }), patterns: patterns([pattern({ regimeMix: { TRENDING: 0.95, RANGE: 0.05 }, volatilityMix: { LOW: 0.1, NORMAL: 0.2, HIGH: 0.7 } })]) });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("REGIME_MISMATCH"); expect(r.outputSnapshot).toMatchObject({ currentRegime: "RANGE", currentVolatility: "HIGH", regimeShare: 0.05 });
  });
  it("a volatility bucket that was rare in the historical sample = CAUTION (VOLATILITY_MISMATCH)", async () => {
    const r = await run({ patterns: patterns([pattern({ volatilityMix: { LOW: 0.5, NORMAL: 0.1, HIGH: 0.4 } })]) });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("VOLATILITY_MISMATCH"); expect(codesOf(r)).not.toContain("REGIME_MISMATCH");
  });
  it("conditions that cannot be compared (no OHLC provider, a failing one, or no recorded mix) keep the evidence out of SUPPORTIVE", async () => {
    const none = await run({ ohlc: null }); expect(none).toMatchObject({ verdict: "NEUTRAL", confidence: 70 }); expect(codesOf(none)).toContain("CONDITIONS_NOT_COMPARED");
    const failing = await run({ ohlc: { name: "x", asOf: null, candles: async () => { throw new Error("SECRET-DETAIL"); } } }); expect(failing.verdict).not.toBe("SUPPORTIVE"); expect(codesOf(failing)).toContain("CONDITIONS_NOT_COMPARED"); expect(JSON.stringify(failing)).not.toContain("SECRET-DETAIL");
    const nomix = await run({ patterns: patterns([pattern({ regimeMix: null, volatilityMix: null })]) }); expect(nomix.verdict).toBe("NEUTRAL"); expect(codesOf(nomix)).toContain("CONDITIONS_NOT_RECORDED");
  });
  it("the thresholds are configurable", async () => {
    const r = await run({ ohlc: ohlc(quiet(70, 100), { symbol: "ACME" }), patterns: patterns([pattern({ regimeMix: { TRENDING: 0.95, RANGE: 0.05 }, volatilityMix: { LOW: 0.1, NORMAL: 0.2, HIGH: 0.7 } })]), rules: rulesWithHistory({ historical: { minRegimeShare: 0.04 } }) });
    expect(codesOf(r)).not.toContain("REGIME_MISMATCH"); expect(r.verdict).toBe("SUPPORTIVE");
  });
});

describe("Historical Pattern Agent: sample size and staleness", () => {
  it("fewer evaluated outcomes than the minimum, or only insufficient patterns, = UNAVAILABLE (never a pass)", async () => {
    expect(await run({ patterns: patterns([pattern({ sampleSize: 10 })]) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "INSUFFICIENT_SAMPLE" });
    expect(await run({ patterns: patterns([pattern({ status: "INSUFFICIENT_EVIDENCE" })]) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "INSUFFICIENT_SAMPLE" });
    expect(await run(withOutcome({ evaluable: 25, entered: 20, wins: 12, losses: 8, noEntry: 5, unverifiable: 2 }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "INSUFFICIENT_SAMPLE" });
    expect((await run({ rules: rulesWithHistory({ historical: { minSample: 10, criticalMinSample: 10 } }), patterns: patterns([pattern({ sampleSize: 12 })]), ...withOutcome({ evaluable: 12, entered: 10, wins: 7, losses: 3, noEntry: 2, unverifiable: 0 }) })).status).toBe("COMPLETED");
  });
  it("data older than the caution limit = CAUTION; older than the unavailable limit or dated in the future = UNAVAILABLE; the older of pattern and outcome decides", async () => {
    const stale = await run({ patterns: patterns([pattern({ asOf: at(-40 * 1440) })]) }); expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("HISTORICAL_DATA_STALE");
    expect(codesOf(await run(withOutcome({ asOf: at(-40 * 1440) })))).toContain("HISTORICAL_DATA_STALE");
    expect(await run({ patterns: patterns([pattern({ asOf: at(-200 * 1440) })]) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "HISTORICAL_DATA_TOO_OLD" });
    expect(await run({ patterns: patterns([pattern({ asOf: at(60) })]) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "HISTORICAL_DATA_FROM_FUTURE" });
    expect((await run({ patterns: patterns([pattern({ asOf: at(-40 * 1440) })]), rules: rulesWithHistory({ historical: { staleCautionDays: 60 } }) })).verdict).toBe("SUPPORTIVE");
  });
});

describe("Historical Pattern Agent: missing / failing / malformed data => UNAVAILABLE, never a pass", () => {
  const bad = (o: Partial<PatternMatch>) => patterns([{ ...pattern(), ...o } as PatternMatch]);
  it.each([
    ["no pattern provider", { patterns: null }, "PATTERN_PROVIDER_NOT_CONFIGURED"],
    ["no outcome provider", { outcomes: null }, "OUTCOME_PROVIDER_NOT_CONFIGURED"],
    ["a pattern provider that throws", { patterns: { name: "x", asOf: null, patterns: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "PATTERN_PROVIDER_UNAVAILABLE"],
    ["an outcome provider that throws", { outcomes: { name: "x", outcomes: async () => { throw new Error("SECRET-DETAIL"); } } }, "OUTCOME_PROVIDER_UNAVAILABLE"],
    ["no matching pattern", { patterns: patterns([]) }, "NO_MATCHING_PATTERN"],
    ["no outcomes for the pattern", { outcomes: outcomes({}) }, "OUTCOME_DATA_NOT_AVAILABLE"],
    ["a pattern provider that returns a non-list", { patterns: { name: "x", asOf: null, patterns: async () => "garbage" as never } }, "PATTERN_DATA_MALFORMED"],
    ["a pattern with a bad status", { patterns: bad({ status: "GREAT" as never }) }, "PATTERN_DATA_MALFORMED"],
    ["a pattern with a negative sample", { patterns: bad({ sampleSize: -1 }) }, "PATTERN_DATA_MALFORMED"],
    ["a pattern whose level contradicts its key", { patterns: bad({ level: 3 }) }, "PATTERN_DATA_MALFORMED"],
    ["a pattern that was not requested", { patterns: { name: "x", asOf: null, patterns: async () => [{ ...pattern(), keyText: "L4|market=NSE|instrumentType=EQUITY|side=BUY|underlying=OTHER" }] } }, "PATTERN_DATA_MALFORMED"],
    ["a regime mix that does not sum to 1", { patterns: bad({ regimeMix: { TRENDING: 0.9, RANGE: 0.5 } }) }, "PATTERN_DATA_MALFORMED"],
    ["an unknown regime tag", { patterns: bad({ regimeMix: { SIDEWAYS: 1 } }) }, "PATTERN_DATA_MALFORMED"],
    ["duplicate patterns", { patterns: patterns([pattern(), pattern()]) }, "PATTERN_DATA_MALFORMED"],
    ["outcome counts that do not add up", { outcomes: outcomes({ [KEY4]: outcome({ wins: 90, losses: 35 }) }) }, "OUTCOME_DATA_MALFORMED"],
    ["more entered than evaluable", { outcomes: outcomes({ [KEY4]: outcome({ entered: 100, noEntry: 50 }) }) }, "OUTCOME_DATA_MALFORMED"],
    ["an outcome for another pattern", { outcomes: outcomes({ [KEY4]: outcome({ keyText: keysOf()[2] as string }) }) }, "OUTCOME_DATA_MALFORMED"],
    ["a non-finite expectancy", { outcomes: outcomes({ [KEY4]: outcome({ netExpectancyR: Number.NaN }) }) }, "OUTCOME_DATA_MALFORMED"],
  ] as Array<[string, Opt, string]>)("%s", async (_n, o, code) => {
    const r = await run(o);
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("incomplete signal features are UNAVAILABLE", async () => {
    expect(await run({ inp: inputs({ sf: { market: "NSE", side: "BUY" } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "FEATURES_INCOMPLETE" });
    expect(await run({ inp: inp0({ underlying: "UNKNOWN" }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "FEATURES_INCOMPLETE" });
    expect(await run({ inp: inp0({ side: "HOLD" }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "FEATURES_INCOMPLETE" });
  });
});

describe("Historical Pattern Agent: safety", () => {
  it("a SELL looks up its own pattern keys; the source-intelligence status is only recorded", async () => {
    const sell = { ...FEATURES, side: "SELL" };
    const keysSell = keysOf(sell as never);
    const r = await run({ inp: inputs({ sf: sell }), patterns: patterns([pattern({ keyText: keysSell[3] as string })]), outcomes: outcomes({ [keysSell[3] as string]: outcome({ keyText: keysSell[3] as string }) }) });
    expect(r.outputSnapshot["patternKey"]).toContain("side=SELL"); expect(r.outputSnapshot["sourceIntelligenceStatus"]).toBe("VALID");
    expect(await run({ inp: inputs({ sf: sell }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "NO_MATCHING_PATTERN" }); // BUY patterns are never borrowed for a SELL
  });
  it("is deterministic, never mutates the inputs and states evidence only", async () => {
    const inp = inp0(); const before = JSON.stringify(inp);
    const o = withOutcome({ wins: 15, losses: 85, netExpectancyR: -0.3, netExpectancyLowerBoundR: -0.45 });
    const a = await run({ inp, ...o }), b = await run({ inp, ...o });
    expect(JSON.stringify(inp)).toBe(before);
    expect(JSON.stringify({ ...a, startedAt: 0, finishedAt: 0, durationMs: 0 })).toBe(JSON.stringify({ ...b, startedAt: 0, finishedAt: 0, durationMs: 0 }));
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|will|should|buy now|sell now)\b/i);
  });
  it("is a blocking-capable scoring agent with weight 50 and no dependencies", () => {
    expect(historicalPatternAgent(rulesWithHistory(), null, null, null, null).contract).toMatchObject({ agentId: "historical-pattern-v1", canBlock: true, advisoryOnly: false, weight: 50, dependsOn: [], requiredInputs: ["risk_decision", "signal_features"] });
  });
});
