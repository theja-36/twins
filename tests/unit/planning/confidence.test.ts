import { describe, expect, it } from "vitest";
import { calibratedProbability, comparePredictedActual, COMPONENTS, evaluateCalibration, scoreConfidence, type ConfidenceInput, type Sample } from "../../../packages/confidence/src/index";

type V = "SUPPORTIVE" | "NEUTRAL" | "CAUTION" | "ADVERSE" | "BLOCKING" | "INCOMPLETE";
const report = (agentId: string, verdict: V, flags: string[] = []) => ({ agentId, agentVersion: `${agentId}.1`, role: null, verdict, executionStatus: verdict === "INCOMPLETE" ? "UNAVAILABLE" : "COMPLETED", confidence: null, evidenceRefs: [`ev:${agentId}`], riskFlags: flags, reasoningSummary: "x", inputSnapshotRef: "s", errorCode: null });
const IDS = COMPONENTS.flatMap((c) => c.agents);
const pkg = (verdicts: Partial<Record<string, V>>, o: Record<string, unknown> = {}) => ({
  packageVersion: "research-package-v1", candidateId: "c1", candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 2, assessment: "RESEARCH_NEUTRAL", halt: false, haltReason: null, score: 0, synthesisAlgorithmVersion: "s", reports: IDS.map((id) => report(id, verdicts[id] ?? "INCOMPLETE")),
  contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: Object.fromEntries(IDS.map((id) => [id, `${id}.1`])), evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b".repeat(64), ...o,
}) as never;
const regime = (o: Record<string, unknown> = {}) => ({ underlying: "ACME", version: "market-regime-v1", asOf: "2031-01-06T05:00:00Z", direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", eventRisk: "NONE", riskOff: false, dataSource: "LIVE", freshness: { stale: false }, ...o });
const strategy = (o: Record<string, unknown> = {}) => ({ playbookId: "pb", version: 3, resolvedOutcomes: 80, averageR: 0.4, winRate: 0.5, dataSource: "HISTORICAL", ...o });
const all = (v: V) => Object.fromEntries(IDS.map((i) => [i, v]));
const inp = (o: Partial<ConfidenceInput> = {}): ConfidenceInput => ({ candidate: { id: "c1", side: "BUY", dataSource: "LIVE", rankScore: 60 }, research: pkg(all("SUPPORTIVE")), regime: regime() as never, strategy: strategy() as never, ...o });

describe("confidence scoring (strength, not probability)", () => {
  it("weights add to 100 and a strongly supported, fully evidenced candidate scores high but is never a probability", () => {
    expect(COMPONENTS.reduce((a, c) => a + c.weight, 0)).toBe(100);
    const r = scoreConfidence(inp());
    expect(r.score).toBeGreaterThan(60); expect(r.score).toBeLessThanOrEqual(100);
    expect(r).toMatchObject({ strengthOnly: true, calibrationStatus: "UNCALIBRATED", winProbability: null, neverOverridesRisk: true, grantsApproval: false, completeness: 1 });
    expect(r.explanation).toMatch(/not a probability/i); expect(r.explanation).toMatch(/Uncalibrated/);
  });
  it("records every contribution with reasons, evidence references and agent versions", () => {
    const r = scoreConfidence(inp());
    const t = r.components.find((c) => c.id === "TECHNICAL_STRUCTURE")!;
    expect(t).toMatchObject({ weight: 14, status: "SCORED", versions: { "technical-structure-v1": "technical-structure-v1.1" } });
    expect(t.evidenceRefs).toContain("ev:technical-structure-v1"); expect(t.reasons.join(" ")).toContain("SUPPORTIVE");
    expect(r.provenance).toMatchObject({ candidateId: "c1", researchPackageVersion: 2, researchPackageSha256: "b".repeat(64), regimeRef: "market_regime:market-regime-v1:ACME:2031-01-06T05:00:00Z", strategyRef: "playbook:pb:v3" });
    expect(r.provenance.agentVersions["price-action-v1"]).toBe("price-action-v1.1");
  });
  it("missing evidence scores zero, is listed, lowers completeness and caps the score; it is never treated as support", () => {
    const r = scoreConfidence(inp({ research: pkg({ "technical-structure-v1": "SUPPORTIVE" }), regime: null, strategy: null }));
    for (const id of ["MARKET_CONTEXT", "HISTORICAL_PATTERN", "STRATEGY_PERFORMANCE"]) expect(r.missing.some((m) => m.startsWith(id)), id).toBe(true);
    expect(r.completeness).toBeLessThan(0.6); expect(r.caps.map((c) => c.code)).toContain("EVIDENCE_INCOMPLETE"); expect(r.score).toBeLessThanOrEqual(55);
    expect(r.components.find((c) => c.id === "HISTORICAL_PATTERN")).toMatchObject({ value: null, contribution: 0 });
    const none = scoreConfidence(inp({ research: null, regime: null, strategy: null }));
    expect(none.caps.map((c) => c.code)).toContain("NO_RESEARCH_PACKAGE"); expect(none.score).toBeLessThanOrEqual(40);
  });
  it("an INCOMPLETE agent is unusable evidence, not a neutral opinion", () => {
    const r = scoreConfidence(inp({ research: pkg({ ...all("SUPPORTIVE"), "historical-pattern-v1": "INCOMPLETE" }) }));
    expect(r.components.find((c) => c.id === "HISTORICAL_PATTERN")).toMatchObject({ status: "STALE_OR_UNUSABLE", value: null });
    expect(r.caps.map((c) => c.code)).toContain("STALE_OR_UNUSABLE_EVIDENCE");
  });
  it("stale regimes and thin strategy samples are not used", () => {
    const r = scoreConfidence(inp({ regime: regime({ freshness: { stale: true } }) as never, strategy: strategy({ resolvedOutcomes: 12 }) as never }));
    expect(r.components.find((c) => c.id === "MARKET_CONTEXT")).toMatchObject({ status: "STALE_OR_UNUSABLE", value: null });
    expect(r.components.find((c) => c.id === "STRATEGY_PERFORMANCE")).toMatchObject({ status: "STALE_OR_UNUSABLE", value: null });
  });
  it("contradictions, blocking agents and halts cap the score and appear as contradicting evidence", () => {
    const c = scoreConfidence(inp({ research: pkg({ ...all("SUPPORTIVE"), "liquidity-v1": "ADVERSE" }, { contradictions: [{ supportive: ["a"], opposing: ["liquidity-v1"], opposingVerdict: "ADVERSE" }] }) }));
    expect(c.caps.map((x) => x.code)).toContain("CONTRADICTIONS"); expect(c.score).toBeLessThanOrEqual(60); expect(c.contradicting.join(" ")).toMatch(/agents disagree/);
    const h = scoreConfidence(inp({ research: pkg(all("SUPPORTIVE"), { halt: true, haltReason: "SIGNAL_INTEGRITY_BLOCK" }) }));
    expect(h.score).toBeLessThanOrEqual(20);
    const m = scoreConfidence(inp({ research: pkg(all("SUPPORTIVE"), { missingRequired: ["liquidity-v1"] }) }));
    expect(m.score).toBeLessThanOrEqual(45);
  });
  it("fixture-backed evidence cannot look strong", () => {
    expect(scoreConfidence(inp({ candidate: { id: "c1", side: "BUY", dataSource: "FIXTURE", rankScore: 90 } })).score).toBeLessThanOrEqual(55);
    expect(scoreConfidence(inp({ regime: regime({ dataSource: "FIXTURE" }) as never })).caps.map((c) => c.code)).toContain("FIXTURE_BACKED");
    expect(scoreConfidence(inp({ research: pkg(all("SUPPORTIVE"), { dataSource: "FIXTURE" }) })).score).toBeLessThanOrEqual(55);
  });
  it("correlated evidence is not double counted: the price-series family cannot exceed its heaviest member", () => {
    const r = scoreConfidence(inp());
    const fam = r.components.filter((c) => c.group === "PRICE_SERIES");
    expect(fam.reduce((a, c) => a + c.cappedContribution, 0)).toBeLessThanOrEqual(14 + 0.01);
    expect(fam.reduce((a, c) => a + c.contribution, 0)).toBeGreaterThan(14);
    expect(fam.some((c) => c.reasons.some((x) => /share one evidence family/.test(x)))).toBe(true);
    // the independent rank is shown, never added
    expect(scoreConfidence(inp({ candidate: { id: "c1", side: "BUY", dataSource: "LIVE", rankScore: 100 } })).score).toBe(scoreConfidence(inp({ candidate: { id: "c1", side: "BUY", dataSource: "LIVE", rankScore: 0 } })).score);
  });
  it("the regime must agree with the side; a challenger can only subtract", () => {
    const up = scoreConfidence(inp()), against = scoreConfidence(inp({ regime: regime({ direction: "BEARISH" }) as never }));
    expect(against.score).toBeLessThan(up.score);
    const sell = scoreConfidence(inp({ candidate: { id: "c1", side: "SELL", dataSource: "LIVE", rankScore: null }, regime: regime({ direction: "BEARISH" }) as never }));
    expect(sell.components.find((c) => c.id === "MARKET_CONTEXT")!.value).toBeGreaterThan(0);
    expect(up.components.find((c) => c.id === "CHALLENGER")!.contribution).toBe(0);
    const opposed = scoreConfidence(inp({ research: pkg({ ...all("SUPPORTIVE"), "independent-challenger-v1": "ADVERSE" }) }));
    expect(opposed.components.find((c) => c.id === "CHALLENGER")!.contribution).toBeLessThan(0);
  });
  it("is deterministic, bounded 0-100, and carries the model version and an input hash", () => {
    const a = scoreConfidence(inp()), b = scoreConfidence(inp());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); expect(a.inputSha256).toMatch(/^[0-9a-f]{64}$/); expect(a.modelVersion).toBe("confidence-strength-v1");
    for (const v of ["BLOCKING", "ADVERSE", "CAUTION", "NEUTRAL", "SUPPORTIVE", "INCOMPLETE"] as V[]) { const s = scoreConfidence(inp({ research: pkg(all(v)) })).score; expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100); }
    expect(scoreConfidence(inp({ research: pkg(all("BLOCKING")) })).score).toBeLessThan(scoreConfidence(inp({ research: pkg(all("NEUTRAL")) })).score);
  });
});

describe("calibration (separate from scoring)", () => {
  const mk = (n: number, oos: boolean, win: (score: number) => boolean, scoreOf = (i: number) => (i * 7) % 100): Sample[] => Array.from({ length: n }, (_, i) => { const score = scoreOf(i); return { score, won: win(score), r: win(score) ? 1 : -1, outOfSample: oos, at: "2031-01-01T00:00:00Z" }; });
  it("with no outcomes nothing is calibrated and no probability exists", () => {
    const r = evaluateCalibration([]);
    expect(r).toMatchObject({ status: "UNCALIBRATED", brierScore: null, outOfSample: false });
    expect(calibratedProbability(80, r)).toBeNull(); expect(calibratedProbability(80, null)).toBeNull();
  });
  it("in-sample outcomes and thin out-of-sample sets never calibrate", () => {
    expect(evaluateCalibration(mk(500, false, (s) => s > 50)).status).toBe("UNCALIBRATED");
    const thin = evaluateCalibration(mk(100, true, (s) => s > 50));
    expect(thin.status).toBe("CALIBRATING"); expect(thin.reasons.join(" ")).toMatch(/minimum 200/); expect(calibratedProbability(80, thin)).toBeNull();
  });
  it("calibrates only on enough out-of-sample outcomes whose win rate rises with the score; then and only then a bin probability is available", () => {
    const run = evaluateCalibration(mk(1000, true, (s) => (s * 13) % 100 < s));  // deterministic, rises with score
    expect(run.status).toBe("CALIBRATED"); expect(run.brierScore).not.toBeNull();
    const p = calibratedProbability(90, run), q = calibratedProbability(10, run);
    expect(p).not.toBeNull(); expect(q).not.toBeNull(); expect(p!).toBeGreaterThan(q!);
  });
  it("refuses to calibrate a score that does not predict (win rate falls with score)", () => {
    const run = evaluateCalibration(mk(1000, true, (s) => (s * 13) % 100 < 100 - s));
    expect(run.status).toBe("CALIBRATING"); expect(run.reasons.join(" ")).toMatch(/falls between bins/); expect(calibratedProbability(90, run)).toBeNull();
  });
  it("predicted-versus-actual comparison is descriptive and handles empty bins", () => {
    const bins = comparePredictedActual(mk(50, false, (s) => s > 50));
    expect(bins).toHaveLength(5); expect(bins.reduce((a, b) => a + b.n, 0)).toBe(50);
    expect(comparePredictedActual([]).every((b) => b.n === 0 && b.observedWinRate === null)).toBe(true);
  });
});
