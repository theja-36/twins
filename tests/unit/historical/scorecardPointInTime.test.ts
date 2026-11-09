import { describe, expect, it } from "vitest";
import { computeWindows, type ScoredSignal } from "../../../packages/historical/src/scorecards/index";
import { resolutionTime } from "../../../packages/historical/src/scorecards/run";

/** SYNTHETIC. G-39 (owner-approved): a scorecard as of T counts only outcomes that had resolved by T. Point-in-time is the only behaviour (source-scorecard-v2). */
const DAY = 86_400_000, T0 = Date.parse("2024-01-01T00:00:00Z"), cfg = { costPerTradeR: 0 };
const sig = (i: number, o: string | null, resolvedAt: Date | null | undefined): ScoredSignal => ({ key: `c|${i}`, at: new Date(T0 + i * DAY), isSignal: true, outcome: o, targetHits: o === "WIN_T1" ? [true, false, false] : [false, false, false], dataQuality: o ? "GOOD" : null, slPresent: true, slValid: true, revisions: 0, adverseSlRevision: false, evidenceConflict: false, ...(resolvedAt !== undefined ? { resolvedAt } : {}) });
const all = (w: ReturnType<typeof computeWindows>) => w.find((x) => x.windowType === "ALL_TIME")!;
const asOf = new Date(T0 + 10 * DAY);

describe("point-in-time outcomes in scorecard windows", () => {
  const input = [sig(0, "WIN_T1", new Date(T0 + 2 * DAY)), sig(9, "WIN_T1", new Date(T0 + 15 * DAY)), sig(8, "LOSS_SL", null)];
  it("an outcome resolving after as-of, or with an unknown resolution time, is not yet evaluated", () => {
    const w = all(computeWindows(input, asOf, cfg));
    expect(w.sampleSize).toBe(1); expect(w.metrics.wins).toBe(1); expect(w.metrics.losses).toBe(0);
  });
  it("an outcome resolving exactly at as-of is known; one later by a millisecond is not", () => {
    const edge = [sig(0, "WIN_T1", asOf), sig(1, "WIN_T1", new Date(asOf.getTime() + 1))];
    expect(all(computeWindows(edge, asOf, cfg)).sampleSize).toBe(1);
  });
  it("signals that carry no resolution time (no label) are untouched: nothing is invented", () => {
    expect(all(computeWindows([sig(0, "WIN_T1", undefined)], asOf, cfg)).sampleSize).toBe(1);
  });
  it("a later as-of makes the same signal count: the result moves forward in time, never backward", () => {
    const late = new Date(T0 + 20 * DAY);
    expect(all(computeWindows(input, late, cfg)).sampleSize).toBe(2); // the null-resolution loss still cannot be established
  });
});

describe("resolution time of a label", () => {
  const at = new Date(T0), t = (d: number) => new Date(T0 + d * DAY).toISOString(), DAILY = { intervalSeconds: 86_400 };
  it("wins resolve at the latest hit target; losses at the stop touch; invalid at the message; others at the window end", () => {
    expect(resolutionTime("WIN_T2", at, [{ status: "TARGET_HIT", firstTouchAt: t(1) }, { status: "TARGET_HIT", firstTouchAt: t(3) }], null, DAILY)?.toISOString()).toBe(t(4)); // the bar starting at day 3 closes at day 4
    expect(resolutionTime("LOSS_SL", at, [], new Date(T0 + 2 * DAY), DAILY)?.toISOString()).toBe(t(3));
    expect(resolutionTime("INVALID_SIGNAL", at, [], null, {})).toEqual(at);
    expect(resolutionTime("EXPIRED_NO_ENTRY", at, [], null, { validityEnd: t(5) })?.toISOString()).toBe(t(5));
  });
  it("is null (unknown) when a hit target has no time, a loss has no stop touch, the bar length is not recorded, or no window end exists", () => {
    expect(resolutionTime("WIN_T1", at, [{ status: "TARGET_HIT", firstTouchAt: t(1) }], null, {})).toBeNull(); // touch known, bar length not
    expect(resolutionTime("LOSS_SL", at, [], new Date(T0 + DAY), {})).toBeNull();
    expect(resolutionTime("WIN_T1", at, [{ status: "TARGET_HIT", firstTouchAt: null }], null, DAILY)).toBeNull();
    expect(resolutionTime("LOSS_SL", at, [], null, {})).toBeNull();
    expect(resolutionTime("EXPIRED_NO_ENTRY", at, [], null, {})).toBeNull();
  });
});

import { isPointInTimeScorecard, SCORECARD_ALGORITHM_VERSION } from "../../../packages/historical/src/scorecards/index";
describe("legacy scorecards stay distinguishable and are never presented as point in time", () => {
  it("v2 and later are point in time; v1, unknown and missing versions are not", () => {
    expect(SCORECARD_ALGORITHM_VERSION).toBe("source-scorecard-v2");
    expect(isPointInTimeScorecard("source-scorecard-v2")).toBe(true); expect(isPointInTimeScorecard("source-scorecard-v3")).toBe(true);
    for (const v of ["source-scorecard-v1", "source-scorecard-v1+trust-tier-v1", "", null, undefined, "other-v9"]) expect(isPointInTimeScorecard(v as never), String(v)).toBe(false);
  });
});
