import { describe, expect, it } from "vitest";
import { DEFAULT_SIMILARITY, aggregateOutcomes, checkEvidenceCompleteness, compareCase, matchSimilar, type HistoricalCase, type SimilarityTarget } from "../../../packages/historical/src/similarity/index";

const T0 = new Date("2026-11-09T04:30:00Z");
const target: SimilarityTarget = { id: "now", at: T0, dimensions: { instrument: "NIFTY_CE", setup: "BREAKOUT", horizon: "INTRADAY", timeOfDay: "MORNING", expiryProximity: "NEAR", entryType: "ABOVE", stopDistance: "TIGHT", rewardRisk: "2_3", regime: "TRENDING_UP", volatility: "NORMAL" } };
const day = (n: number) => new Date(T0.getTime() - n * 86_400_000);
const mk = (id: string, ago: number, dims: HistoricalCase["dimensions"], outcome: HistoricalCase["outcome"] = "WIN", r: number | null = 1): HistoricalCase => ({ id, observedAt: day(ago), dimensions: dims, outcome, rMultiple: r });
const same = { ...target.dimensions };

describe("comparing one case with the target", () => {
  it("identical dimensions give similarity 1 and full coverage", () => { expect(compareCase(target, mk("a", 1, same), DEFAULT_SIMILARITY)).toMatchObject({ similarity: 1, coverage: 1, differing: [], unknown: [] }); });
  it("an unknown dimension on either side is NEVER a match: it lowers coverage and adds nothing to similarity", () => {
    const r = compareCase(target, mk("a", 1, { ...same, regime: null, volatility: "UNKNOWN_REGIME" }), DEFAULT_SIMILARITY);
    expect(r.unknown).toEqual(["regime", "volatility"]); expect(r.matched).not.toContain("regime"); expect(r.coverage).toBeCloseTo(1 - (2 + 1.5) / 14, 3); expect(r.similarity).toBe(1);
    const targetUnknown = compareCase({ ...target, dimensions: { ...same, setup: null } }, mk("a", 1, same), DEFAULT_SIMILARITY);
    expect(targetUnknown.unknown).toContain("setup");
  });
  it("differing known dimensions reduce similarity by their weight", () => {
    const r = compareCase(target, mk("a", 1, { ...same, instrument: "BANKNIFTY_PE" }), DEFAULT_SIMILARITY);
    expect(r.differing).toEqual(["instrument"]); expect(r.similarity).toBeCloseTo((14 - 3) / 14, 3);
  });
  it("comparison is case-insensitive", () => { expect(compareCase(target, mk("a", 1, { ...same, setup: "breakout" }), DEFAULT_SIMILARITY).matched).toContain("setup"); });
});

describe("matching and leakage control", () => {
  it("never uses the future, the target itself, thinly comparable cases, or dissimilar cases", () => {
    const cases = [
      mk("future", -1, same), mk("now", 1, same), mk("thin", 1, { instrument: "NIFTY_CE" }),
      mk("far", 1, { instrument: "X", setup: "GAP", horizon: "SCALPING", timeOfDay: "CLOSING", expiryProximity: "FAR", entryType: "BELOW", stopDistance: "WIDE", rewardRisk: "1_2", regime: "RANGE_BOUND", volatility: "HIGH" }),
      mk("good", 2, same),
    ];
    const r = matchSimilar(target, cases);
    expect(r.matches.map((m) => m.caseId)).toEqual(["good"]); expect(r.excluded).toEqual({ future: 1, sameId: 1, lowCoverage: 1, lowSimilarity: 1 });
  });
  it("ranks by similarity, then coverage, then recency, then id, deterministically", () => {
    const cases = [mk("b", 5, same), mk("a", 5, same), mk("recent", 1, same), mk("lower", 1, { ...same, setup: "GAP" })];
    const r = matchSimilar(target, cases);
    expect(r.matches.map((m) => m.caseId)).toEqual(["recent", "a", "b", "lower"]); expect(matchSimilar(target, cases)).toEqual(r);
  });
  it("caps the number of matches", () => { expect(matchSimilar(target, Array.from({ length: 10 }, (_, i) => mk(`c${i}`, i + 1, same)), { maxMatches: 3 }).matches).toHaveLength(3); });
});

describe("outcome aggregation: historical association, never a prediction", () => {
  it("reports INSUFFICIENT_EVIDENCE under the minimum resolved sample, with a warning, and still shows the counts", () => {
    const r = matchSimilar(target, [mk("a", 1, same, "WIN", 2), mk("b", 2, same, "LOSS", -1), mk("c", 3, same, "UNRESOLVED", null)]);
    expect(r.aggregate).toMatchObject({ considered: 3, resolved: 2, wins: 1, losses: 1, unresolved: 1, status: "INSUFFICIENT_EVIDENCE", winRate: 0.5, avgR: 0.5 });
    expect(r.notes.join(" ")).toMatch(/at least 30/); expect(r.notes[0]).toMatch(/not a prediction/);
  });
  it("is SUFFICIENT with enough resolved cases and carries a Wilson interval", () => {
    const cases = Array.from({ length: 40 }, (_, i) => mk(`c${i}`, i + 1, same, i % 2 === 0 ? "WIN" : "LOSS", i % 2 === 0 ? 1.5 : -1));
    const a = matchSimilar(target, cases, { maxMatches: 100 }).aggregate;
    expect(a.status).toBe("SUFFICIENT"); expect(a.winRate).toBe(0.5); expect(a.winRateInterval && a.winRateInterval.lower).toBeLessThan(0.5); expect(a.winRateInterval && a.winRateInterval.upper).toBeGreaterThan(0.5);
  });
  it("no comparable case is reported as missing evidence, not as neutral or positive", () => {
    const r = matchSimilar(target, []); expect(r.aggregate).toMatchObject({ status: "NO_COMPARABLE_CASES", winRate: null, avgR: null, winRateInterval: null }); expect(r.notes.join(" ")).toMatch(/missing evidence/);
  });
  it("unresolved cases never count as wins or losses", () => { expect(aggregateOutcomes([], DEFAULT_SIMILARITY).resolved).toBe(0); });
});

describe("evidence completeness", () => {
  const now = new Date("2026-11-09T05:00:00Z");
  const at = (min: number) => new Date(now.getTime() - min * 60_000);
  const full = [
    { kind: "source", id: "s", at: at(600) }, { kind: "classification", id: "c", at: at(590) }, { kind: "research_package", id: "r", at: at(20) }, { kind: "market_regime", id: "m", at: at(10) },
    { kind: "historical_comparison", id: "h", at: at(10) }, { kind: "confidence_assessment", id: "q", at: at(10) }, { kind: "risk_assessment", id: "k", at: at(5) }, { kind: "simulation", id: "x", at: at(5) },
  ] as const;
  it("is complete when every required kind is present and fresh", () => { expect(checkEvidenceCompleteness("DECISION", full, now)).toMatchObject({ complete: true, missing: [], stale: [], score: 1 }); });
  it("research needs only the source and classification", () => { expect(checkEvidenceCompleteness("RESEARCH", full.slice(0, 2), now).complete).toBe(true); });
  it("missing evidence is reported and lowers the score; it is never treated as positive", () => {
    const r = checkEvidenceCompleteness("DECISION", full.filter((i) => i.kind !== "market_regime" && i.kind !== "historical_comparison"), now);
    expect(r.complete).toBe(false); expect(r.missing).toEqual(["market_regime", "historical_comparison"]); expect(r.score).toBe(0.75);
  });
  it("stale evidence does not count", () => {
    const r = checkEvidenceCompleteness("DECISION", full.map((i) => (i.kind === "risk_assessment" ? { ...i, at: at(60) } : i)), now);
    expect(r.complete).toBe(false); expect(r.stale).toEqual(["risk_assessment"]); expect(r.present).not.toContain("risk_assessment");
  });
  it("fixture-backed evidence can never make a decision's evidence complete", () => {
    const r = checkEvidenceCompleteness("DECISION", full.map((i) => (i.kind === "market_regime" ? { ...i, dataSource: "FIXTURE" as const } : i)), now);
    expect(r.complete).toBe(false); expect(r.fixtureBacked).toEqual(["market_regime"]);
  });
  it("evidence dated after 'now' is ignored (no lookahead)", () => { expect(checkEvidenceCompleteness("RESEARCH", [{ kind: "source", id: "s", at: at(-5) }, { kind: "classification", id: "c", at: at(1) }], now).missing).toEqual(["source"]); });
});
