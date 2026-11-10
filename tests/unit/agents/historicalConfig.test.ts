import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProductionRegistry, DEFAULT_AGENT_RULES, DEFAULT_REQUIRED_AGENTS, fileOutcomeProvider, filePatternProvider, HISTORICAL_OUTCOMES_FORMAT, HISTORICAL_PATTERNS_FORMAT, loadAgentRulesConfig, outcomeProblem, patternProblem,
  PRODUCTION_AGENT_IDS, resolveHistoricalProviders, type AgentContractError,
} from "../../../packages/agents/src/index";
import { KEY4, outcome, pattern } from "../../support/agentHistoryFixtures";

type Rec = Record<string, ReturnType<typeof JSON.parse>>;
const tmp = (name: string, body: unknown): string => { const d = mkdtempSync(join(tmpdir(), "twins-hist-")); const p = join(d, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const patternsFile = () => ({ format: HISTORICAL_PATTERNS_FORMAT, source: "synthetic", as_of: "2025-01-01T00:00:00Z", patterns: { [KEY4]: { level: 4, status: "SUFFICIENT", sample_size: 120, as_of: "2025-01-01T00:00:00Z", first_observed: "2022-01-01T00:00:00Z", last_observed: "2024-12-01T00:00:00+05:30",
  regime_mix: { TRENDING: 0.6, RANGE: 0.4 }, volatility_mix: { LOW: 0.2, NORMAL: 0.6, HIGH: 0.2 } } } });
const outcomesFile = () => ({ format: HISTORICAL_OUTCOMES_FORMAT, source: "synthetic", as_of: "2025-01-01T00:00:00Z", outcomes: { [KEY4]: { evaluable: 120, entered: 100, wins: 65, losses: 35, no_entry: 15, expired_after_entry: 0, unverifiable: 10, net_expectancy_r: 0.3, net_expectancy_lower_bound_r: 0.1, average_winner_r: 1.5, average_loser_r: -1, as_of: "2025-01-01T00:00:00Z" } } });
const err = (code: string) => expect.objectContaining({ code }) as AgentContractError;

describe("historical files", () => {
  it("parse valid files and return the requested patterns and outcomes", async () => {
    const p = filePatternProvider(tmp("p.json", patternsFile()));
    expect(p).toMatchObject({ name: "file:synthetic", asOf: "2025-01-01T00:00:00.000Z" });
    expect(await p.patterns({ keys: [KEY4] })).toEqual([{ keyText: KEY4, level: 4, status: "SUFFICIENT", sampleSize: 120, asOf: "2025-01-01T00:00:00.000Z", firstObserved: "2022-01-01T00:00:00.000Z", lastObserved: "2024-11-30T18:30:00.000Z", regimeMix: { TRENDING: 0.6, RANGE: 0.4 }, volatilityMix: { LOW: 0.2, NORMAL: 0.6, HIGH: 0.2 } }]);
    expect(await p.patterns({ keys: ["L1|market=NSE"] })).toEqual([]);
    const o = fileOutcomeProvider(tmp("o.json", outcomesFile()));
    expect(await o.outcomes({ keyText: KEY4 })).toMatchObject({ keyText: KEY4, evaluable: 120, entered: 100, noEntry: 15, netExpectancyLowerBoundR: 0.1, averageLoserR: -1, asOf: "2025-01-01T00:00:00.000Z" });
    expect(await o.outcomes({ keyText: "L1|market=NSE" })).toBeNull();
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["no patterns", (b) => { b["patterns"] = {}; }], ["a bad key", (b) => { b["patterns"]["bad key"] = b["patterns"][KEY4]; }],
    ["a bad status", (b) => { b["patterns"][KEY4].status = "GREAT"; }], ["a fractional sample", (b) => { b["patterns"][KEY4].sample_size = 1.5; }], ["a level that contradicts the key", (b) => { b["patterns"][KEY4].level = 2; }],
    ["a mix that does not sum to 1", (b) => { b["patterns"][KEY4].regime_mix = { TRENDING: 0.5, RANGE: 0.1 }; }], ["an unknown volatility tag", (b) => { b["patterns"][KEY4].volatility_mix = { WILD: 1 }; }],
    ["a time without an offset", (b) => { b["patterns"][KEY4].as_of = "2025-01-01T00:00:00"; }], ["a bad last_observed", (b) => { b["patterns"][KEY4].last_observed = "soon"; }],
  ])("a patterns file with %s is refused at load", (_n, mutate) => { const b = patternsFile() as Rec; mutate(b); expect(() => filePatternProvider(tmp("p.json", b))).toThrowError(err("INVALID_HISTORICAL_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["counts that do not add up", (b) => { b["outcomes"][KEY4].wins = 90; }], ["a negative count", (b) => { b["outcomes"][KEY4].unverifiable = -1; }], ["more entered than evaluable", (b) => { b["outcomes"][KEY4].no_entry = 50; }],
    ["an expectancy beyond 100R", (b) => { b["outcomes"][KEY4].net_expectancy_r = 500; }], ["no time", (b) => { delete b["outcomes"][KEY4].as_of; }], ["a wrong format", (b) => { b["format"] = HISTORICAL_PATTERNS_FORMAT; }],
  ])("an outcomes file with %s is refused at load", (_n, mutate) => { const b = outcomesFile() as Rec; mutate(b); expect(() => fileOutcomeProvider(tmp("o.json", b))).toThrowError(err("INVALID_HISTORICAL_DATA")); });
  it("the problem checks accept clean data and name the first problem", () => {
    expect(patternProblem(pattern())).toBeNull(); expect(patternProblem({ ...pattern(), sampleSize: -1 })).toBe("status / sample"); expect(patternProblem(null)).toBe("not an object");
    expect(outcomeProblem(outcome())).toBeNull(); expect(outcomeProblem({ ...outcome(), wins: 1 })).toBe("count consistency"); expect(outcomeProblem({ ...outcome(), averageWinnerR: Number.POSITIVE_INFINITY })).toBe("expectancy");
  });
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files; resolveHistoricalProviders resolves none / file and throws on a bad file", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-hist-"));
    writeFileSync(join(d, "bad.json"), "{nope"); writeFileSync(join(d, "x.csv"), "a,b"); writeFileSync(join(d, "id_rsa.json"), JSON.stringify(patternsFile()));
    symlinkSync(tmp("ok.json", patternsFile()), join(d, "link.json"));
    for (const p of ["bad.json", "x.csv", "id_rsa.json", "link.json", "missing.json"].map((f) => join(d, f))) { expect(() => filePatternProvider(p), p).toThrow(); expect(() => fileOutcomeProvider(p), p).toThrow(); }
    expect(resolveHistoricalProviders(DEFAULT_AGENT_RULES)).toEqual({ historicalPatternProvider: null, historicalOutcomeProvider: null });
    const r = resolveHistoricalProviders(loadAgentRulesConfig({ TWINS_AGENT_HISTORICAL_PATTERN_PROVIDER: `file:${tmp("p.json", patternsFile())}`, TWINS_AGENT_HISTORICAL_OUTCOME_PROVIDER: `file:${tmp("o.json", outcomesFile())}` }));
    expect([r.historicalPatternProvider?.name, r.historicalOutcomeProvider?.name]).toEqual(["file:synthetic", "file:synthetic"]);
    expect(() => resolveHistoricalProviders(loadAgentRulesConfig({ TWINS_AGENT_HISTORICAL_PATTERN_PROVIDER: `file:${tmp("bad.json", "{")}` }))).toThrow();
  });
});

describe("rule configuration for the historical-pattern and challenger agents", () => {
  it("defaults are conservative", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.historical).toMatchObject({ patternSource: "none", outcomeSource: "none", minSample: 30, staleCautionDays: 30, unavailableDays: 120, criticalSeverity: "ADVERSE", criticalMinSample: 100, minLevelForSupport: 2, wilsonZ: 1.96 });
    expect(DEFAULT_AGENT_RULES.challenger).toMatchObject({ minRewardRisk: 1, adverseRewardRisk: 0.5, criticalSeverity: "BLOCKING", incoherenceSeverity: "BLOCKING", criticalSupportive: 2, criticalAdverse: 2, supportMinAgents: 3 });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_HISTORICAL_PATTERN_PROVIDER: "file:/d/p.json", TWINS_AGENT_HISTORICAL_OUTCOME_PROVIDER: "file:/d/o.json", TWINS_AGENT_HIST_MIN_SAMPLE: "50", TWINS_AGENT_HIST_STALE_CAUTION_DAYS: "20", TWINS_AGENT_HIST_STALE_UNAVAILABLE_DAYS: "60",
      TWINS_AGENT_HIST_LAST_OBSERVED_MAX_DAYS: "200", TWINS_AGENT_HIST_FUTURE_TOLERANCE_MINUTES: "2", TWINS_AGENT_HIST_WILSON_Z: "1.64", TWINS_AGENT_HIST_WIN_LOWER_SUPPORTIVE: "0.55", TWINS_AGENT_HIST_WIN_UPPER_CAUTION: "0.45",
      TWINS_AGENT_HIST_WIN_UPPER_ADVERSE: "0.3", TWINS_AGENT_HIST_EXPECTANCY_LOWER_SUPPORTIVE_R: "0.05", TWINS_AGENT_HIST_EXPECTANCY_CAUTION_R: "0.02", TWINS_AGENT_HIST_EXPECTANCY_ADVERSE_R: "-0.2", TWINS_AGENT_HIST_MAX_UNVERIFIABLE_RATE: "0.3",
      TWINS_AGENT_HIST_CRITICAL_WIN_UPPER: "0.15", TWINS_AGENT_HIST_CRITICAL_EXPECTANCY_R: "-0.4", TWINS_AGENT_HIST_CRITICAL_MIN_SAMPLE: "200", TWINS_AGENT_HIST_CRITICAL_SEVERITY: "BLOCKING", TWINS_AGENT_HIST_MIN_REGIME_SHARE: "0.25",
      TWINS_AGENT_HIST_MIN_VOLATILITY_SHARE: "0.15", TWINS_AGENT_HIST_MIN_LEVEL_FOR_SUPPORT: "3", TWINS_AGENT_HIST_REGIME_LOOKBACK: "20", TWINS_AGENT_HIST_REGIME_EFFICIENCY: "0.3", TWINS_AGENT_HIST_ATR_PERIOD: "10",
      TWINS_AGENT_HIST_VOLATILITY_LOW_PCT: "0.4", TWINS_AGENT_HIST_VOLATILITY_HIGH_PCT: "2",
      TWINS_AGENT_CHAL_MIN_REWARD_RISK: "1.5", TWINS_AGENT_CHAL_ADVERSE_REWARD_RISK: "0.8", TWINS_AGENT_CHAL_STOP_RISK_TOLERANCE_PTS: "2", TWINS_AGENT_CHAL_ADVERSE_SHARE_CAUTION: "0.2", TWINS_AGENT_CHAL_ADVERSE_SHARE_ADVERSE: "0.4",
      TWINS_AGENT_CHAL_DATA_QUALITY_CAUTION: "2", TWINS_AGENT_CHAL_DATA_QUALITY_ADVERSE: "5", TWINS_AGENT_CHAL_THIN_EVIDENCE_SHARE: "0.6", TWINS_AGENT_CHAL_OVERCONFIDENCE_SCORE: "60", TWINS_AGENT_CHAL_OVERCONFIDENCE_ADVERSE_SHARE: "0.3",
      TWINS_AGENT_CHAL_CRITICAL_SUPPORTIVE: "3", TWINS_AGENT_CHAL_CRITICAL_ADVERSE: "3", TWINS_AGENT_CHAL_CRITICAL_CONFIDENCE: "70", TWINS_AGENT_CHAL_SUPPORT_MIN_AGENTS: "4", TWINS_AGENT_CHAL_SUPPORT_SHARE: "0.6",
      TWINS_AGENT_CHAL_CRITICAL_SEVERITY: "ADVERSE", TWINS_AGENT_CHAL_INCOHERENCE_SEVERITY: "ADVERSE",
    });
    expect(c.historical).toEqual({ patternSource: "file:/d/p.json", outcomeSource: "file:/d/o.json", minSample: 50, staleCautionDays: 20, unavailableDays: 60, lastObservedMaxDays: 200, futureToleranceMinutes: 2, wilsonZ: 1.64, winLowerSupportive: 0.55,
      winUpperCaution: 0.45, winUpperAdverse: 0.3, expectancyLowerSupportiveR: 0.05, expectancyCautionR: 0.02, expectancyAdverseR: -0.2, maxUnverifiableRate: 0.3, criticalWinUpper: 0.15, criticalExpectancyR: -0.4, criticalMinSample: 200,
      criticalSeverity: "BLOCKING", minRegimeShare: 0.25, minVolatilityShare: 0.15, minLevelForSupport: 3, regimeLookback: 20, regimeEfficiency: 0.3, atrPeriod: 10, volatilityLowPct: 0.4, volatilityHighPct: 2 });
    expect(c.challenger).toEqual({ minRewardRisk: 1.5, adverseRewardRisk: 0.8, stopRiskTolerancePts: 2, adverseShareCaution: 0.2, adverseShareAdverse: 0.4, dataQualityCaution: 2, dataQualityAdverse: 5, thinEvidenceShare: 0.6, overconfidenceScore: 60,
      overconfidenceAdverseShare: 0.3, criticalSupportive: 3, criticalAdverse: 3, criticalConfidence: 70, supportMinAgents: 4, supportShare: 0.6, criticalSeverity: "ADVERSE", incoherenceSeverity: "ADVERSE" });
  });
  it.each<[string, Record<string, string>]>([
    ["a bad provider source", { TWINS_AGENT_HISTORICAL_PATTERN_PROVIDER: "https://x" }], ["stale caution at the unavailable limit", { TWINS_AGENT_HIST_STALE_CAUTION_DAYS: "120" }], ["a zero minimum sample", { TWINS_AGENT_HIST_MIN_SAMPLE: "0" }],
    ["a critical sample below the minimum", { TWINS_AGENT_HIST_CRITICAL_MIN_SAMPLE: "10" }], ["an adverse win-rate limit above the caution one", { TWINS_AGENT_HIST_WIN_UPPER_ADVERSE: "0.6" }], ["a critical win-rate limit above the adverse one", { TWINS_AGENT_HIST_CRITICAL_WIN_UPPER: "0.4" }],
    ["an adverse expectancy above the caution one", { TWINS_AGENT_HIST_EXPECTANCY_ADVERSE_R: "0.5" }], ["a critical expectancy above the adverse one", { TWINS_AGENT_HIST_CRITICAL_EXPECTANCY_R: "-0.05" }], ["a level beyond 4", { TWINS_AGENT_HIST_MIN_LEVEL_FOR_SUPPORT: "5" }],
    ["non-increasing volatility buckets", { TWINS_AGENT_HIST_VOLATILITY_LOW_PCT: "3" }], ["a bad severity", { TWINS_AGENT_HIST_CRITICAL_SEVERITY: "CAUTION" }], ["a non-numeric value", { TWINS_AGENT_HIST_WILSON_Z: "many" }],
    ["an adverse reward/risk not below the minimum", { TWINS_AGENT_CHAL_ADVERSE_REWARD_RISK: "1.5" }], ["non-increasing adverse shares", { TWINS_AGENT_CHAL_ADVERSE_SHARE_CAUTION: "0.7" }], ["non-increasing data-quality counts", { TWINS_AGENT_CHAL_DATA_QUALITY_CAUTION: "9" }],
    ["a bad challenger severity", { TWINS_AGENT_CHAL_INCOHERENCE_SEVERITY: "INFO" }], ["a zero critical count", { TWINS_AGENT_CHAL_CRITICAL_ADVERSE: "0" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("registration, worker wiring and source hygiene", () => {
  it("the thirteen production agents include the two new ones and the market-context agent, the challenger depends on all the others, and the required set is explicit", () => {
    expect([...PRODUCTION_AGENT_IDS].slice(-3)).toEqual(["historical-pattern-v1", "market-context-v1", "independent-challenger-v1"]);
    const snap = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).snapshot();
    expect(snap).toHaveLength(13);
    const ch = snap.find((x) => x.agentId === "independent-challenger-v1");
    // every other agent is an ordering dependency of the challenger; the one OPTIONAL agent (market-context, no provider yet) is SOFT: the challenger runs after it and reads it when COMPLETED, but is not skipped without it
    expect(ch?.dependsOn).toHaveLength(11); expect(ch?.dependsOn).not.toContain("independent-challenger-v1"); expect(ch?.dependsOn).toContain("historical-pattern-v1"); expect(ch?.dependsOn).not.toContain("market-context-v1");
    expect(ch?.softDependsOn).toEqual(["market-context-v1"]); expect([...(ch?.dependsOn ?? []), ...(ch?.softDependsOn ?? [])]).toHaveLength(12);
    expect([...DEFAULT_REQUIRED_AGENTS]).toHaveLength(12);
  });
  it("the worker resolves the historical providers only when the engine is enabled", () => {
    expect(readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8")).toMatch(/\.\.\.resolveHistoricalProviders\(agentRules\) \}\)\) : null;/);
  });
  it("the new agent and provider sources read no message text, import no network / broker / LLM code, read no system clock and write nothing", () => {
    for (const f of ["historicalPattern.ts", "independentChallenger.ts", "historicalProviders.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(|schema\./i);
    }
  });
});
