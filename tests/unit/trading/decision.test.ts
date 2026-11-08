import { describe, expect, it } from "vitest";
import { buildApprovalCard, approvalNotification, decide, DEFAULT_DECISION_POLICY, loadDecisionConfig, type DecisionCandidate, type DecisionInput } from "../../../packages/decision/src/index";

const NOW = new Date("2031-01-06T05:00:00Z");
const cand: DecisionCandidate = { id: "c1", source: "INDEPENDENT", state: "READY_FOR_DECISION", underlying: "ACME", exchange: "NSE", strike: null, optionType: null, expiry: null, side: "BUY", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108], dataSource: "LIVE", expiresAt: new Date("2031-01-06T06:00:00Z"), setup: "BREAKOUT" };
const pkg = (o: Record<string, unknown> = {}) => ({ packageVersion: "research-package-v1", candidateId: "c1", candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 2, assessment: "RESEARCH_SUPPORTIVE", halt: false, haltReason: null, score: 0.5, synthesisAlgorithmVersion: "s", reports: [{}, {}], contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: {}, evidenceIndex: ["ev:1"], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b".repeat(8), ...o }) as never;
const sizing = (o: Record<string, unknown> = {}) => ({ modelVersion: "position-sizing-v2", status: "SIZED", reason: null, detail: "", lots: 10, quantity: 250, grossExposure: "25000.00", maxLossAtStop: "600.00", riskPerLot: "60.00", riskBudget: { binding: "risk_percent" }, ...o }) as never;
const reason = (code: string, severity: "BLOCK" | "RESTRICT" | "INFO", detail = code, correctiveAction: string | null = null) => ({ code, severity, detail, limit: null, value: null, correctiveAction, evidence: [] });
const risk = (verdict: string, reasons: ReturnType<typeof reason>[] = [], o: Record<string, unknown> = {}) => ({ engineVersion: "risk-assessment-v1", policyVersion: 3, verdict, reasons, correctiveActions: [], limits: {}, exposure: {}, sizeMultiplier: 1, caps: {}, evidence: ["spec:s1"], evaluatedAt: NOW.toISOString(), stop: {}, specs: {}, grantsApproval: false, ...o }) as never;
const input = (o: Partial<DecisionInput> = {}): DecisionInput => ({ now: NOW, candidate: cand, research: pkg(), researchPackageId: "p1", confidence: { id: "k1", score: 75, calibrationStatus: "UNCALIBRATED", completeness: 0.9, missing: [], caps: [] }, risk: risk("PASS"), riskAssessmentId: "r1", sizing: sizing(), simulationId: "s1", paperEnabled: true, ...o });

describe("decision outcomes", () => {
  it("QUALIFIED carries the permitted size, stop, targets, validity, versions and full provenance", () => {
    const d = decide(input());
    expect(d.outcome).toBe("QUALIFIED");
    expect(d.permittedSize).toMatchObject({ lots: 10, quantity: 250, maxLossAtStop: "600.00", binding: "risk_percent" });
    expect(d.stopLoss).toMatchObject({ level: 98, targets: [104, 108] }); expect(d.stopLoss.validation.result).toBe("VALID");
    expect(d.validFrom).toEqual(NOW); expect(d.validUntil.getTime()).toBe(NOW.getTime() + 15 * 60_000); expect(d.validityReason).toMatch(/15 minutes/);
    expect(d.versions).toMatchObject({ decisionEngine: "decision-engine-v1", stopLossRule: "stop-loss-v1", riskEngine: "risk-assessment-v1", sizingModel: "position-sizing-v2", riskPolicyVersion: "3" });
    expect(d.provenance).toMatchObject({ candidateId: "c1", candidateSource: "INDEPENDENT", dataSource: "LIVE", researchPackageId: "p1", confidenceAssessmentId: "k1", riskAssessmentId: "r1", simulationId: "s1" });
    expect(d.evidenceRefs).toEqual(expect.arrayContaining(["candidate:c1", "research_package:p1", "confidence:k1", "risk_assessment:r1", "simulation:s1", "spec:s1", "ev:1"]));
    expect(d.explanation.supporting.join(" ")).toMatch(/not a probability/); expect(d.explanation.expiry).toMatch(/valid until/);
    expect(d.grantsApproval).toBe(false);
    expect(d.explanation.invalidatedBy.join(" ")).toMatch(/stop-loss 98[\s\S]*candidate expiring[\s\S]*revalidation/);
  });
  it("the validity window never outlives the candidate", () => {
    const d = decide(input({ candidate: { ...cand, expiresAt: new Date(NOW.getTime() + 5 * 60_000) } }));
    expect(d.validUntil.getTime()).toBe(NOW.getTime() + 5 * 60_000); expect(d.validityReason).toMatch(/candidate expires first/);
  });
  it("risk restrictions and a reduced size are explained but still qualify", () => {
    const d = decide(input({ risk: risk("RESTRICTED", [reason("VOLATILITY_HIGH", "RESTRICT", "high volatility: size reduced")], { sizeMultiplier: 0.5 }), sizing: sizing({ lots: 5, quantity: 125, riskBudget: { binding: "daily_loss_headroom" } }) }));
    expect(d.outcome).toBe("QUALIFIED"); expect(d.permittedSize?.lots).toBe(5);
    expect(d.restrictions.map((r) => r.code)).toEqual(expect.arrayContaining(["VOLATILITY_HIGH", "SIZE_RESTRICTED", "SIZE_REDUCED"]));
    expect(d.explanation.sizeRestriction).toMatch(/daily_loss_headroom/); expect(d.explanation.riskRestrictions.join(" ")).toMatch(/high volatility/);
  });
  it("NO_TRADE when the situation forbids trading: controls, halts, session, inactive or expired candidate", () => {
    for (const c of ["CONTROL_DAILY_LOSS_HALT", "CONTROL_KILL_SWITCH", "MARKET_CLOSED", "OUTSIDE_SESSION", "CLOSING_WINDOW", "DAILY_LOSS_LIMIT_REACHED", "DRAWDOWN_HALT", "MAX_CONCURRENT_POSITIONS"]) {
      const d = decide(input({ risk: risk("BLOCKED", [reason(c, "BLOCK", c, "wait")]) }));
      expect(d.outcome, c).toBe("NO_TRADE"); expect(d.permittedSize).toBeNull(); expect(d.reasons.map((r) => r.code)).toContain(c);
    }
    expect(decide(input({ candidate: { ...cand, state: "INVALIDATED" } })).outcome).toBe("NO_TRADE");
    expect(decide(input({ candidate: { ...cand, expiresAt: new Date(NOW.getTime() - 1) } })).outcome).toBe("NO_TRADE");
  });
  it("REJECT for a failed hard rule: invalid stop, blocked risk, adverse or halted research, no size", () => {
    expect(decide(input({ candidate: { ...cand, stopLoss: null } })).outcome).toBe("REJECT");
    expect(decide(input({ candidate: { ...cand, stopLoss: 101 } })).reasons.find((r) => r.category === "STOP_LOSS")?.code).toMatch(/^STOP_LOSS_/);
    const rr = decide(input({ risk: risk("BLOCKED", [reason("REWARD_TO_RISK_TOO_LOW", "BLOCK", "too low", "choose a better target")]) }));
    expect(rr.outcome).toBe("REJECT"); expect(rr.whatWouldChange).toContain("choose a better target");
    expect(decide(input({ research: pkg({ assessment: "RESEARCH_ADVERSE" }) })).outcome).toBe("REJECT");
    expect(decide(input({ research: pkg({ halt: true, haltReason: "SIGNAL_INTEGRITY" }) })).outcome).toBe("REJECT");
    expect(decide(input({ sizing: sizing({ status: "NOT_SIZED", reason: "ONE_LOT_EXCEEDS_RISK_BUDGET", lots: 0, quantity: 0 }) })).outcome).toBe("REJECT");
  });
  it("EVALUATION_ONLY for inputs not fit to trade on: fixture data, unverified specifications, no PAPER permission", () => {
    expect(decide(input({ candidate: { ...cand, dataSource: "FIXTURE" } })).outcome).toBe("EVALUATION_ONLY");
    for (const c of ["SPEC_UNVERIFIED", "FEES_UNVERIFIED", "REGIME_FIXTURE_BACKED"]) expect(decide(input({ risk: risk("RESTRICTED", [reason(c, "RESTRICT")]) })).outcome, c).toBe("EVALUATION_ONLY");
    const p = decide(input({ paperEnabled: false })); expect(p.outcome).toBe("EVALUATION_ONLY"); expect(p.reasons.map((r) => r.code)).toContain("PAPER_NOT_ENABLED");
  });
  it("WAIT while evidence is missing or unresolved, and says what would change it", () => {
    const cases: Array<[string, Partial<DecisionInput>]> = [
      ["no research", { research: null }], ["inconclusive research", { research: pkg({ assessment: "RESEARCH_CAUTION" }) }], ["missing required agents", { research: pkg({ missingRequired: ["liquidity-v1"] }) }],
      ["contradiction", { research: pkg({ contradictions: [{ supportive: ["a"], opposing: ["b"], opposingVerdict: "ADVERSE" }] }) }],
      ["no confidence", { confidence: null }], ["weak strength", { confidence: { id: "k", score: 30, calibrationStatus: "UNCALIBRATED", completeness: 0.9, missing: [], caps: [] } }],
      ["incomplete evidence", { confidence: { id: "k", score: 80, calibrationStatus: "UNCALIBRATED", completeness: 0.4, missing: ["HISTORICAL_PATTERN"], caps: ["EVIDENCE_INCOMPLETE"] } }],
      ["no risk assessment", { risk: null, sizing: null }], ["spec data missing", { risk: risk("BLOCKED", [reason("SPEC_UNAVAILABLE", "BLOCK", "no spec", "load a specification")]) }], ["portfolio unknown", { risk: risk("BLOCKED", [reason("PORTFOLIO_STATE_UNAVAILABLE", "BLOCK", "unknown", "provide the portfolio state")]) }],
    ];
    for (const [name, o] of cases) { const d = decide(input(o)); expect(d.outcome, name).toBe("WAIT"); expect(d.whatWouldChange.length, name).toBeGreaterThan(0); expect(d.permittedSize).toBeNull(); }
    expect(decide(input({ confidence: { id: "k", score: 80, calibrationStatus: "UNCALIBRATED", completeness: 0.4, missing: ["HISTORICAL_PATTERN"], caps: [] } })).explanation.missing).toContain("HISTORICAL_PATTERN");
    expect(decide(input({ research: pkg({ contradictions: [{ supportive: ["a"], opposing: ["b"], opposingVerdict: "ADVERSE" }] }) })).explanation.contradictory.join(" ")).toMatch(/a support but b ADVERSE/);
  });
  it("precedence: NO_TRADE beats REJECT beats EVALUATION_ONLY beats WAIT", () => {
    expect(decide(input({ candidate: { ...cand, state: "EXPIRED", stopLoss: null, dataSource: "FIXTURE" }, research: null })).outcome).toBe("NO_TRADE");
    expect(decide(input({ candidate: { ...cand, stopLoss: null, dataSource: "FIXTURE" }, research: null })).outcome).toBe("REJECT");
    expect(decide(input({ candidate: { ...cand, dataSource: "FIXTURE" }, research: null })).outcome).toBe("EVALUATION_ONLY");
  });
  it("confidence never raises an outcome: a perfect score does not rescue a bad one, and uncalibrated stays uncalibrated", () => {
    const hi = { id: "k", score: 100, calibrationStatus: "CALIBRATED", completeness: 1, missing: [], caps: [] };
    expect(decide(input({ confidence: hi, research: null })).outcome).toBe("WAIT");
    expect(decide(input({ confidence: hi, candidate: { ...cand, stopLoss: null } })).outcome).toBe("REJECT");
    expect(decide(input({ confidence: hi, risk: risk("BLOCKED", [reason("CONTROL_KILL_SWITCH", "BLOCK")]) })).outcome).toBe("NO_TRADE");
    expect(decide(input({ confidence: hi, sizing: sizing({ lots: 3, quantity: 75 }) })).permittedSize?.lots).toBe(3); // the size is the risk-checked sizing, not a function of confidence
  });
  it("is deterministic", () => { expect(JSON.stringify(decide(input()))).toBe(JSON.stringify(decide(input()))); });
});

describe("approval card and configuration", () => {
  it("the card shows the exact permitted size, stop, targets, expiry and that it is a paper trade, with no profit claim", () => {
    const stored = { id: "d1", userId: "u1", accountId: "a1", candidateId: "c1", outcome: "QUALIFIED", workflowState: "PENDING", permittedSize: { lots: 10, quantity: 250, maxLossAtStop: "600.00", grossExposure: "25000.00" }, validUntil: NOW, evidenceRefs: ["ev:1"], explanation: { headline: "Qualified", riskRestrictions: ["VOLATILITY_HIGH: reduced"], sizeRestriction: "limited", missing: [], expiry: "valid until x" } } as never;
    const card = buildApprovalCard(stored, { underlying: "ACME", side: "BUY", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104] });
    expect(card).toMatchObject({ contractVersion: "approval-card-v1", mode: "PAPER", actions: ["APPROVE", "REJECT"], stopLoss: 98, targets: [104], decisionId: "d1" });
    expect(card.lines.join("\n")).toMatch(/10 lot/); expect(card.notice).toMatch(/does not claim any expected profit/i); expect(JSON.stringify(card)).not.toMatch(/probab|win rate|guarantee/i);
    expect(approvalNotification(stored, card)).toMatchObject({ kind: "APPROVAL_REQUEST", dedupeKey: "approval-request:d1" });
  });
  it("configuration is off by default and strict", () => {
    expect(loadDecisionConfig({})).toMatchObject({ enabled: false, policy: DEFAULT_DECISION_POLICY });
    expect(loadDecisionConfig({ TWINS_DECISIONS_ENABLED: "true", TWINS_DECISION_TTL_MINUTES: "30" }).policy.decisionTtlMinutes).toBe(30);
    for (const e of [{ TWINS_DECISIONS_ENABLED: "yes" }, { TWINS_DECISION_TTL_MINUTES: "0" }, { TWINS_DECISION_MIN_STRENGTH: "101" }, { TWINS_DECISION_MIN_COMPLETENESS: "2" }]) expect(() => loadDecisionConfig(e)).toThrow();
  });
});
