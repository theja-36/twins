import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_RULES, signalIntegrityAgent, SIGNAL_INTEGRITY_AGENT_ID, type AgentRulesConfig } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, SIGNAL_TIME, type InputOverrides } from "../../support/agentFixtures";

const rules = (over: { signal?: Partial<AgentRulesConfig["signal"]> } = {}): AgentRulesConfig => ({ ...DEFAULT_AGENT_RULES, signal: { ...DEFAULT_AGENT_RULES.signal, ...over.signal } });
const run = async (inp: Record<string, unknown>, r: AgentRulesConfig = rules(), now?: Date) => (await evalAgents([signalIntegrityAgent(r)], inp, {}, [], now)).byId(SIGNAL_INTEGRITY_AGENT_ID);
const minutesAfter = (m: number): Date => new Date(Date.parse(SIGNAL_TIME) + m * 60_000);

describe("Signal Integrity Agent: verdicts", () => {
  it("a clean signal is SUPPORTIVE with no findings, certain structural facts and evidence references", async () => {
    const r = await run(inputs());
    expect(r).toMatchObject({ agentId: "signal-integrity-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90, findings: [] });
    expect(r.outputSnapshot).toMatchObject({ blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false, staleSeconds: 300 });
    expect(r.outputSnapshot["checksRun"]).toBeGreaterThan(10);
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "stop_loss_validation", "scorecard_run"]));
  });
  it("a clean option signal is SUPPORTIVE too", async () => { expect((await run(optionInputs())).verdict).toBe("SUPPORTIVE"); });

  it.each<[string, InputOverrides, string, string]>([
    ["a missing market", { rd: { market: null }, sf: { market: "" } }, "BLOCKING", "MARKET_MISSING"],
    ["a malformed market", { rd: { market: "N S E" }, sf: { market: "N S E" } }, "BLOCKING", "MARKET_MALFORMED"],
    ["a missing instrument type", { rd: { instrumentType: null } }, "BLOCKING", "INSTRUMENT_TYPE_MISSING"],
    ["an unsupported instrument type", { rd: { instrumentType: "bond" } }, "BLOCKING", "INSTRUMENT_TYPE_UNSUPPORTED"],
    ["a missing underlying", { rd: { symbol: "UNKNOWN" } }, "BLOCKING", "UNDERLYING_MISSING"],
    ["a missing side", { rd: { side: null }, sf: { side: "" } }, "BLOCKING", "SIDE_MISSING"],
    ["an invalid side", { rd: { side: "HOLD" }, sf: { side: "HOLD" } }, "BLOCKING", "SIDE_INVALID"],
    ["a missing entry", { rd: { entryPrice: null } }, "BLOCKING", "ENTRY_MISSING"],
    ["an invalid entry", { rd: { entryPrice: -5 } }, "BLOCKING", "ENTRY_INVALID"],
    ["a missing stop-loss", { rd: { stopLoss: null } }, "BLOCKING", "STOP_LOSS_MISSING"],
    ["an invalid stop-loss", { rd: { stopLoss: 0 } }, "BLOCKING", "STOP_LOSS_INVALID"],
    ["a stop-loss validation that is not VALID", { slv: { result: "INVALID" } }, "BLOCKING", "STOP_LOSS_VALIDATION_FAILED"],
    ["a stop-loss above a BUY entry", { rd: { stopLoss: 105 } }, "BLOCKING", "STOP_LOSS_WRONG_SIDE"],
    ["a stop-loss below a SELL entry", { rd: { side: "SELL", stopLoss: 95, targets: [90] }, sf: { side: "SELL" } }, "BLOCKING", "STOP_LOSS_WRONG_SIDE"],
    ["a target below a BUY entry", { rd: { targets: [105, 99] } }, "BLOCKING", "TARGET_WRONG_SIDE"],
    ["a target above a SELL entry", { rd: { side: "SELL", stopLoss: 105, targets: [90, 101] }, sf: { side: "SELL" } }, "BLOCKING", "TARGET_WRONG_SIDE"],
    ["targets out of order (default ADVERSE)", { rd: { targets: [110, 105, 115] } }, "ADVERSE", "TARGETS_OUT_OF_ORDER"],
    ["duplicate targets under strict ordering", { rd: { targets: [105, 105] } }, "ADVERSE", "TARGETS_OUT_OF_ORDER"],
    ["no targets", { rd: { targets: [] } }, "CAUTION", "TARGETS_MISSING"],
    ["an option without an expiry", { rd: { instrumentType: "option", expiry: null, strike: 24500, optionType: "CE", symbol: "NIFTY" } }, "BLOCKING", "EXPIRY_MISSING"],
    ["an option with a malformed expiry", { rd: { instrumentType: "option", expiry: "30/01/2025", strike: 24500, optionType: "CE", symbol: "NIFTY" } }, "BLOCKING", "EXPIRY_FORMAT_INVALID"],
    ["an option with an impossible date", { rd: { instrumentType: "option", expiry: "2025-02-30", strike: 24500, optionType: "CE", symbol: "NIFTY" } }, "BLOCKING", "EXPIRY_FORMAT_INVALID"],
    ["an option with an invalid strike", { rd: { instrumentType: "option", expiry: "2025-01-30", strike: -1, optionType: "CE", symbol: "NIFTY" } }, "BLOCKING", "STRIKE_INVALID"],
    ["an option with no strike", { rd: { instrumentType: "option", expiry: "2025-01-30", strike: null, optionType: "CE", symbol: "NIFTY" } }, "BLOCKING", "STRIKE_INVALID"],
    ["an option with an invalid option type", { rd: { instrumentType: "option", expiry: "2025-01-30", strike: 24500, optionType: "XX", symbol: "NIFTY" } }, "BLOCKING", "OPTION_TYPE_INVALID"],
    ["a future without an expiry", { rd: { instrumentType: "future", expiry: null, symbol: "NIFTY" } }, "BLOCKING", "EXPIRY_MISSING"],
    ["a strike on an equity", { rd: { strike: 100 } }, "ADVERSE", "OPTION_FIELDS_ON_NON_OPTION"],
    ["derived features that disagree with the decision", { sf: { side: "SELL" } }, "ADVERSE", "FEATURES_INCONSISTENT"],
    ["a very tight stop", { sf: { stopDistance: "LT_1PCT" } }, "CAUTION", "STOP_VERY_TIGHT"],
    ["a very wide stop", { sf: { stopDistance: "GTE_10PCT" } }, "CAUTION", "STOP_VERY_WIDE"],
    ["a reward below 1R", { sf: { rewardRisk: "LT_1" } }, "CAUTION", "REWARD_BELOW_RISK"],
  ])("%s -> %s (%s)", async (_n, over, verdict, code) => {
    const r = await run(inputs(over));
    expect(r.status).toBe("COMPLETED");
    expect(r.verdict).toBe(verdict);
    expect(codesOf(r)).toContain(code);
  });

  it("a missing mandatory value is reported, never guessed: nothing is defaulted and no other check pretends it was fine", async () => {
    const r = await run(inputs({ rd: { market: null, instrumentType: null, side: null, entryPrice: null, stopLoss: null } }));
    expect(r.verdict).toBe("BLOCKING");
    expect(codesOf(r)).toEqual(expect.arrayContaining(["MARKET_MISSING", "INSTRUMENT_TYPE_MISSING", "SIDE_MISSING", "ENTRY_MISSING", "STOP_LOSS_MISSING"]));
    expect(codesOf(r)).not.toContain("STOP_LOSS_WRONG_SIDE"); // level coherence is not judged without usable inputs
    expect(r.confidence).toBe(100);
  });
  it("mirrors the geometry for SELL (ordered descending targets are fine)", async () => {
    expect((await run(inputs({ rd: { side: "SELL", stopLoss: 105, targets: [95, 90, 85] }, sf: { side: "SELL" } }))).verdict).toBe("SUPPORTIVE");
    expect(codesOf(await run(inputs({ rd: { side: "SELL", stopLoss: 105, targets: [95, 97] }, sf: { side: "SELL" } })))).toContain("TARGETS_OUT_OF_ORDER");
  });
  it("is deterministic: identical inputs and clock always give the identical result", async () => {
    const a = await run(inputs({ rd: { targets: [110, 105] } })), b = await run(inputs({ rd: { targets: [110, 105] } }));
    expect(JSON.stringify([a.verdict, a.confidence, a.findings, a.outputSnapshot, a.inputSnapshotRef])).toBe(JSON.stringify([b.verdict, b.confidence, b.findings, b.outputSnapshot, b.inputSnapshotRef]));
  });
});

describe("Signal Integrity Agent: configuration", () => {
  it("target ordering policy: non_strict allows equal targets; the violation severity is configurable", async () => {
    expect((await run(inputs({ rd: { targets: [105, 105] } }), rules({ signal: { targetOrdering: "non_strict" } }))).verdict).toBe("SUPPORTIVE");
    expect((await run(inputs({ rd: { targets: [110, 105] } }), rules({ signal: { targetOrdering: "non_strict" } }))).verdict).toBe("ADVERSE");
    expect((await run(inputs({ rd: { targets: [110, 105] } }), rules({ signal: { targetOrderViolation: "BLOCKING" } }))).verdict).toBe("BLOCKING");
  });
  it.each<[string, number, string, string | null]>([
    ["9 minutes", 9, "SUPPORTIVE", null], ["11 minutes", 11, "CAUTION", "SIGNAL_AGING"], ["31 minutes", 31, "ADVERSE", "SIGNAL_STALE"], ["121 minutes", 121, "BLOCKING", "SIGNAL_STALE"],
  ])("staleness at %s -> %s", async (_n, minutes, verdict, code) => {
    const r = await run(inputs(), rules(), minutesAfter(minutes));
    expect(r.verdict).toBe(verdict);
    if (code) expect(codesOf(r)).toContain(code);
  });
  it("staleness thresholds are configurable", async () => {
    const strict = rules({ signal: { staleCautionMinutes: 1, staleAdverseMinutes: 2, staleBlockMinutes: 3 } });
    expect((await run(inputs(), strict, minutesAfter(4))).verdict).toBe("BLOCKING");
    const lax = rules({ signal: { staleCautionMinutes: 600, staleAdverseMinutes: 700, staleBlockMinutes: 800 } });
    expect((await run(inputs(), lax, minutesAfter(500))).verdict).toBe("SUPPORTIVE");
  });
  it("a signal time in the future is an impossible timestamp (BLOCKING), within the tolerance it is fine; an unknown time is a CAUTION, never guessed", async () => {
    expect(codesOf(await run(inputs(), rules(), minutesAfter(-30)))).toContain("SIGNAL_TIME_IN_FUTURE");
    expect((await run(inputs(), rules(), minutesAfter(-3))).verdict).toBe("SUPPORTIVE");
    const unknown = await run(inputs({ sc: { signalTimestamp: null } }));
    expect(unknown).toMatchObject({ verdict: "CAUTION" });
    expect(codesOf(unknown)).toContain("SIGNAL_TIME_UNKNOWN");
  });
});

describe("Signal Integrity Agent: revisions and source intelligence", () => {
  it.each<[string, InputOverrides, string, string]>([
    ["a superseded message", { rev: { state: "superseded", otherVersions: 1 } }, "BLOCKING", "REVISION_SUPERSEDED"],
    ["an ambiguous revision (default BLOCKING)", { rev: { state: "ambiguous", otherVersions: 1 } }, "BLOCKING", "REVISION_AMBIGUOUS"],
    ["an ambiguous sibling revision", { rev: { anyAmbiguous: true, otherVersions: 2 } }, "BLOCKING", "REVISION_GROUP_AMBIGUOUS"],
    ["an earlier version with different levels (this is the current one)", { rev: { levelsChanged: true, otherVersions: 1 } }, "CAUTION", "EDITED_LEVELS_CHANGED"],
    ["a message that is not linked to a stored message", { sc: { messageLinked: false }, rev: { known: false, state: "unknown" } }, "CAUTION", "REVISION_STATE_UNKNOWN"],
  ])("%s -> %s", async (_n, over, verdict, code) => {
    const r = await run(inputs(over));
    expect(r.verdict).toBe(verdict);
    expect(codesOf(r)).toContain(code);
  });
  it("conflicting revisions that are not the current one are ADVERSE; the ambiguous-revision severity is configurable", async () => {
    expect(codesOf(await run(inputs({ rev: { levelsChanged: true, state: "unknown", known: true, otherVersions: 1 } })))).toContain("CONFLICTING_REVISIONS");
    const r = await run(inputs({ rev: { state: "ambiguous", otherVersions: 1 } }), rules({ signal: { ambiguousRevision: "ADVERSE" } }));
    expect(r.verdict).toBe("ADVERSE");
  });
  it.each<[string, InputOverrides, string, string]>([
    ["source intelligence not recorded", { si: null }, "CAUTION", "SOURCE_INTELLIGENCE_NOT_RECORDED"],
    ["source intelligence unavailable", { si: { status: "UNAVAILABLE", reasonCode: "SOURCE_INTELLIGENCE_UNAVAILABLE" } }, "CAUTION", "SOURCE_INTELLIGENCE_UNAVAILABLE"],
    ["intelligence 'valid' with an UNKNOWN trust tier", { si: { trust: { tier: "UNKNOWN" } } }, "ADVERSE", "SOURCE_INTELLIGENCE_INCONSISTENT"],
    ["intelligence 'valid' with an UNKNOWN confidence", { si: { confidence: { tier: "UNKNOWN" } } }, "ADVERSE", "SOURCE_INTELLIGENCE_INCONSISTENT"],
    ["intelligence dated after the signal (point-in-time violation)", { si: { asOf: "2025-01-06T05:00:00.000Z" } }, "ADVERSE", "SOURCE_INTELLIGENCE_AFTER_SIGNAL"],
  ])("%s -> %s", async (_n, over, verdict, code) => {
    const r = await run(inputs(over));
    expect(r.verdict).toBe(verdict);
    expect(codesOf(r)).toContain(code);
  });
  it("the worst finding decides the verdict (BLOCKING over ADVERSE over CAUTION)", async () => {
    const r = await run(inputs({ rd: { targets: [] , stopLoss: 105 }, si: null }));
    expect(r.verdict).toBe("BLOCKING");
    expect(r.findings[0]?.severity).toBe("CRITICAL"); // most severe first
  });
});

describe("Signal Integrity Agent: input handling", () => {
  it("a missing REQUIRED input skips the agent (the orchestrator never runs it on a guess)", async () => {
    const r = await run(inputs({ slv: null }));
    expect(r).toMatchObject({ status: "SKIPPED", errorCode: "MISSING_REQUIRED_INPUT", verdict: "UNAVAILABLE" });
  });
  it("sees only its declared inputs and no message text", async () => {
    const r = await run(inputs());
    expect(Object.keys(r.inputSnapshot).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    expect(JSON.stringify([r.inputSnapshot, r.outputSnapshot, r.findings])).not.toMatch(/rawText|raw_text|message text/i);
  });
});
