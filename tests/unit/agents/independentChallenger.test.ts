import { describe, expect, it } from "vitest";
import { independentChallengerAgent, INDEPENDENT_CHALLENGER_AGENT_ID, type AgentDefinition, type AgentFinding, type AgentRulesConfig, type AgentVerdict } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW, optionInputs } from "../../support/agentFixtures";
import { rulesWithHistory } from "../../support/historicalFixtures";

interface Fake { id: string; verdict: AgentVerdict; confidence?: number; evidence?: boolean; direction?: string; out?: Record<string, number | string | boolean | string[]>; findings?: AgentFinding[]; applicable?: boolean }
/** A fake research agent returning a fixed result (so the challenger can be tested against exact upstream evidence). */
const fake = (f: Fake): AgentDefinition => ({
  contract: {
    agentId: f.id, agentName: f.id, version: "1.0.0", requiredInputs: ["risk_decision"], optionalInputs: [],
    outputSchema: { fields: { checksRun: { type: "number", required: true }, blockingCount: { type: "number", required: true }, adverseCount: { type: "number", required: true }, cautionCount: { type: "number", required: true }, failedCodes: { type: "string[]", required: true }, truncatedFindings: { type: "boolean", required: true }, direction: { type: "string" }, applicable: { type: "boolean" } } },
    timeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  },
  async run() {
    return { verdict: f.verdict, confidence: f.confidence ?? 85, findings: f.findings ?? [], evidence: f.evidence === false ? [] : [{ kind: "risk_decision", ref: `risk_decision:${f.id}` }],
      output: { checksRun: 1, blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false, ...(f.direction ? { direction: f.direction } : {}), ...(f.applicable === false ? { applicable: false } : {}), ...f.out } };
  },
});
const run = async (fakes: Fake[], inp: Record<string, unknown> = inputs(), rules: AgentRulesConfig = rulesWithHistory()) => {
  const ch = independentChallengerAgent(rules, fakes.map((f) => f.id));
  return (await evalAgents([...fakes.map(fake), ch], inp, {}, [], NOW)).byId(INDEPENDENT_CHALLENGER_AGENT_ID);
};
const S = (id: string, o: Partial<Fake> = {}): Fake => ({ id, verdict: "SUPPORTIVE", ...o });
const three = [S("agent-a-v1"), S("agent-b-v1"), S("agent-c-v1")];
const finding = (code: string): AgentFinding => ({ code, severity: "MEDIUM", summary: "x" });
const inpWith = (rd: Record<string, unknown> = {}, o: Parameters<typeof inputs>[0] = {}) => inputs({ ...o, rd });

describe("Independent Challenger Agent: assessment", () => {
  it("no contradictions and enough supportive evidence = SUPPORTIVE with the tallies summarised", async () => {
    const r = await run([...three, { id: "agent-d-v1", verdict: "NEUTRAL" }]);
    expect(r).toMatchObject({ agentId: "independent-challenger-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(r.outputSnapshot).toMatchObject({ expectedDirection: "BULLISH", dependencyCount: 4, assessedCount: 4, supportiveAgents: 3, neutralAgents: 1, cautionAgents: 0, adverseAgents: 0, blockingAgents: 0, adverseWeightShare: 0, rewardRisk: 1, failedCodes: [] });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "agent_result"]));
  });
  it("too little support, with nothing wrong = NEUTRAL (never SUPPORTIVE)", async () => {
    expect(await run([S("agent-a-v1"), S("agent-b-v1")])).toMatchObject({ verdict: "NEUTRAL", confidence: 70 });
    expect((await run([S("agent-a-v1"), { id: "agent-b-v1", verdict: "NEUTRAL" }, { id: "agent-c-v1", verdict: "NEUTRAL" }, { id: "agent-d-v1", verdict: "NEUTRAL" }])).verdict).toBe("CAUTION"); // thin evidence
  });
  it("an agent contradiction = CAUTION (a supportive result against an adverse one)", async () => {
    const r = await run([...three, { id: "agent-d-v1", verdict: "ADVERSE", confidence: 60 }]);
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("AGENT_CONTRADICTION"); expect(r.outputSnapshot["adverseAgents"]).toBe(1);
  });
  it("a critical contradiction (two high-confidence SUPPORTIVE against two ADVERSE / BLOCKING) = BLOCKING; ADVERSE when configured", async () => {
    const fakes: Fake[] = [S("agent-a-v1", { confidence: 90 }), S("agent-b-v1", { confidence: 85 }), { id: "agent-c-v1", verdict: "ADVERSE", confidence: 70 }, { id: "agent-d-v1", verdict: "BLOCKING", confidence: 100 }];
    const r = await run(fakes); expect(r.verdict).toBe("BLOCKING"); expect(codesOf(r)).toContain("CRITICAL_CONTRADICTION");
    expect((await run(fakes, inputs(), rulesWithHistory({ challenger: { criticalSeverity: "ADVERSE" } }))).verdict).toBe("ADVERSE");
    expect(codesOf(await run([S("agent-a-v1", { confidence: 60 }), S("agent-b-v1", { confidence: 60 }), { id: "agent-c-v1", verdict: "ADVERSE" }, { id: "agent-d-v1", verdict: "ADVERSE" }]))).not.toContain("CRITICAL_CONTRADICTION"); // low-confidence support is not critical
  });
  it("unsupported assumptions: SUPPORTIVE without evidence = CAUTION; SUPPORTIVE whose own output records adverse findings = BLOCKING", async () => {
    const a = await run([...three.slice(0, 2), S("agent-c-v1", { evidence: false })]); expect(a.verdict).toBe("CAUTION"); expect(codesOf(a)).toContain("SUPPORT_WITHOUT_EVIDENCE");
    const b = await run([...three.slice(0, 2), S("agent-c-v1", { out: { adverseCount: 2 } })]); expect(b.verdict).toBe("BLOCKING"); expect(codesOf(b)).toContain("UNSUPPORTED_CLAIM");
    expect(codesOf(await run([...three.slice(0, 2), S("agent-c-v1", { out: { blockingCount: 1 } })]))).toContain("UNSUPPORTED_CLAIM");
  });
  it("missing evidence: no source intelligence, an invalid one, no signal context, thin evidence", async () => {
    expect(codesOf(await run(three, inputs({ si: null })))).toContain("SOURCE_INTELLIGENCE_MISSING");
    const inv = await run(three, inputs({ si: { status: "INVALID" } })); expect(inv.verdict).toBe("CAUTION"); expect(codesOf(inv)).toContain("SOURCE_INTELLIGENCE_NOT_VALID");
    const base = inputs() as Record<string, unknown>; base["signal_context"] = null;
    expect(codesOf(await run(three, base))).toContain("SIGNAL_CONTEXT_MISSING");
    const thin = await run([S("agent-a-v1"), ...["b", "c", "d"].map((x) => ({ id: `agent-${x}-v1`, verdict: "NEUTRAL" as const }))]); expect(codesOf(thin)).toContain("THIN_EVIDENCE");
  });
  it("overconfidence: high source confidence while many agents are CAUTION / ADVERSE = CAUTION", async () => {
    const mixed: Fake[] = [S("agent-a-v1"), S("agent-b-v1"), { id: "agent-c-v1", verdict: "CAUTION" }, { id: "agent-d-v1", verdict: "CAUTION" }];
    const hi = await run(mixed, inputs({ si: { confidence: { tier: "HIGH", score: 80 } } })); expect(codesOf(hi)).toContain("OVERCONFIDENT_SOURCE");
    expect(codesOf(await run(mixed, inputs({ si: { confidence: { tier: "LOW", score: 20 } } })))).not.toContain("OVERCONFIDENT_SOURCE");
    expect(codesOf(await run(three, inputs({ si: { confidence: { tier: "HIGH", score: 90 } } })))).not.toContain("OVERCONFIDENT_SOURCE");
  });
  it("risk/reward coherence: 0.4 = ADVERSE, 0.8 = CAUTION, a target on the wrong side = BLOCKING, no target = CAUTION", async () => {
    const poor = await run(three, inpWith({ targets: [102] })); expect(poor.verdict).toBe("ADVERSE"); expect(codesOf(poor)).toContain("REWARD_RISK_POOR");
    const low = await run(three, inpWith({ targets: [104] })); expect(low.verdict).toBe("CAUTION"); expect(codesOf(low)).toContain("REWARD_RISK_LOW");
    const wrong = await run(three, inpWith({ targets: [98] })); expect(wrong.verdict).toBe("BLOCKING"); expect(codesOf(wrong)).toContain("TARGET_INCOHERENT");
    expect(codesOf(await run(three, inpWith({ targets: [] })))).toContain("NO_TARGETS");
    expect((await run(three, inpWith({ targets: [104] }), rulesWithHistory({ challenger: { minRewardRisk: 0.7 } }))).verdict).toBe("SUPPORTIVE");
  });
  it("stop-loss coherence: wrong side = BLOCKING, validation missing = CAUTION, not VALID = BLOCKING, risk mismatch = CAUTION, severity configurable", async () => {
    const wrong = await run(three, inpWith({ stopLoss: 105 })); expect(wrong.verdict).toBe("BLOCKING"); expect(codesOf(wrong)).toContain("STOP_LOSS_INCOHERENT");
    expect((await run(three, inpWith({ stopLoss: 105 }), rulesWithHistory({ challenger: { incoherenceSeverity: "ADVERSE" } }))).verdict).toBe("ADVERSE");
    const missing = await run(three, inputs({ slv: null })); expect(missing.verdict).toBe("CAUTION"); expect(codesOf(missing)).toContain("STOP_VALIDATION_MISSING");
    const inv = await run(three, inputs({ slv: { result: "INVALID" } })); expect(inv.verdict).toBe("BLOCKING"); expect(codesOf(inv)).toContain("STOP_LOSS_NOT_VALID");
    const mism = await run(three, inputs({ slv: { riskPct: 9 } })); expect(mism.verdict).toBe("CAUTION"); expect(codesOf(mism)).toContain("STOP_RISK_PCT_MISMATCH");
    expect(codesOf(await run(three, inputs({ slv: { riskPct: 5.5 } })))).not.toContain("STOP_RISK_PCT_MISMATCH"); // within the tolerance
    expect(codesOf(await run(three, inpWith({ entryPrice: null })))).toContain("LEVELS_INCOMPLETE");
  });
  it("direction coherence: an agent that recorded a different direction = BLOCKING; options use the option type; an unknown direction cautions", async () => {
    const off = await run([S("agent-a-v1", { direction: "BULLISH" }), S("agent-b-v1", { direction: "BEARISH" }), S("agent-c-v1")]); expect(off.verdict).toBe("BLOCKING"); expect(codesOf(off)).toContain("DIRECTION_INCOHERENT");
    expect((await run([S("agent-a-v1", { direction: "BULLISH" }), S("agent-b-v1", { direction: "BULLISH" }), S("agent-c-v1")])).verdict).toBe("SUPPORTIVE");
    const pe = optionInputs({ rd: { optionType: "PE" } });
    expect((await run([S("agent-a-v1", { direction: "BEARISH" }), S("agent-b-v1"), S("agent-c-v1")], pe)).outputSnapshot["expectedDirection"]).toBe("BEARISH");
    expect(codesOf(await run([S("agent-a-v1", { direction: "BULLISH" }), S("agent-b-v1"), S("agent-c-v1")], pe))).toContain("DIRECTION_INCOHERENT");
    const unk = await run(three, inpWith({ side: "HOLD" })); expect(codesOf(unk)).toContain("DIRECTION_UNKNOWN");
  });
  it("data quality across the agents: several stale / missing / unusable findings = CAUTION, many = ADVERSE (INFO findings do not count)", async () => {
    const dq = (n: number): Fake[] => [S("agent-a-v1", { findings: Array.from({ length: n }, (_, i) => finding(`X${i}_STALE`)) }), S("agent-b-v1"), S("agent-c-v1")];
    expect(codesOf(await run(dq(2)))).not.toContain("DATA_QUALITY_ISSUES");
    const c = await run(dq(3)); expect(c.verdict).toBe("CAUTION"); expect(codesOf(c)).toContain("DATA_QUALITY_ISSUES");
    const a = await run(dq(6)); expect(a.verdict).toBe("ADVERSE"); expect(codesOf(a)).toContain("DATA_QUALITY_POOR");
    expect(codesOf(await run([S("agent-a-v1", { findings: Array.from({ length: 8 }, (_, i) => ({ code: `X${i}_STALE`, severity: "INFO" as const, summary: "x" })) }), S("agent-b-v1"), S("agent-c-v1")]))).not.toContain("DATA_QUALITY_POOR");
  });
  it("adverse evidence weight: 30% = CAUTION, 50% = ADVERSE (confidence-weighted)", async () => {
    const c = await run([S("agent-a-v1", { confidence: 90 }), S("agent-b-v1", { confidence: 90 }), S("agent-c-v1", { confidence: 90 }), { id: "agent-d-v1", verdict: "ADVERSE", confidence: 90 }]);
    expect(c.outputSnapshot["adverseWeightShare"]).toBe(0.25);
    const d = await run([S("agent-a-v1", { confidence: 90 }), S("agent-b-v1", { confidence: 90 }), { id: "agent-c-v1", verdict: "ADVERSE", confidence: 90 }]); expect(codesOf(d)).toContain("ADVERSE_EVIDENCE_SHARE");
    const e = await run([S("agent-a-v1", { confidence: 60 }), { id: "agent-b-v1", verdict: "ADVERSE", confidence: 90 }]); expect(e.verdict).toBe("ADVERSE"); expect(codesOf(e)).toContain("ADVERSE_EVIDENCE_WEIGHT");
  });
  it("agents that are not applicable are not counted", async () => {
    const r = await run([...three, { id: "agent-d-v1", verdict: "NEUTRAL", applicable: false }]);
    expect(r.verdict).toBe("SUPPORTIVE"); expect(r.outputSnapshot).toMatchObject({ dependencyCount: 4, assessedCount: 3, neutralAgents: 0 });
  });
});

describe("Independent Challenger Agent: absent summaries", () => {
  it("a dependency that did not complete SKIPS the challenger (it never reasons over missing results)", async () => {
    const dead: AgentDefinition = { ...fake(S("agent-z-v1")), async run() { const { AgentUnavailableError } = await import("../../../packages/agents/src/index"); throw new AgentUnavailableError("NO_DATA", "no data SECRET-DETAIL"); } };
    const ch = independentChallengerAgent(rulesWithHistory(), ["agent-a-v1", "agent-z-v1"]);
    const out = await evalAgents([fake(S("agent-a-v1")), dead, ch], inputs(), {}, [], NOW);
    expect(out.byId("independent-challenger-v1")).toMatchObject({ status: "SKIPPED", errorCode: "DEPENDENCY_NOT_COMPLETED", verdict: "UNAVAILABLE" });
    expect(JSON.stringify(out.byId("independent-challenger-v1"))).not.toContain("SECRET-DETAIL");
  });
  it("with no dependency results at all it is UNAVAILABLE; a missing risk decision is UNAVAILABLE", async () => {
    const ch = independentChallengerAgent(rulesWithHistory(), []);
    expect((await evalAgents([ch], inputs(), {}, [], NOW)).byId("independent-challenger-v1")).toMatchObject({ status: "UNAVAILABLE", errorCode: "NO_AGENT_EVIDENCE" });
    const noRd = inputs() as Record<string, unknown>; noRd["risk_decision"] = null;
    expect((await evalAgents([ch], noRd, {}, [], NOW)).byId("independent-challenger-v1").status).toBe("SKIPPED");
  });
  it("a challenger that depends on an unregistered or disabled agent refuses to run (a mis-wired engine fails closed)", async () => {
    await expect(evalAgents([independentChallengerAgent(rulesWithHistory(), ["agent-missing-v1"])], inputs(), {}, [], NOW)).rejects.toMatchObject({ code: "DEPENDENCY_NOT_REGISTERED" });
  });
});

describe("Independent Challenger Agent: safety", () => {
  it("runs in a later level than its dependencies, receives only declared inputs, is deterministic and states evidence only", async () => {
    const inp = inputs(); const before = JSON.stringify(inp);
    const fakes: Fake[] = [...three, { id: "agent-d-v1", verdict: "ADVERSE" }];
    const a = await run(fakes, inp), b = await run(fakes, inp);
    expect(JSON.stringify(inp)).toBe(before);
    expect(JSON.stringify({ ...a, startedAt: 0, finishedAt: 0, durationMs: 0 })).toBe(JSON.stringify({ ...b, startedAt: 0, finishedAt: 0, durationMs: 0 }));
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|will|should|buy now|sell now)\b/i);
    expect(Object.keys(a.inputSnapshot).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
  });
  it("is a blocking-capable scoring agent with weight 30 and declares its dependencies (sorted)", () => {
    expect(independentChallengerAgent(rulesWithHistory(), ["b-v1", "a-v1"]).contract).toMatchObject({ agentId: "independent-challenger-v1", canBlock: true, advisoryOnly: false, weight: 30, dependsOn: ["a-v1", "b-v1"], requiredInputs: ["risk_decision"] });
  });
});
