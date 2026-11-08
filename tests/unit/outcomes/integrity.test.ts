import { describe, expect, it } from "vitest";
import { calibratedProbability } from "../../../packages/confidence/src/index";
import { buildCalibrationDataset, distributionShift, loadOutcomeLearningConfig, monitorPerformanceDrift, runCalibration, windowTallies, DEFAULT_OUTCOME_LEARNING } from "../../../packages/outcomes/src/index";
import { loss, rec, T0, win } from "./fixtures";

const series = (n: number, winOf: (score: number) => boolean, o: Partial<Parameters<typeof rec>[0]> = {}) => Array.from({ length: n }, (_, i) => { const score = (i * 7) % 100; return (winOf(score) ? win : loss)({ confidenceScore: score, closedAt: new Date(T0 + i * 60_000), openedAt: new Date(T0 - 3_600_000 + i * 1000), confidenceAt: new Date(T0 - 7_200_000), ...o }); });

describe("calibration evidence", () => {
  it("excludes fixture-backed, score-less, look-ahead, mismatched and non-final records and counts why", () => {
    const rs = [...series(5, () => true), win({ dataSource: "FIXTURE" }), win({ confidenceScore: null, confidenceAt: null }), win({ confidenceAt: new Date(T0 + 99_999_999) }), win({ dataQuality: ["OUTCOME_PNL_MISMATCH"] }), rec({ finality: "PARTIAL", outcomeId: null, closedAt: null, netPnl: "1.00" }), win({ mode: "LIVE" as never })];
    const ds = buildCalibrationDataset(rs, 0.4);
    expect(ds.excluded).toEqual({ FIXTURE_DATA: 1, NO_CONFIDENCE_SCORE: 1, LOOKAHEAD: 1, OUTCOME_MISMATCH: 1, NOT_FINAL: 1 });
    expect(ds.fit.length + ds.holdout.length).toBe(5); expect(ds.holdout.every((s) => s.outOfSample)).toBe(true); expect(ds.fit.every((s) => !s.outOfSample)).toBe(true);
  });
  it("the held-out set is strictly later than the fit set (chronological, no look-ahead)", () => {
    const ds = buildCalibrationDataset(series(100, () => true), 0.4);
    expect(ds.fit.length).toBe(60); expect(ds.holdout.length).toBe(40);
    expect(Math.max(...ds.fit.map((s) => Date.parse(s.at)))).toBeLessThan(Math.min(...ds.holdout.map((s) => Date.parse(s.at))));
  });
  it("with no valid outcome nothing is calibrated and there is no probability", () => {
    const r = runCalibration([], 0.4); expect(r.status).toBe("UNCALIBRATED"); expect(r.reasons.join(" ")).toMatch(/no valid, non-fixture outcome/); expect(calibratedProbability(80, r.run)).toBeNull();
  });
  it("fixture data can never calibrate, however much of it there is", () => {
    const r = runCalibration(series(2000, (s) => (s * 13) % 100 < s, { dataSource: "FIXTURE" }), 0.4);
    expect(r.status).toBe("UNCALIBRATED"); expect(r.holdoutSize).toBe(0); expect(r.excluded["FIXTURE_DATA"]).toBe(2000); expect(calibratedProbability(90, r.run)).toBeNull();
  });
  it("fewer than 200 held-out outcomes stay CALIBRATING: the threshold is not lowered", () => {
    const r = runCalibration(series(400, (s) => (s * 13) % 100 < s), 0.4); // 160 held out
    expect(r.holdoutSize).toBe(160); expect(r.status).toBe("CALIBRATING"); expect(r.run.reasons.join(" ")).toMatch(/minimum 200/); expect(calibratedProbability(90, r.run)).toBeNull();
    const c = runCalibration(series(500, (s) => (s * 13) % 100 < s), 0.4); // exactly 200 held out
    expect(c.holdoutSize).toBe(200);
  });
  it("calibrates only when the win rate rises with the score across populated score groups and is stable between periods", () => {
    const good = runCalibration(series(1500, (s) => (s * 13) % 100 < s), 0.4);
    expect(good.holdoutSize).toBe(600); expect(good.status).toBe("CALIBRATED"); expect(good.run.outOfSample).toBe(true);
    expect(calibratedProbability(90, good.run)!).toBeGreaterThan(calibratedProbability(10, good.run)!);
    const inverted = runCalibration(series(1500, (s) => (s * 13) % 100 < 100 - s), 0.4);
    expect(inverted.status).toBe("CALIBRATING"); expect(inverted.reasons.join(" ")).toMatch(/falls between bins/); expect(calibratedProbability(90, inverted.run)).toBeNull();
  });
  it("a relationship that held in the fit period but not in the held-out period is rejected as unstable", () => {
    const rs = [...series(900, (s) => (s * 13) % 100 < s), ...series(600, (s) => (s * 13) % 100 < Math.max(0, s - 40)).map((r, i) => ({ ...r, closedAt: new Date(T0 + 100_000_000 + i * 60_000), id: `x${i}`, paperPositionId: `px${i}`, openedAt: new Date(T0 + 99_000_000) }))];
    const r = runCalibration(rs, 0.4);
    expect(r.status).not.toBe("CALIBRATED"); expect(r.stability.unstableBands.length).toBeGreaterThan(0); expect(r.reasons.join(" ")).toMatch(/moved by more than 15 points|falls between/);
  });
  it("the 200 floor is not configurable: no setting exists for it, and the statistical floors cannot be lowered", () => {
    expect(Object.keys(DEFAULT_OUTCOME_LEARNING).join(",")).not.toMatch(/calibrat|oos|outOfSample/i);
    expect(() => loadOutcomeLearningConfig({ TWINS_LEARNING_MIN_SAMPLE: "10" })).toThrow(); expect(() => loadOutcomeLearningConfig({ TWINS_LEARNING_MIN_DRIFT_WINDOW: "29" })).toThrow();
    expect(loadOutcomeLearningConfig({})).toMatchObject({ enabled: false, minSample: 30, minDriftWindow: 30 });
    for (const e of [{ TWINS_LEARNING_ENABLED: "yes" }, { TWINS_LEARNING_HOLDOUT_FRACTION: "0.9" }, { TWINS_LEARNING_BATCH: "0" }, { TWINS_LEARNING_INTERVAL_MS: "5" }]) expect(() => loadOutcomeLearningConfig(e)).toThrow();
  });
});

describe("drift and degradation", () => {
  const strat = (v: string, n: number, winOf: (i: number) => boolean) => Array.from({ length: n }, (_, i) => (winOf(i) ? win : loss)({ detectorVersion: v, closedAt: new Date(T0 + i * 60_000) }));
  it("INSUFFICIENT_DATA is reported as such (not as 'no drift'), and raises no warning", () => {
    const f = monitorPerformanceDrift(strat("v1", 40, () => true), 30);
    expect(f.find((x) => x.subjectKind === "STRATEGY_VERSION")!.report.status).toBe("INSUFFICIENT_DATA"); expect(f.every((x) => !x.warn)).toBe(true);
  });
  it("a clear fall in win rate AND mean R is DEGRADATION; steady performance is not flagged", () => {
    const bad = monitorPerformanceDrift(strat("v1", 120, (i) => (i < 90 ? i % 4 !== 0 : i % 4 === 0)), 30).find((x) => x.subjectKind === "STRATEGY_VERSION")!;
    expect(bad.report.status).toBe("DEGRADATION"); expect(bad.warn).toBe(true);
    const steady = monitorPerformanceDrift(strat("v1", 120, (i) => i % 2 === 0), 30).find((x) => x.subjectKind === "STRATEGY_VERSION")!;
    expect(steady.report.status).toBe("NO_DRIFT"); expect(steady.warn).toBe(false);
  });
  it("versions are compared like-for-like: a bad new version never drags down the old one", () => {
    const rs = [...strat("v1", 120, (i) => i % 2 === 0), ...strat("v2", 120, (i) => (i < 90 ? i % 4 !== 0 : i % 4 === 0)).map((r, i) => ({ ...r, id: `b${i}`, paperPositionId: `pb${i}` }))];
    const f = monitorPerformanceDrift(rs, 30).filter((x) => x.subjectKind === "STRATEGY_VERSION");
    expect(f.find((x) => x.subject === "BREAKOUT@v1")!.warn).toBe(false); expect(f.find((x) => x.subject === "BREAKOUT@v2")!.warn).toBe(true);
  });
  it("a distribution shift needs enough observations in both windows", () => {
    expect(distributionShift({ A: 5 }, { B: 5 }, 30).status).toBe("INSUFFICIENT_DATA");
    expect(distributionShift({ A: 40, B: 10 }, { A: 38, B: 12 }, 30).status).toBe("NO_SHIFT");
    expect(distributionShift({ A: 45, B: 5 }, { A: 10, B: 40 }, 30)).toMatchObject({ status: "SHIFT" });
    const w = windowTallies(["a", "a", "b", "b", "b"], 2, (x) => x); expect(w).toEqual({ baseline: { a: 2, b: 1 }, recent: { b: 2 } });
  });
});
