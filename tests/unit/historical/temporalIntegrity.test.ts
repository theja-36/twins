import { describe, expect, it } from "vitest";
import { bucketExpiryDays, bucketRewardRisk, bucketStopDistance, caseOutcomeOf, dimensionsOfClaim, historicalCaseFromRow, matchSimilar, type HistoricalCase, type SimilarityTarget } from "../../../packages/historical/src/similarity/index";

/**
 * Temporal integrity of historical matching: a decision made at time T may use only information available at T.
 * Adversarial, deterministic datasets (controlled timestamps). The matcher and the case builder are PURE, so this is a complete check of their behaviour; whether the ARCHIVE data itself carries correct times
 * is a property of the import (see the documented limitations), not something these tests can establish.
 */
const T0 = new Date("2031-01-06T05:00:00Z"), at = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const DIM = { instrument: "NIFTY", entryType: "above", timeOfDay: "MORNING", stopDistance: "STOP_10_20", rewardRisk: "RR_1_2", expiryProximity: "EXP_2_7D", setup: "BREAKOUT" } as const;
const target = (o: Partial<SimilarityTarget> = {}): SimilarityTarget => ({ id: "target", at: T0, dimensions: { ...DIM }, ...o });
const kase = (id: string, o: Partial<HistoricalCase> = {}): HistoricalCase => ({ id, observedAt: at(-600), dimensions: { ...DIM }, outcome: "WIN", rMultiple: 1.5, resolvedAt: at(-500), ...o });
const ids = (r: ReturnType<typeof matchSimilar>): string[] => r.matches.map((m) => m.caseId).sort();
const STRICT = { requireResolvedAt: true, minResolved: 1 };

describe("future information never reaches a match", () => {
  it("a case observed at or after the decision time is excluded (message time boundary)", () => {
    const r = matchSimilar(target(), [kase("before", { observedAt: at(-1) }), kase("exactly-now", { observedAt: at(0) }), kase("after", { observedAt: at(1) })], STRICT);
    expect(ids(r)).toEqual(["before"]); expect(r.excluded.future).toBe(2);
  });
  it("an outcome that became known AFTER the decision is not a win or a loss: the case is counted as unresolved", () => {
    const r = matchSimilar(target(), [kase("known", { resolvedAt: at(-30) }), kase("not-yet-known", { observedAt: at(-120), resolvedAt: at(30), outcome: "WIN" }), kase("resolves-exactly-now", { observedAt: at(-120), resolvedAt: at(0), outcome: "LOSS" })], STRICT);
    expect(r.aggregate).toMatchObject({ wins: 1, losses: 0, unresolved: 2, resolved: 1 }); expect(r.temporal.outcomeNotYetKnown).toBe(2);
    expect(r.matches.find((m) => m.caseId === "not-yet-known")).toMatchObject({ outcome: "UNRESOLVED", rMultiple: null });
    expect(r.notes.join(" ")).toMatch(/no outcome known at the decision time/);
  });
  it("without a recorded resolution time a resolved outcome cannot be proved to pre-date the decision, so a strict caller does not trust it", () => {
    const c = kase("no-time", { resolvedAt: null }); const strict = matchSimilar(target(), [c], STRICT), lax = matchSimilar(target(), [c], { minResolved: 1 });
    expect(strict.aggregate).toMatchObject({ resolved: 0, unresolved: 1 }); expect(strict.temporal.unknownResolutionTime).toBe(1);
    expect(lax.aggregate.resolved).toBe(1); // the legacy default is unchanged for older callers; the API always uses strict mode
  });
  it("the result is the same whether the future cases are present or not", () => {
    const past = [kase("a"), kase("b", { outcome: "LOSS", rMultiple: -1 })], future = [kase("f1", { observedAt: at(5) }), kase("f2", { observedAt: at(500), outcome: "LOSS" }), kase("f3", { observedAt: at(-10), resolvedAt: at(60), outcome: "WIN" })];
    const without = matchSimilar(target(), past, STRICT), withF = matchSimilar(target(), [...past, ...future], STRICT);
    expect(withF.aggregate.wins).toBe(without.aggregate.wins); expect(withF.aggregate.losses).toBe(without.aggregate.losses); expect(withF.matches.filter((m) => m.outcome !== "UNRESOLVED").map((m) => m.caseId)).toEqual(without.matches.map((m) => m.caseId));
  });
});

describe("revisions, duplicates, ordering", () => {
  it("an earlier revision of the target's OWN message is not a past case", () => {
    const r = matchSimilar(target({ groupKey: "chan:900" }), [kase("own-rev-1", { groupKey: "chan:900" }), kase("other", { groupKey: "chan:901" })], STRICT);
    expect(ids(r)).toEqual(["other"]); expect(r.temporal.sameGroup).toBe(1);
  });
  it("among several past revisions of one message only the latest counts, so a revised claim is not counted twice", () => {
    const r = matchSimilar(target(), [kase("v1", { groupKey: "chan:5", observedAt: at(-300), outcome: "LOSS" }), kase("v2", { groupKey: "chan:5", observedAt: at(-200), outcome: "WIN" }), kase("v3-future", { groupKey: "chan:5", observedAt: at(10), outcome: "LOSS" })], STRICT);
    expect(ids(r)).toEqual(["v2"]); expect(r.temporal.duplicateRevision).toBe(1); expect(r.excluded.future).toBe(1);
  });
  it("the same record twice with one id-group counts once; a case equal to the target id is excluded", () => {
    const r = matchSimilar(target(), [kase("x1", { groupKey: "g" }), kase("x2", { groupKey: "g", observedAt: at(-600) }), kase("target")], STRICT);
    expect(r.matches).toHaveLength(1); expect(r.excluded.sameId).toBe(1);
  });
  it("input order never changes the result (out-of-order and late-arriving records)", () => {
    const cs = [kase("a"), kase("b", { observedAt: at(-700), outcome: "LOSS" }), kase("c", { observedAt: at(-50) }), kase("d", { groupKey: "g", observedAt: at(-90) }), kase("e", { groupKey: "g", observedAt: at(-80), outcome: "LOSS" })];
    const base = JSON.stringify(matchSimilar(target(), cs, STRICT));
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 3, 0, 2, 4]]) expect(JSON.stringify(matchSimilar(target(), order.map((i) => cs[i] as HistoricalCase), STRICT))).toBe(base);
  });
  it("an UNKNOWN dimension never counts as a match, so thin evidence yields no comparable case rather than a favourable one", () => {
    const r = matchSimilar(target({ dimensions: { instrument: "NIFTY" } }), [kase("c", { dimensions: { instrument: "NIFTY" } })], STRICT); expect(r.aggregate.status).toBe("NO_COMPARABLE_CASES"); expect(r.excluded.lowCoverage).toBe(1);
  });
});

describe("building cases from the archive", () => {
  const row = (o: Record<string, unknown> = {}) => ({ caseId: "k1", messageTimestamp: at(-600), channelLabel: "chan", originalMessageId: "77", underlying: "NIFTY", entry: { type: "above", price: 118 }, stopLoss: 96, targets: [140, 165], expiryDate: null, finalOutcome: "WIN_T1", slFirstTouchAt: null, targetEvaluations: [{ index: 1, status: "TARGET_HIT", firstTouchAt: at(-500).toISOString() }], ...o });
  it("only a hit target or the stop resolve an outcome; every other label is UNRESOLVED (unknown is never a win or a loss)", () => {
    for (const [label, want] of [["WIN_T1", "WIN"], ["WIN_T2", "WIN"], ["WIN_T3", "WIN"], ["LOSS_SL", "LOSS"], ["NO_ENTRY", "UNRESOLVED"], ["EXPIRED_NO_ENTRY", "UNRESOLVED"], ["EXPIRED_AFTER_ENTRY", "UNRESOLVED"], ["INVALID_SIGNAL", "UNRESOLVED"], ["UNVERIFIABLE", "UNRESOLVED"], ["SOMETHING_NEW", "UNRESOLVED"]] as const) expect(caseOutcomeOf(label), label).toBe(want);
  });
  it("the resolution time is the first touch of the target that was hit, or of the stop", () => {
    expect(historicalCaseFromRow(row()).resolvedAt?.toISOString()).toBe(at(-500).toISOString());
    expect(historicalCaseFromRow(row({ finalOutcome: "LOSS_SL", slFirstTouchAt: at(-400) })).resolvedAt?.toISOString()).toBe(at(-400).toISOString());
    expect(historicalCaseFromRow(row({ finalOutcome: "WIN_T2" })).resolvedAt).toBeNull(); // T2 not in the evaluations: time unknown
    expect(historicalCaseFromRow(row({ finalOutcome: "UNVERIFIABLE" })).resolvedAt).toBeNull();
  });
  it("no r-multiple is invented, and revisions of one message share a group", () => {
    const c = historicalCaseFromRow(row()); expect(c.rMultiple).toBeNull(); expect(c.groupKey).toBe("chan:77"); expect(historicalCaseFromRow(row({ caseId: "k2" })).groupKey).toBe(c.groupKey);
  });
  it("an end-to-end replay: a case that resolves after the claim is demoted, one that resolved before it counts", () => {
    const early = historicalCaseFromRow(row({ caseId: "early" })), late = historicalCaseFromRow(row({ caseId: "late", originalMessageId: "78", messageTimestamp: at(-100), targetEvaluations: [{ index: 1, status: "TARGET_HIT", firstTouchAt: at(20).toISOString() }] }));
    const t = target({ dimensions: { ...early.dimensions } }); const r = matchSimilar(t, [early, late], { ...STRICT, minCoverage: 0.4 }); // archived cases carry no setup, regime or volatility, so the default 0.5 coverage floor would (correctly) reject them
    expect(r.matches.find((m) => m.caseId === "early")?.outcome).toBe("WIN"); expect(r.matches.find((m) => m.caseId === "late")?.outcome).toBe("UNRESOLVED");
  });
});

describe("dimensions: timezone, session and bucket boundaries", () => {
  const c = (extra: Record<string, unknown> = {}) => ({ underlying: "NIFTY", entry: { type: "above", price: 100 }, stopLoss: 90, targets: [120], expiryDate: null, ...extra });
  it("the session bucket follows IST, not UTC: the same UTC hour is a different session depending on the date's IST clock", () => {
    const d = (iso: string) => dimensionsOfClaim(c(), new Date(iso)).timeOfDay;
    expect(d("2031-01-06T03:44:00Z")).not.toBe(d("2031-01-06T03:46:00Z")); // 09:14 vs 09:16 IST around the open
    expect(d("2031-01-05T10:00:00Z")).toBe("WEEKEND"); // Sunday 15:30 IST
    expect(d("2031-01-06T10:30:00Z")).not.toBe(d("2031-01-06T09:00:00Z")); // after vs before the 15:30 IST close
  });
  it("expiry proximity counts IST calendar days, so a claim just after IST midnight sees the right date", () => {
    expect(dimensionsOfClaim(c({ expiryDate: "2031-01-07" }), new Date("2031-01-05T19:00:00Z")).expiryProximity).toBe("EXP_0_1D"); // 00:30 IST on 6 Jan: one day left
    expect(dimensionsOfClaim(c({ expiryDate: "2031-01-07" }), new Date("2031-01-05T17:00:00Z")).expiryProximity).toBe("EXP_2_7D"); // 22:30 IST on 5 Jan: two days
    expect(dimensionsOfClaim(c(), T0).expiryProximity).toBeUndefined(); // no stated expiry date: unknown, never inferred
  });
  it("buckets have fixed edges and unknowns stay unknown", () => {
    expect([bucketStopDistance(4.99), bucketStopDistance(5), bucketStopDistance(19.99), bucketStopDistance(20)]).toEqual(["STOP_LT_5", "STOP_5_10", "STOP_10_20", "STOP_GE_20"]);
    expect([bucketRewardRisk(0.99), bucketRewardRisk(1), bucketRewardRisk(2.99), bucketRewardRisk(3)]).toEqual(["RR_LT_1", "RR_1_2", "RR_2_3", "RR_GE_3"]);
    expect([bucketExpiryDays(-1), bucketExpiryDays(0), bucketExpiryDays(7), bucketExpiryDays(31)]).toEqual(["EXPIRED", "EXP_0_1D", "EXP_2_7D", "EXP_GT_30D"]);
    const none = dimensionsOfClaim({ underlying: null, entry: { type: "unspecified" }, stopLoss: null, targets: [], expiryDate: null }, T0); expect(Object.keys(none).sort()).toEqual(["timeOfDay"]);
    expect(dimensionsOfClaim(c({ stopLoss: null }), T0)).not.toHaveProperty("stopDistance"); expect(dimensionsOfClaim(c({ targets: [] }), T0)).not.toHaveProperty("rewardRisk");
  });
});
