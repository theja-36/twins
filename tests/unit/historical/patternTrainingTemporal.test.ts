import { describe, expect, it } from "vitest";
import { PATTERN_ALGORITHM_VERSION } from "../../../packages/historical/src/patterns/stats";
import { selectTraining } from "../../../packages/historical/src/patterns/training";
import type { ScoredSignal } from "../../../packages/historical/src/scorecards/metrics";

/**
 * SYNTHETIC. G-40: the pattern embargo (default 30 days) is not tied to the evaluation horizon (up to 365 days). A signal just outside the embargo can carry a label that resolves AFTER the as-of
 * instant; a run "as of" T must not learn from an outcome that was not yet known at T. (Before the fix, the REPRODUCTION, boundary, unknown-resolution and ordering tests below failed.)
 */
const DAY = 86_400_000, ASOF = new Date("2025-06-01T00:00:00Z");
const sample = (daysBeforeAsOf: number, resolvesDaysAfterMessage: number | null | undefined, outcome: string | null = "WIN_T1") => {
  const at = new Date(ASOF.getTime() - daysBeforeAsOf * DAY);
  const scored: ScoredSignal = { key: `c|${daysBeforeAsOf}`, at, isSignal: true, outcome, targetHits: outcome === "WIN_T1" ? [true, false, false] : [false, false, false], dataQuality: outcome ? "GOOD" : null, slPresent: true, slValid: true, revisions: 0, adverseSlRevision: false, evidenceConflict: false,
    ...(resolvesDaysAfterMessage === undefined ? {} : { resolvedAt: resolvesDaysAfterMessage === null ? null : new Date(at.getTime() + resolvesDaysAfterMessage * DAY) }) };
  return { at, scored };
};

describe("pattern training only learns outcomes that were known at the as-of instant (G-40)", () => {
  it("REPRODUCTION: a 90-day-horizon label on a signal 31 days before as-of resolves 59 days AFTER as-of; it must not be training evidence", () => {
    const t = selectTraining([sample(31, 90)], ASOF, 30);
    expect(t).toHaveLength(1); // the signal itself is outside the embargo and stays (its message was sent)
    expect(t[0]!.scored.outcome).toBeNull(); // but its outcome was unknowable at as-of
    expect(t[0]!.scored.targetHits).toEqual([false, false, false]);
  });
  it("an outcome that resolved before as-of is kept exactly", () => {
    expect(selectTraining([sample(60, 10)], ASOF, 30)[0]!.scored.outcome).toBe("WIN_T1");
  });
  it("the boundary: resolving exactly at as-of is known; a millisecond later is not", () => {
    const at = new Date(ASOF.getTime() - 40 * DAY);
    const mk = (resolved: Date): { at: Date; scored: ScoredSignal } => ({ at, scored: { ...sample(40, 0).scored, at, resolvedAt: resolved } });
    expect(selectTraining([mk(ASOF)], ASOF, 30)[0]!.scored.outcome).toBe("WIN_T1");
    expect(selectTraining([mk(new Date(ASOF.getTime() + 1))], ASOF, 30)[0]!.scored.outcome).toBeNull();
  });
  it("an unknown resolution time is never used; a signal with no label stays unevaluated; fixtures that carry no resolution time are untouched", () => {
    expect(selectTraining([sample(60, null)], ASOF, 30)[0]!.scored.outcome).toBeNull();
    expect(selectTraining([sample(60, undefined, null)], ASOF, 30)[0]!.scored.outcome).toBeNull();
    expect(selectTraining([sample(60, undefined)], ASOF, 30)[0]!.scored.outcome).toBe("WIN_T1");
  });
  it("the embargo still excludes recent messages, and the result never depends on input order", () => {
    const a = sample(10, 1), b = sample(60, 1), c = sample(45, 100);
    const one = selectTraining([a, b, c], ASOF, 30), two = selectTraining([c, b, a], ASOF, 30);
    expect(one.map((x) => x.scored.key).sort()).toEqual(["c|45", "c|60"]);
    expect(two.map((x) => x.scored.key).sort()).toEqual(one.map((x) => x.scored.key).sort());
    expect(one.find((x) => x.scored.key === "c|45")!.scored.outcome).toBeNull();
  });
  it("a later as-of makes the same signal's outcome count: knowledge only moves forward", () => {
    expect(selectTraining([sample(31, 90)], new Date(ASOF.getTime() + 60 * DAY), 30)[0]!.scored.outcome).toBe("WIN_T1");
  });
});

describe("versioning", () => {
  it("point-in-time training is a new algorithm version, so stored v1 runs stay distinguishable and are never presented as point-in-time", () => {
    expect(PATTERN_ALGORITHM_VERSION).toBe("pattern-metrics-v2");
  });
});
