import { describe, expect, it } from "vitest";
import { indexConstituentAgent, INDEX_CONSTITUENT_AGENT_ID, type AgentRulesConfig, type ConstituentProvider, type MarketDataProvider, type NewsProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, NOW } from "../../support/agentFixtures";
import { at } from "../../support/calendarMacroFixtures";
import { allChange, constituentRow, constituents, constituentSet, newsFeed, newsItem, quotes, rulesWithNews } from "../../support/newsConstituentFixtures";

// a NIFTY CE BUY (bullish index exposure)
const NIFTY = (o: Parameters<typeof optionInputs>[0] = {}) => optionInputs({ ...o, rd: { symbol: "NIFTY", optionType: "CE", ...o.rd } });
const run = async (inp: Record<string, unknown> = NIFTY(), o: { rules?: AgentRulesConfig; provider?: ConstituentProvider | null; market?: MarketDataProvider | null; news?: NewsProvider | null } = {}) =>
  (await evalAgents([indexConstituentAgent(o.rules ?? rulesWithNews(), o.provider === undefined ? constituents() : o.provider, o.market === undefined ? null : o.market, o.news === undefined ? null : o.news)], inp, {}, [], NOW)).byId(INDEX_CONSTITUENT_AGENT_ID);
const neg = (o: Parameters<typeof newsItem>[0]) => newsItem({ sentimentLabel: "NEGATIVE", sentimentScore: -0.8, ...o });

describe("Index-Constituent Impact Agent: weighted impact", () => {
  it("supportive weighted impact = SUPPORTIVE with the numeric facts and evidence", async () => {
    const r = await run();
    expect(r).toMatchObject({ agentId: "index-constituent-impact-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(codesOf(r)).toContain("WEIGHTED_IMPACT_SUPPORTIVE");
    expect(r.outputSnapshot).toMatchObject({ applicable: true, direction: "BULLISH", index: "NIFTY", constituentProvider: "synthetic-constituents", consideredCount: 10, consideredWeight: 59.5, usableWeightShare: 1, weightedMovePct: 0.5, againstWeightShare: 0, topSector: "Financials", sourceIntelligenceStatus: "VALID" });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "index_constituents"]));
  });
  it("adverse weighted impact = ADVERSE (and weight breadth is noted); leaning against = CAUTION; the same data is SUPPORTIVE for a bearish signal", async () => {
    const adverse = await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(-1) })) });
    expect(adverse.verdict).toBe("ADVERSE"); expect(codesOf(adverse)).toEqual(expect.arrayContaining(["WEIGHTED_IMPACT_AGAINST", "CONSTITUENT_BREADTH_AGAINST"]));
    const lean = await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(-0.5) })) });
    expect(lean.verdict).toBe("CAUTION"); expect(codesOf(lean)).toContain("WEIGHTED_IMPACT_LEANS_AGAINST");
    const bear = await run(NIFTY({ rd: { optionType: "PE" } }), { provider: constituents(constituentSet({ changes: allChange(-1) })) });
    expect(bear.verdict).toBe("SUPPORTIVE"); expect(bear.outputSnapshot["direction"]).toBe("BEARISH");
  });
  it("mixed impact (sizeable weight on both sides, small net) = CAUTION; a flat net with no clear support = NEUTRAL", async () => {
    const changes = { AAA: -1.5, BBB: -1.5, CCC: 1.5, DDD: 1.5, EEE: 1.5, FFF: -1.5, GGG: 0, HHH: 0, III: 0, JJJ: 0 };
    const mixed = await run(NIFTY(), { provider: constituents(constituentSet({ changes })) });
    expect(mixed.verdict).toBe("CAUTION"); expect(codesOf(mixed)).toContain("MIXED_CONSTITUENT_IMPACT");
    const flat = await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(0.1) })) });
    expect(flat).toMatchObject({ verdict: "NEUTRAL", confidence: 70 }); expect(codesOf(flat)).toContain("WEIGHTED_IMPACT_FLAT");
  });
  it("a market-data quote takes precedence over the record's own change", async () => {
    const r = await run(NIFTY(), { market: quotes(allChange(-1)) });
    expect(r.verdict).toBe("ADVERSE"); expect(r.outputSnapshot).toMatchObject({ marketDataProvider: "synthetic-quotes", weightedMovePct: -1 });
  });
  it("one heavy constituent contributing against = ADVERSE; an extreme move in a heavy constituent = ADVERSE; a heavy move against = CAUTION", async () => {
    const heavy = [constituentRow("AAA", { weight: 25, recentChangePct: -2 }), constituentRow("BBB", { weight: 15 }), constituentRow("CCC", { weight: 10 }), constituentRow("DDD", { weight: 8 }), constituentRow("EEE", { weight: 6 }), constituentRow("FFF", { weight: 5 })];
    const big = await run(NIFTY(), { provider: constituents(constituentSet({ rows: heavy })) });
    expect(codesOf(big)).toEqual(expect.arrayContaining(["LARGE_CONSTITUENT_CONTRIBUTION_AGAINST", "TOP_WEIGHT_CONCENTRATION"])); expect(big.verdict).toBe("ADVERSE");
    const extreme = await run(NIFTY(), { provider: constituents(constituentSet({ changes: { ...allChange(0.5), AAA: 12 } })) });
    expect(codesOf(extreme)).toContain("EXTREME_CONSTITUENT_MOVE"); expect(extreme.verdict).toBe("ADVERSE");
    const against = await run(NIFTY(), { provider: constituents(constituentSet({ changes: { ...allChange(0.5), BBB: -2.5 } })) });
    expect(codesOf(against)).toContain("HEAVY_CONSTITUENT_MOVE_AGAINST"); expect(against.verdict).toBe("CAUTION");
  });
  it("sector concentration: informational, or a CAUTION when the dominant sector moves against the direction", async () => {
    const rows = (fin: number) => ["AAA", "BBB", "DDD", "CCC", "EEE", "FFF", "GGG"].map((s) => constituentRow(s, { sector: ["AAA", "BBB", "DDD"].includes(s) ? "Financials" : "Other", recentChangePct: ["AAA", "BBB", "DDD"].includes(s) ? fin : 0.5 }));
    const info = await run(NIFTY(), { provider: constituents(constituentSet({ rows: rows(0.5) })), rules: rulesWithNews({ constituent: { sectorConcentration: 0.45, minCoveredWeight: 40 } }) });
    expect(codesOf(info)).toContain("SECTOR_CONCENTRATION");
    const against = await run(NIFTY(), { provider: constituents(constituentSet({ rows: rows(-0.6) })), rules: rulesWithNews({ constituent: { sectorConcentration: 0.45, minCoveredWeight: 40 } }) });
    expect(codesOf(against)).toContain("SECTOR_CONCENTRATION_AGAINST"); expect(against.verdict).not.toBe("SUPPORTIVE");
  });
});

describe("Index-Constituent Impact Agent: constituent news", () => {
  it("a critical adverse event on a heavy constituent (near term) = BLOCKING; on a light constituent = ADVERSE; configurable to ADVERSE", async () => {
    const heavy = await run(NIFTY(), { news: newsFeed([neg({ symbols: ["AAA"], impact: "CRITICAL", minutesAgo: 20 })]) });
    expect(heavy.verdict).toBe("BLOCKING"); expect(codesOf(heavy)).toContain("CRITICAL_CONSTITUENT_EVENT");
    const light = await run(NIFTY(), { news: newsFeed([neg({ symbols: ["JJJ"], impact: "CRITICAL", minutesAgo: 20 })]) });
    expect(light.verdict).toBe("ADVERSE");
    expect((await run(NIFTY(), { news: newsFeed([neg({ symbols: ["AAA"], impact: "CRITICAL", minutesAgo: 20 })]), rules: rulesWithNews({ constituent: { criticalEvent: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    expect((await run(NIFTY(), { news: newsFeed([neg({ symbols: ["AAA"], impact: "CRITICAL", minutesAgo: 20, sourceReliability: 0.1 })]) })).verdict).toBe("ADVERSE"); // an unreliable source is downgraded
  });
  it("high-impact adverse news: heavy constituent = ADVERSE, light = CAUTION; medium on heavy = CAUTION; supportive high-impact on heavy = supportive evidence", async () => {
    expect((await run(NIFTY(), { news: newsFeed([neg({ symbols: ["BBB"], impact: "HIGH" })]) })).verdict).toBe("ADVERSE");
    expect((await run(NIFTY(), { news: newsFeed([neg({ symbols: ["JJJ"], impact: "HIGH" })]) })).verdict).toBe("CAUTION");
    expect((await run(NIFTY(), { news: newsFeed([neg({ symbols: ["AAA"], impact: "MEDIUM" })]) })).verdict).toBe("CAUTION");
    const sup = await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(0.1) })), news: newsFeed([newsItem({ symbols: ["AAA"], impact: "HIGH" })]) });
    expect(sup.verdict).toBe("SUPPORTIVE"); expect(codesOf(sup)).toContain("CONSTITUENT_NEWS_SUPPORTIVE");
    const conflict = await run(NIFTY(), { news: newsFeed([newsItem({ symbols: ["AAA"], impact: "HIGH" }), neg({ symbols: ["BBB"], impact: "HIGH" })]) });
    expect(codesOf(conflict)).toContain("CONFLICTING_CONSTITUENT_NEWS");
  });
  it("duplicates count once; news about other symbols is ignored; no news provider is noted; a failing or malformed news provider is UNAVAILABLE", async () => {
    const a = neg({ symbols: ["AAA"], impact: "HIGH", id: "d1", headline: "Same" });
    const r = await run(NIFTY(), { news: newsFeed([a, { ...a, id: "d2" }, neg({ symbols: ["ZZZ"], impact: "CRITICAL" })]) });
    expect(codesOf(r)).toContain("DUPLICATE_NEWS_IGNORED"); expect(r.findings.filter((f) => f.code === "HIGH_IMPACT_CONSTITUENT_NEWS_AGAINST")).toHaveLength(1); expect(r.outputSnapshot["newsItemsConsidered"]).toBe(1);
    expect(codesOf(await run())).toContain("CONSTITUENT_NEWS_NOT_CONFIGURED");
    expect(await run(NIFTY(), { news: { name: "x", asOf: null, items: async () => { throw new Error("SECRET-DETAIL"); } } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "NEWS_PROVIDER_UNAVAILABLE" });
    expect(await run(NIFTY(), { news: newsFeed([{ id: "x" }]) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "NEWS_DATA_MALFORMED" });
  });
});

describe("Index-Constituent Impact Agent: applicability, completeness, staleness", () => {
  it("a non-index underlying: the agent is not applicable (NEUTRAL, applicable false), never touching the providers", async () => {
    let touched = false;
    const spy: ConstituentProvider = { name: "spy", knowsIndex: async () => { touched = true; return true; }, constituents: async () => { touched = true; return null; } };
    const r = await run(inputs(), { provider: spy });
    expect(r).toMatchObject({ status: "COMPLETED", verdict: "NEUTRAL", confidence: 70 }); expect(r.outputSnapshot["applicable"]).toBe(false); expect(codesOf(r)).toEqual(["NOT_AN_INDEX_SIGNAL"]); expect(touched).toBe(false);
    expect((await run(inputs({ rd: { symbol: "ACME" } }), { provider: null })).verdict).toBe("NEUTRAL"); // not applicable even with no provider
  });
  it("the index underlyings are configurable", async () => {
    expect((await run(inputs({ rd: { symbol: "ACME" } }), { rules: rulesWithNews({ constituent: { indexUnderlyings: ["ACME"] } }), provider: null }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_PROVIDER_NOT_CONFIGURED" });
  });
  it("missing constituent data => UNAVAILABLE: no provider, an index the provider does not cover, a missing set, too little covered weight, no usable change data", async () => {
    expect(await run(NIFTY(), { provider: null })).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "CONSTITUENT_PROVIDER_NOT_CONFIGURED" });
    expect(await run(NIFTY(), { provider: constituents(constituentSet({ index: "BANKNIFTY" })) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "INDEX_NOT_COVERED" });
    expect(await run(NIFTY(), { provider: { name: "x", knowsIndex: async () => true, constituents: async () => null } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_DATA_MALFORMED" });
    const thin = [constituentRow("AAA"), constituentRow("BBB")];
    expect(await run(NIFTY(), { provider: constituents(constituentSet({ rows: thin })) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_COVERAGE_INSUFFICIENT" });
    expect(await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(0) && Object.fromEntries(Object.keys(allChange(0)).map((k) => [k, null])) })) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_DATA_INCOMPLETE" });
  });
  it("partial data (usable share still enough) = CAUTION; stale values = CAUTION; values too old are unusable", async () => {
    const partial = await run(NIFTY(), { provider: constituents(constituentSet({ changes: { JJJ: null } })) });
    expect(partial.verdict).toBe("CAUTION"); expect(codesOf(partial)).toContain("CONSTITUENT_DATA_PARTIAL");
    const stale = await run(NIFTY(), { market: quotes(allChange(0.5), at(-120)) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("CONSTITUENT_DATA_STALE");
    expect(await run(NIFTY(), { market: quotes(allChange(0.5), at(-3000)), provider: constituents(constituentSet({ changes: Object.fromEntries(Object.keys(allChange(0)).map((k) => [k, null])) })) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_DATA_INCOMPLETE" });
    const oldRecords = constituentSet({ rows: Object.keys(allChange(0)).map((s) => constituentRow(s, { dataAsOf: at(-3000) })) });
    expect(await run(NIFTY(), { provider: constituents(oldRecords) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_DATA_INCOMPLETE" });
  });
  it("index / underlying mismatch => UNAVAILABLE (set for another index, or a record from another index)", async () => {
    const wrongSet: ConstituentProvider = { name: "x", knowsIndex: async () => true, constituents: async () => constituentSet({ index: "BANKNIFTY" }) };
    expect(await run(NIFTY(), { provider: wrongSet })).toMatchObject({ status: "UNAVAILABLE", errorCode: "INDEX_UNDERLYING_MISMATCH" });
    const wrongRow: ConstituentProvider = { name: "x", knowsIndex: async () => true, constituents: async () => constituentSet({ rows: Object.keys(allChange(0)).map((s) => constituentRow(s, s === "AAA" ? { index: "BANKNIFTY" } : {})) }) };
    expect(await run(NIFTY(), { provider: wrongRow })).toMatchObject({ status: "UNAVAILABLE", errorCode: "INDEX_UNDERLYING_MISMATCH" });
  });
  it.each<[string, unknown]>([
    ["a duplicate symbol", constituentSet({ rows: [constituentRow("AAA"), constituentRow("AAA"), ...Object.keys(allChange(0)).slice(2).map((s) => constituentRow(s))] })],
    ["a non-positive weight", constituentSet({ rows: [constituentRow("AAA", { weight: 0 }), ...Object.keys(allChange(0)).slice(1).map((s) => constituentRow(s))] })],
    ["weights above 100", constituentSet({ rows: [constituentRow("AAA", { weight: 70 }), constituentRow("BBB", { weight: 70 })] })],
    ["an unsafe sector label", constituentSet({ rows: [constituentRow("AAA", { sector: "<b>" }), ...Object.keys(allChange(0)).slice(1).map((s) => constituentRow(s))] })],
    ["a non-finite change", constituentSet({ rows: [constituentRow("AAA", { recentChangePct: Number.NaN }), ...Object.keys(allChange(0)).slice(1).map((s) => constituentRow(s))] })],
    ["an unparseable timestamp", constituentSet({ asOf: "yesterday" })],
  ])("malformed provider data (%s) => UNAVAILABLE", async (_n, set) => {
    expect(await run(NIFTY(), { provider: { name: "x", knowsIndex: async () => true, constituents: async () => set as never } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONSTITUENT_DATA_MALFORMED" });
  });
  it("provider failure (constituents, knowsIndex, market data) and malformed market data => UNAVAILABLE; the provider's message is never stored", async () => {
    const boom = (): never => { throw new Error("connection refused SECRET-DETAIL"); };
    const rs = [
      await run(NIFTY(), { provider: { name: "x", knowsIndex: async () => true, constituents: async () => boom() } }),
      await run(NIFTY(), { provider: { name: "x", knowsIndex: async () => boom(), constituents: async () => null } }),
      await run(NIFTY(), { market: { name: "x", quotes: async () => boom() } }),
    ];
    expect(rs.map((r) => r.errorCode)).toEqual(["CONSTITUENT_PROVIDER_UNAVAILABLE", "CONSTITUENT_PROVIDER_UNAVAILABLE", "MARKET_DATA_UNAVAILABLE"]);
    expect(JSON.stringify(rs)).not.toContain("SECRET-DETAIL");
    expect(await run(NIFTY(), { market: { name: "x", quotes: async () => ({ AAA: { changePct1d: Number.NaN, asOf: at(-1) } }) } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "MARKET_DATA_MALFORMED" });
  });
});

describe("Index-Constituent Impact Agent: configuration, language, determinism", () => {
  it("top count, minimum weight and the move / impact thresholds are configurable", async () => {
    const top3 = await run(NIFTY(), { rules: rulesWithNews({ constituent: { topCount: 3, minUsableShare: 0.5 } }) });
    expect(top3.outputSnapshot).toMatchObject({ consideredCount: 3, consideredWeight: 30 });
    expect((await run(NIFTY(), { rules: rulesWithNews({ constituent: { minWeight: 5 } }) })).outputSnapshot["consideredCount"]).toBe(6);
    expect((await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(-1) })), rules: rulesWithNews({ constituent: { impactAdverse: 1.5, impactCaution: 1.2 } }) })).verdict).not.toBe("ADVERSE");
  });
  it("findings are evidence-only (no causal language), the contract is valid and nothing contains message text", async () => {
    const r = await run(NIFTY(), { provider: constituents(constituentSet({ changes: allChange(-3) })), news: newsFeed([neg({ symbols: ["AAA"], impact: "CRITICAL", minutesAgo: 10 })]) });
    expect(r.findings.length).toBeGreaterThan(3);
    expect(r.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|driven by|will|expect|predict|should)\b/i);
    expect(JSON.stringify([r.inputSnapshot, r.outputSnapshot, r.findings])).not.toMatch(/rawText|raw_text|telegram/i);
    expect(indexConstituentAgent(rulesWithNews(), null, null, null).contract).toMatchObject({ agentId: "index-constituent-impact-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision"] });
  });
  it("is deterministic", async () => { expect((await run()).outputSnapshot).toEqual((await run()).outputSnapshot); });
});
