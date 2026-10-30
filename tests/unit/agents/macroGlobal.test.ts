import { describe, expect, it } from "vitest";
import { macroGlobalAgent, MACRO_GLOBAL_AGENT_ID, signalDirection, type AgentRulesConfig, type MacroContextProvider, type MacroSnapshot } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, NOW, type InputOverrides } from "../../support/agentFixtures";
import { at, event, macroProvider, rulesWith, snapshot } from "../../support/calendarMacroFixtures";

const run = async (inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; snap?: MacroSnapshot | null; provider?: MacroContextProvider | null } = {}) =>
  (await evalAgents([macroGlobalAgent(o.rules ?? rulesWith(), o.provider === undefined ? macroProvider(o.snap === undefined ? snapshot() : o.snap) : o.provider)], inp, {}, [], NOW)).byId(MACRO_GLOBAL_AGENT_ID);
const idx = (level: number, closes: number[], extra: { previousClose?: number | null; open?: number | null } = {}) => ({ symbol: "SYNTHIDX", level, previousClose: extra.previousClose === undefined ? closes[closes.length - 1] ?? null : extra.previousClose, open: extra.open === undefined ? null : extra.open, recentCloses: closes });
const SELL = (o: InputOverrides = {}) => inputs({ ...o, rd: { side: "SELL", stopLoss: 105, targets: [95, 90], ...o.rd }, sf: { side: "SELL", ...o.sf } });

describe("Macro / Global Market Agent: direction", () => {
  it.each<[string, string, string, string | null, 1 | -1 | null]>([
    ["equity", "BUY", "equity", null, 1], ["equity", "SELL", "equity", null, -1], ["future", "BUY", "future", null, 1], ["future", "SELL", "future", null, -1],
    ["BUY CE", "BUY", "option", "CE", 1], ["BUY PE", "BUY", "option", "PE", -1], ["SELL CE", "SELL", "option", "CE", -1], ["SELL PE", "SELL", "option", "PE", 1],
    ["unknown side", "HOLD", "equity", null, null], ["option without type", "BUY", "option", null, null], ["unknown type", "BUY", "bond", null, null],
  ])("%s", (_n, side, type, ot, expected) => { expect(signalDirection(type, side, ot)).toBe(expected); });
});

describe("Macro / Global Market Agent: verdicts", () => {
  it("a clean supportive case (trend aligned, calm volatility, healthy breadth, nothing scheduled) is SUPPORTIVE with evidence and numeric facts", async () => {
    const r = await run();
    expect(r).toMatchObject({ agentId: "macro-global-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(codesOf(r)).toEqual(expect.arrayContaining(["TREND_ALIGNED"]));
    expect(r.findings.every((f) => f.severity === "INFO")).toBe(true);
    expect(r.outputSnapshot).toMatchObject({ direction: "BULLISH", provider: "synthetic-macro", indexSymbol: "SYNTHIDX", trendLookbackSessions: 5, trendPct: 2.0833, changePct1d: 0.4098, gapPct: 0.2049, volatilityLevel: 14, contextAgeMinutes: 5, optionalMissing: [], sourceIntelligenceStatus: "VALID", failedCodes: [] });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "macro_context"]));
  });
  it("a flat trend with nothing adverse is NEUTRAL (not supportive: nothing positive was shown)", async () => {
    const r = await run(inputs(), { snap: snapshot({ index: idx(24410, [24380, 24390, 24400, 24405, 24400], { open: 24405 }) }) });
    expect(r).toMatchObject({ verdict: "NEUTRAL", confidence: 70 });
    expect(codesOf(r)).toContain("TREND_FLAT");
  });
  it("a bearish signal in a rising market = CAUTION / ADVERSE by the size of the conflict; a bearish signal in a falling market is SUPPORTIVE", async () => {
    const mild = await run(SELL(), { snap: snapshot({ index: idx(24500, [24310, 24320, 24330, 24340, 24400], { previousClose: 24400, open: 24450 }) }) }); // +0.78% over 5 sessions
    expect(mild.verdict).toBe("CAUTION"); expect(codesOf(mild)).toContain("TREND_CONFLICT_MILD");
    const strong = await run(SELL()); // the default fixture: +2.08% over 5 sessions
    expect(strong.verdict).toBe("ADVERSE"); expect(codesOf(strong)).toContain("TREND_CONFLICT_STRONG");
    const falling = await run(SELL(), { snap: snapshot({ index: idx(23900, [24300, 24250, 24200, 24100, 24000], { previousClose: 24000, open: 23950 }) }) }); // -1.6%
    expect(falling.verdict).toBe("SUPPORTIVE"); expect(codesOf(falling)).toContain("TREND_ALIGNED");
  });
  it("an adverse trend conflict for a BUY (falling market)", async () => {
    const r = await run(inputs(), { snap: snapshot({ index: idx(23900, [24300, 24250, 24200, 24100, 24000], { previousClose: 24000, open: 24000 }) }) }); // -1.6% over 5 sessions: caution
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("TREND_CONFLICT_MILD");
    const strong = await run(inputs(), { snap: snapshot({ index: idx(23700, [24300, 24250, 24200, 24100, 24000], { previousClose: 23900, open: 23900 }) }) }); // -2.5%
    expect(strong.verdict).toBe("ADVERSE"); expect(codesOf(strong)).toContain("TREND_CONFLICT_STRONG");
  });
  it("PE / CE options map to the underlying direction (BUY PE in a rising market conflicts; BUY CE aligns)", async () => {
    expect((await run(optionInputs())).verdict).toBe("SUPPORTIVE");
    const pe = await run(optionInputs({ rd: { optionType: "PE" } }));
    expect(pe.verdict).toBe("ADVERSE"); expect(pe.outputSnapshot["direction"]).toBe("BEARISH");
  });
  it("an unknown direction is a CAUTION (alignment is not assessed, never guessed)", async () => {
    const r = await run(inputs({ rd: { side: "HOLD" } }));
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("DIRECTION_UNKNOWN"); expect(r.outputSnapshot["direction"]).toBe("UNKNOWN");
  });
});

describe("Macro / Global Market Agent: volatility, gaps and moves", () => {
  it.each<[string, Partial<MacroSnapshot>, string, string]>([
    ["volatility index elevated (21)", { volatilityIndex: { name: "V", level: 21, changePct1d: 0 } }, "CAUTION", "VOLATILITY_ELEVATED"],
    ["volatility index high (26)", { volatilityIndex: { name: "V", level: 26, changePct1d: 0 } }, "ADVERSE", "VOLATILITY_HIGH"],
    ["volatility index at the block level (40)", { volatilityIndex: { name: "V", level: 40, changePct1d: 0 } }, "BLOCKING", "VOLATILITY_EXTREME"],
    ["a volatility spike (+20% in a day)", { volatilityIndex: { name: "V", level: 15, changePct1d: 20 } }, "ADVERSE", "VOLATILITY_SPIKE"],
    ["a notable index move (+1.6% 1d)", { index: idx(24800, [24000, 24100, 24200, 24300, 24400], { previousClose: 24409, open: 24409 }) }, "CAUTION", "NOTABLE_INDEX_MOVE"],
    ["a large index move (+3.2% 1d)", { index: idx(25200, [24000, 24100, 24200, 24300, 24400], { previousClose: 24420, open: 24420 }) }, "ADVERSE", "LARGE_INDEX_MOVE"],
    ["an extreme index move (-7.5% 1d)", { index: idx(22600, [24000, 24100, 24200, 24300, 24400], { previousClose: 24435, open: 24435 }) }, "BLOCKING", "EXTREME_INDEX_MOVE"],
    ["a gap (+1.2%)", { index: idx(24500, [24000, 24100, 24200, 24300, 24400], { previousClose: 24400, open: 24693 }) }, "CAUTION", "GAP_RISK"],
    ["a large gap (-2.5%)", { index: idx(24500, [24000, 24100, 24200, 24300, 24400], { previousClose: 24400, open: 23790 }) }, "ADVERSE", "GAP_RISK_HIGH"],
    ["a large currency move", { currency: { pair: "SYNTHFX", changePct1d: 1.4 } }, "CAUTION", "CURRENCY_MOVE"],
  ])("%s => %s", async (_n, over, verdict, code) => {
    const r = await run(inputs(), { snap: snapshot(over) });
    expect(r.verdict).toBe(verdict);
    expect(codesOf(r)).toContain(code);
  });
  it("calm thresholds just below the limits do not fire; the thresholds are configurable", async () => {
    expect(codesOf(await run(inputs(), { snap: snapshot({ volatilityIndex: { name: "V", level: 19.9, changePct1d: 14.9 } }) })).filter((c) => c.startsWith("VOLATILITY"))).toEqual([]);
    const r = await run(inputs(), { snap: snapshot({ volatilityIndex: { name: "V", level: 19, changePct1d: 0 } }), rules: rulesWith({ macro: { volCaution: 15 } }) });
    expect(codesOf(r)).toContain("VOLATILITY_ELEVATED");
    const blockLower = await run(inputs(), { snap: snapshot({ volatilityIndex: { name: "V", level: 30, changePct1d: 0 } }), rules: rulesWith({ macro: { volBlock: 30 } }) });
    expect(blockLower.verdict).toBe("BLOCKING");
  });
});

describe("Macro / Global Market Agent: risk-off, global markets and macro releases", () => {
  it("risk-off breadth against a bullish signal = CAUTION; with a volatility spike = ADVERSE; risk-on breadth against a bearish signal = CAUTION; no conflict otherwise", async () => {
    const off = await run(inputs(), { snap: snapshot({ breadth: { advancers: 500, decliners: 1500 } }) });
    expect(off.verdict).toBe("CAUTION"); expect(codesOf(off)).toContain("RISK_OFF_CONTEXT");
    const offSpike = await run(inputs(), { snap: snapshot({ breadth: { advancers: 500, decliners: 1500 }, volatilityIndex: { name: "V", level: 16, changePct1d: 18 } }) });
    expect(offSpike.verdict).toBe("ADVERSE");
    const on = await run(SELL(), { snap: snapshot({ index: idx(24000, [24500, 24400, 24300, 24200, 24100], { previousClose: 24100, open: 24050 }), breadth: { advancers: 1800, decliners: 200 } }) });
    expect(codesOf(on)).toContain("RISK_ON_CONTEXT");
    expect(codesOf(await run(inputs(), { snap: snapshot({ breadth: { advancers: 1200, decliners: 800 } }) }))).toContain("BREADTH_NO_CONFLICT");
    expect(codesOf(await run(inputs(), { snap: snapshot({ breadth: { advancers: 0, decliners: 0 } }) }))).toContain("OPTIONAL_CONTEXT_MISSING");
  });
  it("a global index moving against the direction: mild = CAUTION, major = ADVERSE; moving with it is fine", async () => {
    const mild = await run(inputs(), { snap: snapshot({ global: [{ name: "G1", sessionStatus: "open", changePct1d: -1.2 }] }) });
    expect(mild.verdict).toBe("CAUTION"); expect(codesOf(mild)).toContain("GLOBAL_MARKET_CONFLICT_MILD");
    const major = await run(inputs(), { snap: snapshot({ global: [{ name: "G1", sessionStatus: "closed", changePct1d: -2.4 }, { name: "G2", sessionStatus: "open", changePct1d: 0.5 }] }) });
    expect(major.verdict).toBe("ADVERSE"); expect(codesOf(major)).toContain("GLOBAL_MARKET_CONFLICT");
    expect((await run(SELL(), { snap: snapshot({ global: [{ name: "G1", sessionStatus: "closed", changePct1d: -2.4 }], index: idx(24000, [24500, 24400, 24300, 24200, 24100], { previousClose: 24100, open: 24050 }) }) })).verdict).not.toBe("ADVERSE");
  });
  it.each<[string, Parameters<typeof event>[0], string, string]>([
    ["a CRITICAL release inside its window", { minutes: 30, impact: "CRITICAL" }, "BLOCKING", "MACRO_RELEASE_IMMINENT"],
    ["a CRITICAL release that just happened (-10 min)", { minutes: -10, impact: "CRITICAL" }, "BLOCKING", "MACRO_RELEASE_IMMINENT"],
    ["a HIGH release inside its window", { minutes: 45, impact: "HIGH" }, "ADVERSE", "MACRO_RELEASE_NEAR"],
    ["a MEDIUM release inside its window", { minutes: 20, impact: "MEDIUM" }, "CAUTION", "MACRO_RELEASE_NOTED"],
    ["a LOW release (ignored)", { minutes: 20, impact: "LOW" }, "SUPPORTIVE", ""],
    ["a release outside the window (90 min)", { minutes: 90, impact: "CRITICAL" }, "SUPPORTIVE", ""],
    ["a release for another market", { minutes: 20, impact: "CRITICAL", markets: ["LSE"] }, "SUPPORTIVE", ""],
    ["a release for ALL markets", { minutes: 20, impact: "HIGH", markets: ["ALL"] }, "ADVERSE", "MACRO_RELEASE_NEAR"],
  ])("%s => %s", async (_n, ev, verdict, code) => {
    const r = await run(inputs(), { snap: snapshot({ releases: [event(ev)] }) });
    expect(r.verdict).toBe(verdict);
    if (code) expect(codesOf(r)).toContain(code);
  });
  it("the critical-release severity and windows are configurable", async () => {
    const s = snapshot({ releases: [event({ minutes: 30, impact: "CRITICAL" })] });
    expect((await run(inputs(), { snap: s, rules: rulesWith({ macro: { criticalRelease: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    expect((await run(inputs(), { snap: s, rules: rulesWith({ macro: { releaseBefore: 10 } }) })).verdict).toBe("SUPPORTIVE");
  });
});

describe("Macro / Global Market Agent: completeness and staleness", () => {
  it("missing optional sections are noted (INFO) and do not change a supportive verdict; with none at all the context is thin (CAUTION)", async () => {
    const some = await run(inputs(), { snap: snapshot({ global: [], currency: null }) });
    expect(some.verdict).toBe("SUPPORTIVE"); expect(some.outputSnapshot["optionalMissing"]).toEqual(["global_markets", "currency"]);
    const thin = await run(inputs(), { snap: snapshot({ breadth: null, volatilityIndex: null, global: [], currency: null }) });
    expect(thin.verdict).toBe("CAUTION"); expect(codesOf(thin)).toContain("CONTEXT_THIN");
  });
  it("a stale (but usable) context = CAUTION; a context too old = UNAVAILABLE; a context from the future = UNAVAILABLE", async () => {
    const stale = await run(inputs(), { snap: snapshot({ asOf: at(-120) }) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("MACRO_CONTEXT_STALE"); expect(stale.outputSnapshot["contextAgeMinutes"]).toBe(120);
    expect(await run(inputs(), { snap: snapshot({ asOf: at(-60 * 30) }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "MACRO_CONTEXT_TOO_OLD" });
    expect(await run(inputs(), { snap: snapshot({ asOf: at(90) }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "MACRO_CONTEXT_FROM_FUTURE" });
    expect((await run(inputs(), { snap: snapshot({ asOf: at(-120) }), rules: rulesWith({ macro: { staleCautionMinutes: 180 } }) })).verdict).toBe("SUPPORTIVE");
    expect(await run(inputs(), { snap: snapshot({ asOf: at(-120) }), rules: rulesWith({ macro: { unavailableMinutes: 100 } }) })).toMatchObject({ status: "UNAVAILABLE" });
  });
  it("the trend lookback is configurable and needs enough history", async () => {
    const r2 = await run(inputs(), { rules: rulesWith({ macro: { trendLookbackSessions: 2 } }) }); // 24500 vs 24300
    expect(r2.outputSnapshot).toMatchObject({ trendLookbackSessions: 2, trendPct: 0.823 });
    expect(await run(inputs(), { rules: rulesWith({ macro: { trendLookbackSessions: 6 } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "MACRO_TREND_HISTORY_INSUFFICIENT" });
  });
});

describe("Macro / Global Market Agent: required context unavailable => UNAVAILABLE, never a pass", () => {
  it.each<[string, Parameters<typeof run>[1], string]>([
    ["no provider configured", { provider: null }, "MACRO_PROVIDER_NOT_CONFIGURED"],
    ["no context for the market", { snap: null }, "MACRO_CONTEXT_NOT_AVAILABLE"],
    ["no index in the context", { snap: snapshot({ index: null }) }, "MACRO_INDEX_MISSING"],
    ["a provider that throws", { provider: { name: "x", context: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "MACRO_PROVIDER_UNAVAILABLE"],
    ["a non-finite index level", { snap: snapshot({ index: idx(Number.NaN, [1, 2, 3, 4, 5]) }) }, "MACRO_DATA_MALFORMED"],
    ["a negative close in the history", { snap: snapshot({ index: idx(100, [1, -2, 3, 4, 5]) }) }, "MACRO_DATA_MALFORMED"],
    ["an unparseable as-of time", { snap: snapshot({ asOf: "yesterday" }) }, "MACRO_DATA_MALFORMED"],
    ["negative breadth", { snap: snapshot({ breadth: { advancers: -1, decliners: 4 } }) }, "MACRO_DATA_MALFORMED"],
    ["a malformed release", { snap: snapshot({ releases: [{ id: "x" } as never] }) }, "MACRO_DATA_MALFORMED"],
    ["a bad global entry", { snap: snapshot({ global: [{ name: "G", sessionStatus: "maybe" as never, changePct1d: 1 }] }) }, "MACRO_DATA_MALFORMED"],
    ["a non-object snapshot", { snap: "garbage" as never }, "MACRO_DATA_MALFORMED"],
  ])("%s", async (_n, o, code) => {
    const r = await run(inputs(), o);
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("a missing market or underlying is UNAVAILABLE", async () => {
    expect(await run(inputs({ rd: { market: null } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "MISSING_CONTEXT" });
    expect(await run(inputs({ rd: { symbol: "UNKNOWN" } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "MISSING_CONTEXT" });
  });
});

describe("Macro / Global Market Agent: determinism and isolation", () => {
  it("is deterministic, uses the engine clock and the contract is valid (can block, not advisory, optional source intelligence)", async () => {
    const a = await run(), b = await run();
    expect(a.outputSnapshot).toEqual(b.outputSnapshot);
    expect(a.findings).toEqual(b.findings);
    const c = macroGlobalAgent(rulesWith(), null).contract;
    expect(c).toMatchObject({ agentId: "macro-global-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision"], optionalInputs: ["signal_features", "source_intelligence"] });
  });
  it("source intelligence is optional (absent => 'none') and nothing in the result contains message text", async () => {
    const r = await run(inputs({ si: null }));
    expect(r.status).toBe("COMPLETED"); expect(r.outputSnapshot["sourceIntelligenceStatus"]).toBe("none");
    expect(JSON.stringify([r.inputSnapshot, r.outputSnapshot, r.findings])).not.toMatch(/rawText|raw_text|telegram/i);
  });
  it("the finding wording is evidence-based: no causal language", async () => {
    const r = await run(inputs(), { snap: snapshot({ index: idx(23700, [24300, 24250, 24200, 24100, 24000], { previousClose: 23900, open: 23900 }), volatilityIndex: { name: "V", level: 30, changePct1d: 25 }, breadth: { advancers: 300, decliners: 1700 }, global: [{ name: "G", sessionStatus: "open", changePct1d: -3 }], currency: { pair: "FX", changePct1d: 2 }, releases: [event({ minutes: 20, impact: "HIGH" })] }) });
    expect(r.findings.length).toBeGreaterThan(5);
    expect(r.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|driven by|will|expect|predict|should)\b/i);
  });
});
