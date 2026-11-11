/**
 * Stage 08 completion: metric accuracy and numerical integrity (loss rate, exact-decimal ratios, unrounded R, Student-t interval, NOT_AVAILABLE views), the new segmentation, and the pure snapshot functions.
 * Reference values are published/closed-form numbers or are computed by hand in the test, never taken from the code under test.
 */
import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../../../packages/historical/src/index";
import { buildAnalyticsReport, buildAttribution, canonicalJson, computeMetrics, confidenceBandOf, hashesOf, plannedRewardToRiskBucket, reportOf, sha256, tCritical95, algorithmVersions, DEFAULT_OUTCOME_LEARNING, type SnapshotInputs } from "../../../packages/outcomes/src/index";
import type { DecisionRow, EvidenceFingerprint } from "../../../packages/database/src/index";
import { dec, div, str } from "../../../packages/planning/src/index";
import { facts, loss, many, rec, T0, win } from "./fixtures";

const M = 30;
describe("Student-t critical value (95%, two-sided)", () => {
  it("agrees with the published table to 3 decimals for the degrees of freedom the minimum sample allows", () => {
    const table: Array<[number, number]> = [[29, 2.0452], [30, 2.0423], [40, 2.0211], [60, 2.0003], [120, 1.9799], [1000, 1.9623]];
    for (const [df, t] of table) expect(Math.abs(tCritical95(df) - t), `df ${df}`).toBeLessThan(0.0006);
    expect(tCritical95(29)).toBeGreaterThan(1.959964); // always wider than the normal quantile
  });
  it("refuses to approximate below 10 degrees of freedom", () => { expect(() => tCritical95(5)).toThrow(RangeError); expect(() => tCritical95(Number.NaN)).toThrow(); });
});

describe("win rate and loss rate", () => {
  const set = [...many(16, () => win()), ...many(20, () => loss()), ...many(4, () => rec({ netPnl: "0.00", grossPnl: "0.00", rMultiple: "0" }))];
  it("are explicit, share one denominator with the breakeven share, and carry Wilson 95% intervals", () => {
    const m = computeMetrics(set, M);
    expect(m).toMatchObject({ eligible: 40, wins: 16, losses: 20, breakeven: 4 });
    expect(m.winRate.value).toBe(0.4); expect(m.lossRate.value).toBe(0.5);
    expect(m.winRate.interval).toEqual(wilsonInterval(16, 40, 1.96)); expect(m.lossRate.interval).toEqual(wilsonInterval(20, 40, 1.96));
    expect(m.winRate.value! + m.lossRate.value! + m.breakeven / m.eligible).toBeCloseTo(1, 12);
    expect(m.lossRate.definition).toMatch(/losses/);
  });
  it("below the minimum sample both are reported with their sample size and a reason, never as a confident figure", () => {
    const m = computeMetrics(set.slice(0, 10), M);
    expect(m.status).toBe("INSUFFICIENT_DATA"); expect(m.winRate.note).toMatch(/fewer than 30/); expect(m.lossRate.note).toMatch(/fewer than 30/); expect(m.expectancyR.value).toBeNull();
  });
  it("with no outcomes there is no rate", () => { const m = computeMetrics([], M); expect(m.lossRate).toMatchObject({ value: null, interval: null, n: 0 }); expect(m.winRate.value).toBeNull(); });
});

describe("exact-decimal arithmetic", () => {
  it("payoff ratio and profit factor are exact where floating point is not (0.1 summed thirty times is not 3)", () => {
    expect([...Array(30)].reduce((a: number) => a + 0.1, 0)).not.toBe(3); // the float trap this guards against
    const rs = [...many(30, () => win({ netPnl: "0.10", grossPnl: "0.10", rMultiple: "0.1" })), ...many(10, () => loss({ netPnl: "-0.30", grossPnl: "-0.30", rMultiple: "-0.3" }))];
    const m = computeMetrics(rs, M);
    expect(m.netPnl).toBe("0.00"); // 30 x 0.10 - 10 x 0.30, exactly
    expect(m.profitFactor.exact).toBe("1.00000000"); expect(m.profitFactor.value).toBe(1);
    expect(m.payoffRatio.exact).toBe("0.33333333"); expect(m.payoffRatio.value).toBe(0.3333); // 0.10 / 0.30 truncated at 8 places, shown at 4
    expect(m.expectancyMoney.value).toBe("0.00");
  });
  it("money totals keep every cent across thousands of outcomes", () => {
    const rs = [...many(2000, () => win({ netPnl: "0.07", grossPnl: "0.07", rMultiple: "0.07" })), ...many(1000, () => loss({ netPnl: "-0.03", grossPnl: "-0.03", rMultiple: "-0.03" }))];
    expect(computeMetrics(rs, M).netPnl).toBe("110.00"); // 140.00 - 30.00 exactly
  });
});

describe("R-multiples are used unrounded (8-place fixed point)", () => {
  it("the mean and total keep all eight places", () => {
    const m = computeMetrics(many(30, () => win({ rMultiple: "0.12345678" })), M);
    expect(m.expectancyR.exact).toBe("0.12345678"); expect(m.rMultiple.mean).toBe(0.1235); expect(m.rMultiple.total).toBeCloseTo(3.7037, 4);
  });
  it("an attribution computes a missing R at 8 places, not 2", () => {
    const f = facts(); const a = buildAttribution({ ...f, outcome: { ...f.outcome!, rMultiple: null } }, null)!;
    expect(a.riskAmount).not.toBeNull(); expect(a.rMultiple).toMatch(/^-?\d+\.\d{8}$/);
    expect(a.rMultiple).toBe(str(div(dec(f.outcome!.pnl), dec(a.riskAmount as string), "down"), 8));
  });
  it("the expectancy interval is Student's t on n-1 degrees of freedom, wider than the normal one", () => {
    const rs = [...many(15, () => win({ rMultiple: "0.5" })), ...many(15, () => win({ rMultiple: "1.5" }))];
    const m = computeMetrics(rs, M), sd = Math.sqrt(7.5 / 29), se = sd / Math.sqrt(30), t = 2.0452;
    expect(m.expectancyR.value).toBe(1); expect(m.expectancyR.degreesOfFreedom).toBe(29); expect(m.expectancyR.intervalMethod).toMatch(/t with n-1/);
    expect(m.expectancyR.interval95!.lower).toBeCloseTo(1 - t * se, 3); expect(m.expectancyR.interval95!.upper).toBeCloseTo(1 + t * se, 3);
    expect(m.expectancyR.interval95!.upper - 1).toBeGreaterThan(1.96 * se); // a normal interval would be narrower
  });
  it("no interval below the minimum sample", () => { expect(computeMetrics(many(12, () => win({ rMultiple: "1" })), M).expectancyR.interval95).toBeNull(); });
});

describe("views that cannot be produced stay NOT_AVAILABLE with a reason", () => {
  it("percent drawdown needs an equity curve; profit factor has no invented interval", () => {
    const m = computeMetrics(many(40, () => win()), M);
    expect(m.maxDrawdownPct).toMatchObject({ value: null, status: "NOT_AVAILABLE" }); expect(m.maxDrawdownPct.reason).toMatch(/equity curve/);
    expect(m.profitFactor.interval).toBeNull(); expect(m.profitFactor.intervalNote).toMatch(/estimated or invented/);
  });
  it("the signal-pattern view is NOT_AVAILABLE until the pattern provider exists (G-23)", () => {
    const r = buildAnalyticsReport({ now: new Date(T0), minSample: M, minDriftWindow: M, records: many(5, () => win()), decisions: [], packages: [], claimChannels: [], telegramCandidates: 0, independentStage: { candidates: 0, researched: 0, byState: {}, stateReasons: {}, scans: 0 }, hypothetical: new Map(), calibration: null });
    expect(r.modes.PAPER.strategy.bySignalPattern).toMatchObject({ status: "NOT_AVAILABLE", dependsOn: "G-23 historical pattern provider" });
  });
});

describe("segmentation by confidence band, risk verdict, planned reward-to-risk and decision outcome", () => {
  it("bands are 20 wide and a score recorded after the position opened is never used (look-ahead)", () => {
    const at = (s: number | null, dq: string[] = []) => confidenceBandOf(rec({ confidenceScore: s, dataQuality: dq }));
    expect([0, 19.99, 20, 59.9, 60, 79.9, 80, 100].map((s) => at(s))).toEqual(["0-20", "0-20", "20-40", "40-60", "60-80", "60-80", "80-100", "80-100"]);
    expect(at(null)).toBeNull(); expect(at(70, ["CONFIDENCE_RECORDED_AFTER_OPEN"])).toBeNull(); expect(at(Number.NaN)).toBeNull();
  });
  it("planned reward-to-risk buckets describe the plan, and unknown stays unknown", () => {
    const b = (v: string | null) => plannedRewardToRiskBucket(rec({ predicted: v === null ? {} : { plannedRewardToRisk: v } }));
    expect(["1.49", "1.5", "1.99", "2.00", "2.99", "3", "9"].map(b)).toEqual(["<1.5", "1.5-2", "1.5-2", "2-3", "2-3", ">=3", ">=3"]); expect(b(null)).toBeNull(); expect(b("0")).toBeNull(); expect(b("x")).toBeNull();
  });
  it("the report slices realised results by band, verdict, planned R:R and the decision's outcome, keeping unknown apart", () => {
    const rs = [...many(30, () => win({ confidenceScore: 85, decisionId: "dA", predicted: { riskVerdict: "PASS", plannedRewardToRisk: "2.5" } })), ...many(30, () => loss({ confidenceScore: 30, decisionId: "dB", predicted: { riskVerdict: "WARN", plannedRewardToRisk: "1.2" } })), ...many(5, () => win({ confidenceScore: null, decisionId: "dC", predicted: {} }))];
    const d = (id: string, outcome: string): DecisionRow => ({ id, outcome, createdAt: new Date(T0) } as unknown as DecisionRow);
    const r = buildAnalyticsReport({ now: new Date(T0), minSample: M, minDriftWindow: M, records: rs, decisions: [d("dA", "QUALIFIED"), d("dB", "QUALIFIED")], packages: [], claimChannels: [], telegramCandidates: 0, independentStage: { candidates: 0, researched: 0, byState: {}, stateReasons: {}, scans: 0 }, hypothetical: new Map(), calibration: null });
    const S = r.modes.PAPER.strategy, keys = (x: { key: string }[]) => x.map((y) => y.key).sort();
    expect(keys(S.byConfidenceBand)).toEqual(["20-40", "80-100", "UNKNOWN"]); expect(S.byConfidenceBand.find((x) => x.key === "80-100")!.metrics.winRate.value).toBe(1); expect(S.byConfidenceBand.find((x) => x.key === "20-40")!.metrics.winRate.value).toBe(0);
    expect(keys(S.byRiskVerdict)).toEqual(["PASS", "UNKNOWN", "WARN"]); expect(keys(S.byPlannedRewardToRisk)).toEqual(["2-3", "<1.5", "UNKNOWN"]);
    expect(keys(S.byDecisionOutcome)).toEqual(["QUALIFIED", "UNKNOWN"]); expect(S.byDecisionOutcome.find((x) => x.key === "UNKNOWN")!.metrics.eligible).toBe(5); // a decision not in the input is unknown, never guessed
  });
});

describe("snapshot hashes and report derivation are pure and deterministic", () => {
  const fp = (n = 3): EvidenceFingerprint => ({ attributions: { count: n, newestMicros: "1767700000000000", lastId: "x" }, decisions: { count: 2, newestMicros: "1767600000000000", digest: "d" }, positions: { count: 1, digest: "p" } });
  const pipe = (c = 5) => ({ claims: [], telegram: { candidates: 0, byState: {}, researched: 0, scans: 0, scanCandidates: 0, stateReasons: {} }, independent: { candidates: c, byState: {}, researched: 1, scans: 2, scanCandidates: c, stateReasons: {} } }) as never;
  it("canonical JSON ignores key order and undefined, and renders non-finite numbers as null", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { e: [3, { y: 2, z: 1 }], d: 2 }, b: 1 })); expect(canonicalJson({ n: Number.NaN, i: Infinity })).toBe('{"i":null,"n":null}');
  });
  it("the evidence hash covers evidence, settings and versions but NOT the pipeline counts; the input hash covers all", () => {
    const c = DEFAULT_OUTCOME_LEARNING, a = hashesOf(fp(), pipe(5), c);
    expect(hashesOf(fp(), pipe(5), c)).toEqual(a);
    const otherPipe = hashesOf(fp(), pipe(6), c); expect(otherPipe.evidenceHash).toBe(a.evidenceHash); expect(otherPipe.inputHash).not.toBe(a.inputHash);
    const moreEvidence = hashesOf(fp(4), pipe(5), c); expect(moreEvidence.evidenceHash).not.toBe(a.evidenceHash); expect(moreEvidence.inputHash).not.toBe(a.inputHash);
    const otherSetting = hashesOf(fp(), pipe(5), { ...c, minSample: 45 }); expect(otherSetting.evidenceHash).not.toBe(a.evidenceHash); expect(otherSetting.configHash).not.toBe(a.configHash);
    expect(hashesOf(fp(), pipe(5), { ...c, intervalMs: 999_999, leaseMs: 120_000 }).evidenceHash).toBe(a.evidenceHash); // operational settings do not change what the analytics say
    for (const h of [a.evidenceHash, a.inputHash, a.configHash]) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the as-of instant comes from the newest evidence record, and is the epoch when there is none", () => {
    expect(hashesOf(fp(), pipe(), DEFAULT_OUTCOME_LEARNING).asOf.toISOString()).toBe(new Date(1767700000000).toISOString());
    expect(hashesOf({ attributions: { count: 0, newestMicros: "", lastId: "" }, decisions: { count: 0, newestMicros: "", digest: "" }, positions: { count: 0, digest: "" } }, pipe(), DEFAULT_OUTCOME_LEARNING).asOf.getTime()).toBe(0);
  });
  it("the same inputs always give the same report and hash, independent of the wall clock; different settings give a different verdict", () => {
    const inputs: SnapshotInputs = { records: [...many(35, () => win()), ...many(5, () => loss())], decisions: [], packages: [], pipeline: pipe(), fingerprint: fp(), complete: true };
    const asOf = new Date(1767700000000), r1 = reportOf(inputs, DEFAULT_OUTCOME_LEARNING, asOf);
    const realNow = Date.now; try { Date.now = () => 4_000_000_000_000; expect(sha256(canonicalJson(reportOf(inputs, DEFAULT_OUTCOME_LEARNING, asOf)))).toBe(sha256(canonicalJson(r1))); } finally { Date.now = realNow; }
    expect(r1.generatedAt).toBe(asOf.toISOString()); expect(r1.modes.PAPER.overview.status).toBe("SUFFICIENT");
    expect(reportOf(inputs, { ...DEFAULT_OUTCOME_LEARNING, minSample: 45 }, asOf).modes.PAPER.overview.status).toBe("INSUFFICIENT_DATA");
    expect(JSON.parse(JSON.stringify(r1))).toEqual(r1); // survives storage unchanged
  });
  it("every algorithm that shapes the report has a version recorded", () => { const v = algorithmVersions(); for (const k of ["snapshot", "report", "metrics", "attribution", "calibrationPipeline", "drift", "insights", "funnel"]) expect(v[k], k).toMatch(/v\d/); expect(v["metrics"]).toBe("performance-metrics-v2"); });
});
