import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, synthesize, SYNTHESIS_ALGORITHM_VERSION, type SynthesisInput } from "../../../packages/agents/src/index";

type A = SynthesisInput["agents"][number];
const agent = (id: string, over: Partial<A> = {}): A => ({ agentId: id, agentVersion: "1.0.0", weight: 50, canBlock: false, advisoryOnly: false, required: false, status: "COMPLETED", verdict: "NEUTRAL", confidence: 100, findings: [], outputSha256: "0".repeat(64), errorCode: null, ...over });
const input = (agents: A[], over: Partial<SynthesisInput> = {}): SynthesisInput => ({
  algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 2, thresholds: { supportiveMin: 0.35, neutralMin: -0.15, cautionMin: -0.5, adverseVetoWeight: 50 }, requiredAgents: [], agents, ...over,
});
const f = (code: string, severity = "MEDIUM") => ({ code, severity });

describe("synthesis output (research-synthesis-v2): completeness", () => {
  it("carries the per-agent summary, the reasons by class, the score breakdown, the threshold evaluation and the halt decision, and still never grants approval", () => {
    const s = synthesize(input([
      agent("agent_s", { verdict: "SUPPORTIVE", confidence: 80, findings: [f("ALL_GOOD", "INFO")] }), agent("agent_c", { verdict: "CAUTION", confidence: 60, weight: 30, findings: [f("STALE_DATA"), f("NOTE", "INFO")] }),
      agent("agent_n", { weight: 20 }), agent("agent_u", { status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "NO_DATA" }),
    ]));
    expect(s.algorithmVersion).toBe("research-synthesis-v2"); expect(s.grantsApproval).toBe(false);
    expect(Object.keys(s).sort()).toEqual(["advisory", "agentSummaries", "algorithmVersion", "assessment", "blockers", "contributions", "grantsApproval", "halt", "inputSha256", "missingRequired", "notes", "reasons", "score", "scoreBreakdown", "thresholdEvaluation", "unavailableOptional"]);
    expect(s.agentSummaries.map((a) => [a.agentId, a.verdict, a.scored, a.reasonCodes])).toEqual([["agent_s", "SUPPORTIVE", true, []], ["agent_c", "CAUTION", true, ["STALE_DATA"]], ["agent_n", "NEUTRAL", true, []], ["agent_u", "UNAVAILABLE", false, ["NO_DATA"]]]);
    expect(s.reasons.caution).toEqual([{ agentId: "agent_c", verdict: "CAUTION", weight: 30, confidence: 60, findingCodes: ["STALE_DATA"], counted: false }]);
    expect(s.reasons.neutral.map((r) => r.agentId)).toEqual(["agent_s", "agent_n"]);
    expect(s.reasons.unavailable).toEqual([{ agentId: "agent_u", status: "UNAVAILABLE", errorCode: "NO_DATA", required: false }]);
    expect(s.reasons.blocking).toEqual([]); expect(s.reasons.adverse).toEqual([]);
  });
  it("the weighted score breakdown shows every term of the formula", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "SUPPORTIVE", confidence: 80, weight: 60 }), agent("agent_b", { verdict: "CAUTION", confidence: 50, weight: 40 })]));
    // 60 x 0.8 x 1 = 48; 40 x 0.5 x -0.5 = -10; sum 38 / 100 = 0.38
    expect(s.scoreBreakdown).toMatchObject({ formula: "score = sum(weight x confidence/100 x verdictScore) / sum(weight)", totalWeight: 100, weightedSum: 38, score: 0.38, verdictScores: { SUPPORTIVE: 1, NEUTRAL: 0, CAUTION: -0.5, ADVERSE: -1 } });
    expect(s.scoreBreakdown.rows).toEqual([
      { agentId: "agent_a", weight: 60, weightShare: 0.6, confidence: 80, verdict: "SUPPORTIVE", verdictScore: 1, contribution: 48 },
      { agentId: "agent_b", weight: 40, weightShare: 0.4, confidence: 50, verdict: "CAUTION", verdictScore: -0.5, contribution: -10 },
    ]);
    expect(s.score).toBe(0.38); expect(s.assessment).toBe("RESEARCH_SUPPORTIVE");
    expect(s.contributions.map((c) => c.contribution)).toEqual(s.scoreBreakdown.rows.map((r) => r.contribution)); // the legacy field agrees
  });
  it("nothing scored gives a null score and empty rows", () => {
    const s = synthesize(input([agent("agent_a", { advisoryOnly: true })]));
    expect(s.scoreBreakdown).toMatchObject({ totalWeight: 0, weightedSum: 0, score: null, rows: [] });
  });
  it("the threshold evaluation lists the rules in order with the thresholds, values and which one decided", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "CAUTION" }), agent("agent_b")]));
    expect(s.assessment).toBe("RESEARCH_CAUTION");
    expect(s.thresholdEvaluation.decidedBy).toBe("WEIGHTED_SCORE");
    expect(s.thresholdEvaluation.thresholds).toEqual({ supportiveMin: 0.35, neutralMin: -0.15, cautionMin: -0.5, adverseVetoWeight: 50 });
    expect(s.thresholdEvaluation.checks.map((c) => [c.rule, c.met, c.reached])).toEqual([
      ["blocking_verdict", false, true], ["required_agent_result", false, true], ["scoring_result_exists", false, true], ["adverse_veto", false, true],
      ["score_supportive_min", false, true], ["score_neutral_min", false, true], ["score_caution_min", true, true], ["score_below_caution_min", false, true],
    ]);
    expect(s.thresholdEvaluation.checks.find((c) => c.rule === "score_caution_min")).toMatchObject({ assessmentIfMet: "RESEARCH_CAUTION", threshold: -0.5, value: -0.25 });
  });
});

describe("synthesis output: the rule order is unchanged (blocking, incomplete, adverse veto, weighted mean) and each decision is explained", () => {
  it("a BLOCKING verdict wins over missing data and an adverse veto; the blocking reason lists the agent and its codes", () => {
    const s = synthesize(input([agent("agent_b", { verdict: "BLOCKING", canBlock: true, findings: [f("HARD_STOP", "CRITICAL")] }), agent("agent_c", { required: true, status: "FAILED", verdict: "UNAVAILABLE", confidence: null, errorCode: "BOOM" }), agent("agent_v", { verdict: "ADVERSE" })], { requiredAgents: ["agent_c"] }));
    expect(s.assessment).toBe("RESEARCH_BLOCKED"); expect(s.thresholdEvaluation.decidedBy).toBe("BLOCKING_VERDICT");
    expect(s.reasons.blocking).toEqual([{ agentId: "agent_b", verdict: "BLOCKING", weight: 50, confidence: 100, findingCodes: ["HARD_STOP"], counted: true }]);
    expect(s.halt).toMatchObject({ halt: true, reasonCode: "HALT_BLOCKING_VERDICT", assessment: "RESEARCH_BLOCKED" });
    expect(s.halt.reason).toBe("The flow halts: RESEARCH_BLOCKED was decided by a COMPLETED BLOCKING verdict from an agent that may block (agent_b).");
    expect(s.thresholdEvaluation.checks.filter((c) => c.reached).map((c) => c.rule)).toEqual(["blocking_verdict"]);
  });
  it("a BLOCKING verdict from an agent that cannot block is listed but not counted", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "BLOCKING", canBlock: false }), agent("agent_b", { verdict: "SUPPORTIVE" })]));
    expect(s.assessment).toBe("RESEARCH_SUPPORTIVE"); expect(s.reasons.blocking[0]).toMatchObject({ agentId: "agent_a", counted: false }); expect(s.halt.halt).toBe(false);
  });
  it("a missing required agent = INCOMPLETE with the unavailable reason and a halt reason naming it", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "SUPPORTIVE" }), agent("agent_c", { required: true, status: "TIMEOUT", verdict: "UNAVAILABLE", confidence: null, errorCode: "AGENT_TIMEOUT" })], { requiredAgents: ["agent_c"] }));
    expect(s.assessment).toBe("RESEARCH_INCOMPLETE"); expect(s.thresholdEvaluation.decidedBy).toBe("REQUIRED_AGENT_MISSING");
    expect(s.reasons.unavailable).toEqual([{ agentId: "agent_c", status: "TIMEOUT", errorCode: "AGENT_TIMEOUT", required: true }]);
    expect(s.halt).toMatchObject({ halt: true, reasonCode: "HALT_REQUIRED_AGENT_MISSING" }); expect(s.halt.reason).toContain("agent_c");
  });
  it("no scoring result at all = INCOMPLETE (NO_SCORING_RESULTS)", () => {
    const s = synthesize(input([agent("agent_a", { advisoryOnly: true })]));
    expect(s.assessment).toBe("RESEARCH_INCOMPLETE"); expect(s.halt.reasonCode).toBe("HALT_NO_SCORING_RESULTS");
  });
  it("an ADVERSE verdict at or above the veto weight = ADVERSE regardless of the mean; the veto check shows the weight", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "ADVERSE", weight: 50, confidence: 10, findings: [f("BAD_THING", "HIGH")] }), agent("agent_b", { verdict: "SUPPORTIVE", weight: 100 })]));
    expect(s.assessment).toBe("RESEARCH_ADVERSE"); expect(s.thresholdEvaluation.decidedBy).toBe("ADVERSE_VETO");
    expect(s.thresholdEvaluation.checks.find((c) => c.rule === "adverse_veto")).toMatchObject({ met: true, threshold: 50, value: 50 });
    expect(s.thresholdEvaluation.checks.filter((c) => c.rule.startsWith("score_")).every((c) => !c.reached)).toBe(true); // the weighted mean was never reached
    expect(s.reasons.adverse).toEqual([{ agentId: "agent_a", verdict: "ADVERSE", weight: 50, confidence: 10, findingCodes: ["BAD_THING"], counted: false }]);
    expect(s.halt).toMatchObject({ halt: true, reasonCode: "HALT_ADVERSE_VETO" });
  });
  it("an ADVERSE assessment by the weighted mean (below the veto weight) says so", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "ADVERSE", weight: 40 }), agent("agent_b", { verdict: "CAUTION", weight: 40 })]));
    expect(s.assessment).toBe("RESEARCH_ADVERSE"); expect(s.thresholdEvaluation.decidedBy).toBe("WEIGHTED_SCORE");
    expect(s.thresholdEvaluation.checks.find((c) => c.rule === "score_below_caution_min")).toMatchObject({ met: true, value: -0.75 });
    expect(s.halt).toMatchObject({ halt: true, reasonCode: "HALT_WEIGHTED_SCORE" }); expect(s.halt.reason).toContain("score -0.75");
  });
  it.each([["RESEARCH_SUPPORTIVE", "SUPPORTIVE"], ["RESEARCH_NEUTRAL", "NEUTRAL"], ["RESEARCH_CAUTION", "CAUTION"]] as const)("%s does not halt by default and the reason says every later gate still runs", (assessment, verdict) => {
    const s = synthesize(input([agent("agent_a", { verdict })]));
    expect(s.assessment).toBe(assessment); expect(s.halt).toMatchObject({ halt: false, reasonCode: "NO_HALT", haltOn: ["RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE", "RESEARCH_ADVERSE"] });
    expect(s.halt.reason).toContain("every later gate still runs");
  });
  it("the configured halt list decides the halt (and is part of the explanation); the assessment itself is unchanged", () => {
    const s = synthesize(input([agent("agent_a", { verdict: "CAUTION" })], { haltOn: ["RESEARCH_CAUTION", "RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE", "RESEARCH_ADVERSE"] }));
    expect(s.assessment).toBe("RESEARCH_CAUTION"); expect(s.halt).toMatchObject({ halt: true, reasonCode: "HALT_WEIGHTED_SCORE" });
    const none = synthesize(input([agent("agent_a", { verdict: "ADVERSE", weight: 60 })], { haltOn: [] }));
    expect(none.assessment).toBe("RESEARCH_ADVERSE"); expect(none.halt.halt).toBe(false); expect(none.halt.reason).toContain("empty");
  });
  it("the default halt list equals the engine's default configuration", () => {
    const s = synthesize(input([agent("agent_a")]));
    expect(s.halt.haltOn).toEqual(DEFAULT_AGENT_CONFIG.haltOn);
  });
  it("is deterministic and independent of the order of the agents", () => {
    const a = [agent("agent_a", { verdict: "SUPPORTIVE" }), agent("agent_b", { verdict: "CAUTION", findings: [f("X")] }), agent("agent_c", { status: "FAILED", verdict: "UNAVAILABLE", confidence: null, errorCode: "E" })];
    expect(JSON.stringify(synthesize(input(a)))).toBe(JSON.stringify(synthesize(input(a))));
    expect(synthesize(input([...a].reverse())).assessment).toBe(synthesize(input(a)).assessment);
  });
  it("finding codes are capped, de-duplicated and exclude INFO; free text never appears", () => {
    const many = Array.from({ length: 15 }, (_, i) => f(`CODE_${i}`));
    const s = synthesize(input([agent("agent_a", { verdict: "CAUTION", findings: [...many, f("CODE_0"), f("INFO_ONLY", "INFO")] })]));
    expect(s.reasons.caution[0]?.findingCodes).toHaveLength(10); expect(JSON.stringify(s)).not.toContain("INFO_ONLY");
  });
});
