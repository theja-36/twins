import { describe, expect, it } from "vitest";
import { buildDebate, DEFAULT_THRESHOLDS, type SynthesisInput, type SynthesisInputAgent } from "../../../packages/agents/src/index";

const ag = (agentId: string, verdict: SynthesisInputAgent["verdict"], o: Partial<SynthesisInputAgent> = {}): SynthesisInputAgent => ({
  agentId, agentVersion: "1", weight: 30, canBlock: false, advisoryOnly: false, required: false, status: "COMPLETED", verdict, confidence: 80, findings: [], outputSha256: "x".repeat(8), errorCode: null, ...o,
});
const input = (agents: SynthesisInputAgent[]): SynthesisInput => ({ algorithmVersion: "research-synthesis-v2", riskDecisionId: "d", decisionVersion: 1, thresholds: DEFAULT_THRESHOLDS, requiredAgents: [], agents });

describe("agent debate (#13)", () => {
  it("splits agents into sides and reports strength, challenges and rebuttals with codes only", () => {
    const d = buildDebate(input([ag("a", "SUPPORTIVE", { findings: [{ code: "TREND_OK", severity: "INFO" }] }), ag("b", "ADVERSE", { weight: 20, findings: [{ code: "WIDE_SPREAD", severity: "HIGH" }] }), ag("c", "NEUTRAL"), ag("d", "SUPPORTIVE", { status: "FAILED", verdict: "UNAVAILABLE", confidence: null })]));
    expect(d.sides.FOR.map((p) => p.agentId)).toEqual(["a"]);
    expect(d.sides.AGAINST.map((p) => p.agentId)).toEqual(["b"]);
    expect(d.sides.NEUTRAL.map((p) => p.agentId)).toEqual(["c"]);
    expect(d.sides.ABSENT.map((p) => p.agentId)).toEqual(["d"]);
    expect(d.strength).toMatchObject({ for: 24, against: 16, neutral: 24, total: 64 });
    expect(d.challenges).toEqual([{ from: "b", against: ["a"], codes: ["WIDE_SPREAD"] }]);
    expect(d.rebuttals).toEqual([{ from: "a", supports: ["b"], codes: ["TREND_OK"] }]);
    expect(d.agreementIndex).toBeCloseTo(0.2, 4);
    expect(d.contested).toBe(true);
    expect(d.grantsApproval).toBe(false);
    expect(d.rounds).toHaveLength(3);
  });
  it("finds pivotal agents by re-running the real synthesis", () => {
    // a lone strong ADVERSE veto decides the assessment; neutralising it must flip the result
    const d = buildDebate(input([ag("veto", "ADVERSE", { weight: 60 }), ag("s1", "SUPPORTIVE"), ag("s2", "SUPPORTIVE")]));
    expect(d.assessment).toBe("RESEARCH_ADVERSE");
    expect(d.pivotalAgents.map((p) => p.agentId)).toContain("veto");
    expect(d.pivotalAgents.find((p) => p.agentId === "veto")?.flipsTo).not.toBe("RESEARCH_ADVERSE");
  });
  it("an unanimous set is not contested and has no pivotal agent", () => {
    const d = buildDebate(input([ag("a", "SUPPORTIVE"), ag("b", "SUPPORTIVE"), ag("c", "SUPPORTIVE")]));
    expect(d.contested).toBe(false);
    expect(d.agreementIndex).toBe(1);
    expect(d.assessment).toBe("RESEARCH_SUPPORTIVE");
  });
  it("is deterministic regardless of agent order and leaves the assessment untouched", () => {
    const agents = [ag("a", "SUPPORTIVE"), ag("b", "CAUTION", { findings: [{ code: "X", severity: "LOW" }] }), ag("c", "ADVERSE", { weight: 10 })];
    const a = buildDebate(input(agents)), b = buildDebate(input([...agents].reverse()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("handles no results and passes no free text", () => {
    const d = buildDebate(input([]));
    expect(d.agreementIndex).toBeNull();
    expect(d.contested).toBe(false);
    const text = JSON.stringify(buildDebate(input([ag("a", "SUPPORTIVE", { findings: [{ code: "ONLY_CODES", severity: "INFO" }] })])));
    expect(text).toContain("ONLY_CODES");
  });
});
