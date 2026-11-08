import { describe, expect, it } from "vitest";
import { computeStats, conditionalPerformance, counterfactual, detectDrift, driftEventOf, reasonBreakdown, revisionAnalysis, stopBehaviour, type LearningOutcome } from "../../../packages/historical/src/strategy/index";

let k = 0;
const o = (outcome: LearningOutcome["outcome"], r: number | null, extra: Partial<LearningOutcome> = {}, day = k): LearningOutcome => ({ id: `o${k++}`, at: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000), outcome, rMultiple: r, dims: {}, ...extra });
const series = (wins: number, losses: number, start: number, extra: Partial<LearningOutcome> = {}): LearningOutcome[] => [...Array.from({ length: wins }, (_, i) => o("WIN", 1.5, extra, start + i)), ...Array.from({ length: losses }, (_, i) => o("LOSS", -1, extra, start + wins + i))];

describe("stats", () => {
  it("computes win rate with a Wilson interval, average R, profit factor and max drawdown, ignoring unresolved", () => {
    const s = computeStats([o("WIN", 2, {}, 1), o("LOSS", -1, {}, 2), o("LOSS", -1, {}, 3), o("WIN", 2, {}, 4), o("UNRESOLVED", null, {}, 5)], 30);
    expect(s).toMatchObject({ n: 5, resolved: 4, wins: 2, losses: 2, winRate: 0.5, avgR: 0.5, totalR: 2, profitFactor: 2, maxDrawdownR: 2, status: "INSUFFICIENT_EVIDENCE" });
    expect(s.winRateInterval?.lower).toBeLessThan(0.5);
  });
  it("is SUFFICIENT only with enough resolved outcomes, and empty input is all-null, not zero", () => {
    expect(computeStats(series(20, 20, 1), 30).status).toBe("SUFFICIENT"); expect(computeStats([], 30)).toMatchObject({ winRate: null, avgR: null, totalR: null, profitFactor: null, maxDrawdownR: null });
  });
});

describe("performance by condition", () => {
  it("names best and worst only among slices with enough evidence", () => {
    const all = [...series(40, 10, 1, { dims: { timeOfDay: "morning" } }), ...series(10, 40, 100, { dims: { timeOfDay: "AFTERNOON" } }), ...series(2, 0, 200, { dims: { timeOfDay: "CLOSING" } }), ...series(5, 5, 300, { dims: {} })];
    const c = conditionalPerformance(all, "timeOfDay");
    expect(c.best).toBe("MORNING"); expect(c.worst).toBe("AFTERNOON"); expect(c.slices.find((s) => s.value === "CLOSING")?.stats.status).toBe("INSUFFICIENT_EVIDENCE"); expect(c.unknown.resolved).toBe(10);
  });
  it("names no best or worst when fewer than two slices are sufficient", () => {
    const c = conditionalPerformance([...series(40, 10, 1, { dims: { regime: "TRENDING_UP" } }), ...series(3, 3, 100, { dims: { regime: "RANGE_BOUND" } })], "regime");
    expect(c.best).toBeNull(); expect(c.worst).toBeNull(); expect(c.note).toMatch(/fewer than two/);
  });
});

describe("drift and degradation", () => {
  it("needs enough resolved outcomes in both windows", () => { expect(detectDrift(series(10, 10, 1)).status).toBe("INSUFFICIENT_DATA"); });
  it("a steady strategy shows no drift", () => { expect(detectDrift([...series(30, 30, 1), ...series(15, 15, 100)]).status).toBe("NO_DRIFT"); });
  it("a clear fall in win rate and average R is DEGRADATION and produces an event to record", () => {
    const r = detectDrift([...series(42, 18, 1), ...series(8, 22, 100)]);
    expect(r.status).toBe("DEGRADATION"); expect(r.winRateDelta).toBeLessThan(0); expect(r.avgRDelta).toBeLessThan(0);
    expect(driftEventOf(r)).toMatchObject({ kind: "DEGRADATION", metric: "win_rate" });
  });
  it("a clear improvement is DRIFT (a change), not degradation", () => { const r = detectDrift([...series(15, 45, 1), ...series(24, 6, 100)]); expect(r.status).toBe("DRIFT"); expect(driftEventOf(r)?.kind).toBe("DRIFT"); });
  it("nothing to record when there is no drift or not enough data", () => { expect(driftEventOf(detectDrift(series(5, 5, 1)))).toBeNull(); expect(driftEventOf(detectDrift([...series(30, 30, 1), ...series(15, 15, 100)]))).toBeNull(); });
});

describe("stop-loss behaviour, reasons and revisions", () => {
  it("measures the stop-hit rate, results by stop width and winners that nearly hit the stop", () => {
    const s = stopBehaviour([o("WIN", 2, { stopDistancePct: 10, maeR: -0.9 }, 1), o("WIN", 2, { stopDistancePct: 10, maeR: -0.2 }, 2), o("LOSS", -1, { stopDistancePct: 40 }, 3), o("LOSS", -1, { stopDistancePct: null }, 4)]);
    expect(s.stopHitRate).toBe(0.5); expect(s.byBand.TIGHT.resolved).toBe(2); expect(s.byBand.WIDE.resolved).toBe(1); expect(s.byBand.UNKNOWN.resolved).toBe(1); expect(s.nearStopWinners).toEqual({ winners: 2, nearStop: 1, share: 0.5 });
  });
  it("breaks outcomes down by how they ended", () => {
    const r = reasonBreakdown([o("WIN", 2, { closeReason: "target" }, 1), o("WIN", 3, { closeReason: "TARGET" }, 2), o("LOSS", -1, { closeReason: "stop" }, 3), o("LOSS", -0.5, {}, 4)]);
    expect(r[0]).toMatchObject({ reason: "TARGET", count: 2, avgR: 2.5 }); expect(r.map((x) => x.reason)).toEqual(["TARGET", "STOP", "UNKNOWN"]);
  });
  it("reports how often calls are edited, how fast, and whether edited calls fared differently", () => {
    const r = revisionAnalysis([o("WIN", 1, { edited: true, firstEditDelaySec: 60 }, 1), o("LOSS", -1, { edited: true, firstEditDelaySec: 300 }, 2), o("WIN", 1, { edited: false }, 3), o("WIN", 1, {}, 4)]);
    expect(r.editedShare).toBeCloseTo(2 / 3, 3); expect(r.medianFirstEditDelaySec).toBe(180); expect(r.edited.resolved).toBe(2); expect(r.unedited.resolved).toBe(1);
  });
});

describe("counterfactual review (never a recommendation)", () => {
  const base = [...series(30, 30, 1, { rewardToRisk: 1, dims: { sessionBucket: "OPENING" } }), ...series(40, 10, 100, { rewardToRisk: 3, dims: { sessionBucket: "MORNING" } })];
  it("a minimum reward-to-risk filter shows the effect on the recorded outcomes", () => {
    const c = counterfactual(base, { kind: "min_reward_to_risk", minR: 2 }); expect(c.takenShare).toBeCloseTo(50 / 110, 3); expect(c.deltaAvgR).toBeGreaterThan(0); expect(c.note).toMatch(/not a recommendation/);
  });
  it("excluding a session bucket removes exactly those outcomes", () => { const c = counterfactual(base, { kind: "exclude", dimension: "sessionBucket", value: "opening" }); expect(c.counterfactual.resolved).toBe(50); });
  it("a tighter stop is an approximation and says so; trades that reached it become losses at that level", () => {
    const withMae = series(10, 0, 1, { maeR: -0.8 }).concat(series(10, 0, 50, { maeR: -0.1 }));
    const c = counterfactual(withMae, { kind: "stop_at_r", r: 0.5 }); expect(c.approximation).toMatch(/MAE/); expect(c.counterfactual.losses).toBe(10); expect(c.counterfactual.wins).toBe(10);
  });
  it("says so when there are too few outcomes", () => { expect(counterfactual(series(3, 3, 1, { rewardToRisk: 3 }), { kind: "min_reward_to_risk", minR: 2 }).note).toMatch(/too few/); });
});

import { activationRefusals, evaluateOutOfSample } from "../../../packages/historical/src/strategy/index";
describe("out-of-sample evaluation for activation", () => {
  const end = new Date(Date.UTC(2026, 0, 1) + 100 * 86_400_000), now = new Date(Date.UTC(2027, 0, 1));
  it("counts only outcomes after the learning window and up to now (out of sample by construction)", () => {
    const before = series(50, 50, 1), after = series(20, 15, 101), future = [o("WIN", 1, {}, 800)];
    const e = evaluateOutOfSample([...before, ...after, ...future], end, now);
    expect(e).toMatchObject({ outOfSample: true, resolved: 35, driftFlag: false }); expect(e.metrics.wins).toBe(20);
  });
  const alt = (n: number, start: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? o("WIN", 1.5, {}, start + i) : o("LOSS", -1, {}, start + i))); // interleaved: no artificial trend
  it("feeds the activation gate: too small is refused for the owner; enough resolved and no drift is allowed; drift is refused", () => {
    const owner = { kind: "OWNER" as const, id: "o" };
    expect(activationRefusals(owner, evaluateOutOfSample(series(5, 5, 101), end, now))).toEqual(["evaluation_sample_too_small"]);
    expect(activationRefusals(owner, evaluateOutOfSample(alt(80, 101), end, now))).toEqual([]);
    expect(activationRefusals(owner, evaluateOutOfSample([...series(42, 18, 101), ...series(8, 22, 300)], end, now))).toEqual(["drift_detected"]);
  });
});
