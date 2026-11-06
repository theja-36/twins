import { describe, expect, it } from "vitest";
import { buildDecisionCard, DECISION_CARD_FORMAT, DEFAULT_AGENT_CONFIG, synthesize, SYNTHESIS_ALGORITHM_VERSION, type SynthesisInput } from "../../../packages/agents/src/index";

type A = SynthesisInput["agents"][number];
const agent = (id: string, over: Partial<A> = {}): A => ({ agentId: id, agentVersion: "1.0.0", weight: 50, canBlock: false, advisoryOnly: false, required: false, status: "COMPLETED", verdict: "NEUTRAL", confidence: 100, findings: [], outputSha256: "0".repeat(64), errorCode: null, ...over });
const synth = (agents: A[]) => synthesize({ algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 2, thresholds: DEFAULT_AGENT_CONFIG.thresholds, requiredAgents: [], agents });
const base = { riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 2, runId: "22222222-2222-4222-8222-222222222222" };
const f = (code: string, severity = "MEDIUM") => ({ code, severity });

describe("decision card (P0 #6)", () => {
  it("is built from the real synthesis shape, states the rule that decided, and never grants approval", () => {
    const s = synth([agent("agent_a", { verdict: "SUPPORTIVE", confidence: 80, weight: 60 }), agent("agent_b", { verdict: "CAUTION", confidence: 50, weight: 40, findings: [f("STALE_DATA")] })]);
    const c = buildDecisionCard({ ...base, synthesis: JSON.parse(JSON.stringify(s)) })!;
    expect(c.format).toBe(DECISION_CARD_FORMAT); expect(c.grantsApproval).toBe(false);
    expect(c.headline).toMatchObject({ assessment: s.assessment, decidedBy: s.thresholdEvaluation.decidedBy, score: s.score });
    expect(c.agents.map((a) => [a.agentId, a.verdict, a.reasonCodes])).toEqual([["agent_a", "SUPPORTIVE", []], ["agent_b", "CAUTION", ["STALE_DATA"]]]);
    expect(c.statements[0]).toContain(s.assessment); expect(c.statements.at(-1)).toBe("This card explains a research assessment. It is not an approval.");
  });
  it("lists blockers and agents with no result, marking required ones", () => {
    const s = synth([agent("agent_x", { verdict: "BLOCKING", canBlock: true, findings: [f("EXPIRED", "CRITICAL")] }), agent("agent_u", { status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "NO_DATA", required: true })]);
    const c = buildDecisionCard({ ...base, synthesis: JSON.parse(JSON.stringify(s)) })!;
    expect(c.blockers).toEqual([{ agentId: "agent_x", findingCodes: ["EXPIRED"] }]);
    expect(c.unavailable).toEqual([{ agentId: "agent_u", status: "UNAVAILABLE", errorCode: "NO_DATA", required: true }]);
    expect(c.statements.join(" ")).toContain("agent_u (required)");
  });
  it("reports a close call only for an evaluated score rule near its threshold, as plain arithmetic", () => {
    const t = DEFAULT_AGENT_CONFIG.thresholds.supportiveMin; // score just under the supportive minimum
    const w = 100, conf = Math.round((t - 0.05) * 100);
    const s = synth([agent("agent_a", { verdict: "SUPPORTIVE", confidence: conf, weight: w })]);
    const c = buildDecisionCard({ ...base, synthesis: JSON.parse(JSON.stringify(s)) })!;
    const cc = c.closeCalls.find((x) => x.rule === "score_supportive_min")!;
    expect(cc).toMatchObject({ threshold: t, met: false }); expect(cc.margin).toBeCloseTo(-0.05, 2);
    const far = buildDecisionCard({ ...base, synthesis: JSON.parse(JSON.stringify(synth([agent("agent_a", { verdict: "SUPPORTIVE", confidence: 100, weight: 100 })]))) })!;
    expect(far.closeCalls.find((x) => x.rule === "score_supportive_min")).toBeUndefined(); // margin 1 - threshold is wide
  });
  it("adds sizing facts and the unusable sources only when supplied, and says nothing about them otherwise", () => {
    const s = JSON.parse(JSON.stringify(synth([agent("agent_a")])));
    const bare = buildDecisionCard({ ...base, synthesis: s })!;
    expect(bare.sizing).toBeNull(); expect(bare.sourceHealth).toBeNull(); expect(bare.statements.join(" ")).not.toMatch(/Source health|Decision PENDING/);
    const full = buildDecisionCard({ ...base, synthesis: s, sizing: { status: "PENDING", reasonCode: "SIZED", quantity: 15, maxLossPercent: 0.5, riskReward: 2, trustTier: "MEDIUM" },
      sourceHealth: { overall: "FAILING", providers: [{ provider: "news", status: "FAILING", reasons: ["repeated_failures"], usable: false }, { provider: "calendar", status: "OK", reasons: [], usable: true }] } })!;
    expect(full.sourceHealth).toEqual({ overall: "FAILING", notUsable: [{ provider: "news", status: "FAILING", reasons: ["repeated_failures"] }] });
    expect(full.statements.join(" ")).toContain("planned quantity 15"); expect(full.statements.join(" ")).toContain("news (FAILING)");
  });
  it("returns null for a malformed or missing synthesis, never an invented card", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { assessment: "RESEARCH_NEUTRAL" }, { assessment: "RESEARCH_NEUTRAL", thresholdEvaluation: { decidedBy: "WEIGHTED_SCORE" } }]) expect(buildDecisionCard({ ...base, synthesis: bad })).toBeNull();
  });
  it("copies no free text: only codes pass through, and an odd code is dropped", () => {
    const s = JSON.parse(JSON.stringify(synth([agent("agent_a", { findings: [f("OK_CODE")] })])));
    s.agentSummaries[0].reasonCodes = ["OK_CODE", "https://x.invalid/?api_token=SECRET", "has space"];
    const c = buildDecisionCard({ ...base, synthesis: s })!;
    expect(c.agents[0]!.reasonCodes).toEqual(["OK_CODE"]); expect(JSON.stringify(c)).not.toContain("SECRET");
  });
});
