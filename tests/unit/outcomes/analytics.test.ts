import { describe, expect, it } from "vitest";
import { analyzeAgents, assessDecisionQuality, buildAnalyticsReport, estimateHypothetical, generateInsights, independentFunnel, rate, telegramFunnel, tallyDecisions, type PackageReports } from "../../../packages/outcomes/src/index";
import type { DecisionRow } from "../../../packages/database/src/index";
import { loss, many, T0, win } from "./fixtures";

const NOW = new Date(T0 + 86_400_000 * 3);
const dr = (o: Partial<DecisionRow> = {}): DecisionRow => ({ id: `d${Math.random()}`, candidateId: "c1", source: "INDEPENDENT", outcome: "QUALIFIED", workflowState: "APPROVED", createdAt: new Date(T0), setup: "BREAKOUT", instrument: "ACME", side: "BUY", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104], candidateDataSource: "LIVE", invalidated: false, hasPosition: true, channelId: null, ...o });
const pk = (cand: string, verdicts: Record<string, string>, extra: Partial<PackageReports> = {}): PackageReports => ({ candidateId: cand, packageId: `p-${cand}`, version: 1, reports: Object.entries(verdicts).map(([agentId, verdict]) => ({ agentId, agentVersion: `${agentId}.1`, verdict, executionStatus: verdict === "INCOMPLETE" ? "UNAVAILABLE" : "COMPLETED", riskFlags: [] })), contradictions: 0, missingRequired: [], assessment: "RESEARCH_NEUTRAL", ...extra });

describe("funnels", () => {
  it("a rate always carries its numerator and denominator and is null without a denominator", () => {
    expect(rate(3, 4)).toEqual({ value: 0.75, numerator: 3, denominator: 4 }); expect(rate(0, 0)).toEqual({ value: null, numerator: 0, denominator: 0 });
  });
  it("independent and Telegram results are reported separately; decision counts are the user's", () => {
    const rows = [dr(), dr({ outcome: "WAIT", workflowState: "PENDING", hasPosition: false }), dr({ source: "TELEGRAM", channelId: "ch1" })];
    const ind = independentFunnel({ candidates: 20, researched: 10, byState: { EXPIRED: 5, INVALIDATED: 2, NEW: 13 }, stateReasons: { PAST_EXPIRY: 5 }, scans: 4 }, rows, [win({ candidateSource: "INDEPENDENT" }), win({ candidateSource: "TELEGRAM", channelId: "ch1" })], 30);
    expect(ind.decisions.total).toBe(2); expect(ind.rates.candidateToResearch).toEqual({ value: 0.5, numerator: 10, denominator: 20 }); expect(ind.rates.candidateExpiryRate.value).toBe(0.25); expect(ind.rates.decisionToQualified).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(ind.outcomes!.total.eligible).toBe(1); expect(ind.reasons).toEqual({ PAST_EXPIRY: 5 }); expect(ind.note).toMatch(/never combined with Telegram/);
    const tg = telegramFunnel([{ channelId: "ch1", channelLabel: "***1234", messages: 100, claims: 40, ambiguous: 5, unsupported: 5, assessedReject: 3, assessedInsufficient: 30 }, { channelId: "ch2", channelLabel: "***9999", messages: 0, claims: 0, ambiguous: 0, unsupported: 0, assessedReject: 0, assessedInsufficient: 0 }], 1, rows, [win({ candidateSource: "TELEGRAM", channelId: "ch1" })], 30);
    expect(tg.channels[0]!.decisions.total).toBe(1); expect(tg.channels[0]!.rates.claimShare.value).toBe(0.4); expect(tg.channels[0]!.rates.invalidShare).toEqual({ value: 0.2, numerator: 10, denominator: 50 });
    expect(tg.channels[0]!.reliability).toBe("INSUFFICIENT_DATA"); expect(tg.channels[1]!.outcomes).toBeNull(); expect(tg.channels[1]!.rates.claimShare.value).toBeNull();
    expect(tg.unavailable.join(" ")).toMatch(/channel accuracy/); expect(tg.note).toMatch(/G-19/);
  });
  it("tallies decisions by outcome without inventing results", () => {
    expect(tallyDecisions([dr(), dr({ outcome: "REJECT", workflowState: "REJECTED", hasPosition: false }), dr({ invalidated: true })])).toMatchObject({ total: 3, qualified: 2, approved: 2, withPosition: 2, invalidated: 1, byOutcome: { QUALIFIED: 2, REJECT: 1 } });
  });
});

describe("agent analytics", () => {
  it("reports participation, availability, verdicts, versions, agreement and evidence gaps", () => {
    const a = analyzeAgents([pk("c1", { a: "SUPPORTIVE", b: "SUPPORTIVE" }), pk("c2", { a: "SUPPORTIVE", b: "ADVERSE" }, { contradictions: 1, missingRequired: ["liquidity-v1"] }), pk("c3", { a: "INCOMPLETE", b: "NEUTRAL" })], [], 30);
    const ag = a.agents.find((x) => x.agentId === "a")!;
    expect(ag).toMatchObject({ participation: 3, completed: 2, unavailable: 1, availabilityRate: 0.6667, verdicts: { SUPPORTIVE: 2, INCOMPLETE: 1 }, versions: { "a.1": 3 } });
    expect(a.agreement).toMatchObject({ packagesWithTwoOrMoreVerdicts: 2, unanimous: 1, disagreement: 1, withContradictions: 1 }); expect(a.evidenceGaps).toMatchObject({ packagesMissingRequiredAgents: 1, byAgent: { "liquidity-v1": 1 } });
  });
  it("the outcome association is per verdict, only above the minimum sample, and never called accuracy", () => {
    const pkgs = [...many(35, () => pk("cS", { a: "SUPPORTIVE" })), pk("cA", { a: "ADVERSE" })];
    const outs = [...Array.from({ length: 35 }, () => win({ candidateId: "cS" })), win({ candidateId: "cA" })];
    const a = analyzeAgents(pkgs.slice(0, 1), outs, 30).agents[0]!;
    expect(a.outcomeAssociation[0]).toMatchObject({ verdict: "SUPPORTIVE", eligibleOutcomes: 35, winRate: 1 }); expect(a.associationNote).toMatch(/not predictive accuracy/);
    const thin = analyzeAgents([pk("cA", { a: "ADVERSE" })], outs, 30).agents[0]!.outcomeAssociation[0]!;
    expect(thin).toMatchObject({ verdict: "ADVERSE", eligibleOutcomes: 1, winRate: null, reliability: "INSUFFICIENT_DATA" });
  });
});

describe("decision quality and counterfactual estimates", () => {
  const bar = (mins: number, o: number, h: number, l: number, c: number) => ({ t: new Date(T0 + mins * 60_000).toISOString(), open: o, high: h, low: l, close: c });
  const row = { side: "BUY" as const, entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104], createdAt: new Date(T0) };
  const end = new Date(T0 + 24 * 3600_000);
  it("labels every estimate, gives no currency, and never resolves an ambiguous bar favourably", () => {
    const tf = estimateHypothetical(row, [bar(5, 100, 105, 99, 104)], NOW, end), sf = estimateHypothetical(row, [bar(5, 100, 101, 97, 98)], NOW, end), amb = estimateHypothetical(row, [bar(5, 100, 105, 97, 100)], NOW, end);
    expect(tf).toMatchObject({ class: "TARGET_FIRST", estimatedR: 2, label: "ESTIMATE_NOT_REALISED" }); expect(sf).toMatchObject({ class: "STOP_FIRST", estimatedR: -1 }); expect(amb).toMatchObject({ class: "AMBIGUOUS", estimatedR: null });
    expect(JSON.stringify(tf)).not.toMatch(/pnl|profit|amount|currency/i); expect(tf.assumptions.join(" ")).toMatch(/no costs and no slippage/);
  });
  it("without later bars, before the horizon, or without usable levels the answer is unavailable, not a guess", () => {
    expect(estimateHypothetical(row, [], NOW, end).class).toBe("NO_PRICE_EVIDENCE"); expect(estimateHypothetical(row, [], new Date(T0 + 1000), end).class).toBe("HORIZON_NOT_REACHED");
    expect(estimateHypothetical(row, [bar(5, 100, 101, 99.5, 100)], new Date(T0 + 1000), end).class).toBe("HORIZON_NOT_REACHED"); expect(estimateHypothetical(row, [bar(5, 100, 101, 99.5, 100)], NOW, end).class).toBe("NEITHER");
    expect(estimateHypothetical({ ...row, stopLoss: null }, [bar(5, 100, 105, 97, 100)], NOW, end).class).toBe("NO_LEVELS"); expect(estimateHypothetical({ ...row, stopLoss: 101 }, [bar(5, 100, 105, 97, 100)], NOW, end).class).toBe("NO_LEVELS");
    expect(estimateHypothetical(row, [bar(-30, 100, 105, 97, 100)], NOW, end).class).toBe("NO_PRICE_EVIDENCE"); // bars from before the decision are never used (no look-behind peeking)
  });
  it("realised results exist only for executed decisions; unexecuted ones carry estimates only", () => {
    const rows = [dr(), dr({ outcome: "REJECT", workflowState: "REJECTED", hasPosition: false, id: "r1" }), dr({ outcome: "WAIT", hasPosition: false, id: "w1" })];
    const q = assessDecisionQuality(rows, [win()], new Map([["r1", estimateHypothetical(row, [bar(5, 100, 105, 99, 104)], NOW, end)]]), 30);
    expect(q.executed.qualifiedExecuted).toBe(1);
    const rej = q.notExecuted.find((x) => x.outcome === "REJECT")!; expect(rej.estimate).toMatchObject({ evaluated: 1, targetFirst: 1 }); expect(q.notExecuted.find((x) => x.outcome === "WAIT")!.estimate).toMatchObject({ evaluated: 0, unavailable: 1 });
    expect(JSON.stringify(q.notExecuted)).not.toMatch(/netPnl|grossPnl|pnl/i); expect(q.limitations.join(" ")).toMatch(/no P&L/);
  });
});

describe("insights", () => {
  const inputs = (records: ReturnType<typeof win>[]) => ({ now: NOW, minSample: 30, minDriftWindow: 30, records, decisions: [dr()], packages: [pk("c1", { a: "SUPPORTIVE", b: "NEUTRAL" })], claimChannels: [], telegramCandidates: 0, independentStage: { candidates: 5, researched: 3, byState: {}, stateReasons: {}, scans: 1 }, hypothetical: new Map(), calibration: null });
  const gen = (rs: ReturnType<typeof win>[]) => generateInsights(buildAnalyticsReport(inputs(rs)), rs, 30);
  it("every insight states scope, subject, count, period, provenance, method, evidence, reliability, limitations and version", () => {
    for (const i of gen(many(35, () => win()))) {
      expect(i.scope.length).toBeGreaterThan(0); expect(i.subject.length).toBeGreaterThan(0); expect(i.outcomeCount).toBeGreaterThanOrEqual(0); expect(i.method.length).toBeGreaterThan(10); expect(i.algorithmVersion).toMatch(/insight-engine-v1/);
      expect(i.limitations.length).toBeGreaterThan(0); expect(i.statement.length).toBeGreaterThan(10); expect(i.insightKey).toMatch(/^[0-9a-f]{64}$/); expect(i.provenance).toBeTruthy(); expect(i.evidenceRefs).toBeTruthy(); expect(i.reliability).toBeTruthy();
    }
  });
  it("is reproducible: the same stored outcomes give the same insights and keys; different outcomes give different keys", () => {
    const rs = many(35, () => win());
    expect(gen(rs).map((i) => i.insightKey)).toEqual(gen(rs).map((i) => i.insightKey));
    const perf = (r: typeof rs) => gen(r).find((i) => i.kind === "PERFORMANCE")!.insightKey;
    expect(perf(rs)).not.toBe(perf([...rs, win()]));
  });
  it("a small sample says INSUFFICIENT_DATA and fixture data says NOT_VALIDATED_FIXTURE: neither claims reliable performance", () => {
    const small = gen([win(), loss()]).filter((i) => i.kind === "PERFORMANCE");
    expect(small.every((i) => i.reliability === "INSUFFICIENT_DATA" || i.outcomeCount === 0)).toBe(true); expect(small[0]!.statement).toMatch(/INSUFFICIENT_DATA/);
    const fx = gen(many(300, () => win({ dataSource: "FIXTURE" }))).filter((i) => i.kind === "PERFORMANCE" && i.subject === "all paper outcomes")[0]!;
    expect(fx.reliability).toBe("NOT_VALIDATED_FIXTURE"); expect(fx.limitations.join(" ")).toMatch(/fixture-backed/); expect(fx.provenance).toMatchObject({ fixtureBacked: true });
    const dq = gen(many(300, () => win({ dataSource: "FIXTURE" }))).find((i) => i.kind === "DATA_QUALITY")!; expect(dq.severity).toBe("WARNING"); expect(dq.statement).toMatch(/no figure here is validated performance/);
  });
  it("the validated (non-fixture) dataset is separate and reports INSUFFICIENT_DATA when it is empty", () => {
    const v = gen(many(300, () => win({ dataSource: "FIXTURE" }))).find((i) => i.subject.startsWith("non-fixture"))!;
    expect(v.reliability).toBe("INSUFFICIENT_DATA"); expect(v.outcomeCount).toBe(0);
  });
  it("calibration is reported NOT_CALIBRATED / UNAVAILABLE and never as a probability; research areas list evidence gaps", () => {
    const i = gen(many(35, () => win({ missing: ["regime_at_decision", "mae_mfe"] }))); const c = i.find((x) => x.kind === "CALIBRATION")!;
    expect(c.reliability).toBe("UNAVAILABLE"); expect(c.statement).toMatch(/not a probability/); expect(c.limitations.join(" ")).toMatch(/200 out-of-sample minimum/);
    expect(i.find((x) => x.kind === "RESEARCH_AREA")!.statement).toMatch(/evidence/);
  });
  it("a recommendation can only be REVIEW (or none); drift warnings recommend review only with enough evidence", () => {
    const bad = Array.from({ length: 120 }, (_, i) => (i < 90 ? i % 4 !== 0 : i % 4 === 0) ? win({ closedAt: new Date(T0 + i * 60_000) }) : loss({ closedAt: new Date(T0 + i * 60_000) }));
    const ins = gen(bad);
    expect(new Set(ins.map((i) => i.recommendation))).toEqual(new Set([null, "REVIEW"]));
    const d = ins.find((i) => i.kind === "DRIFT" && i.severity === "WARNING")!; expect(d.statement).toMatch(/DEGRADATION/); expect(d.recommendation).toBe("REVIEW");
    expect(JSON.stringify(ins.map((i) => i.statement + i.recommendation))).not.toMatch(/\b(increase|raise|reduce|disable|activate|enable|approve|change the (risk|size|stop|weight))\b/i);
  });
});
