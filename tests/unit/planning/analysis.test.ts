import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { impliedMove, kellyAnalysis } from "../../../packages/planning/src";

describe("Kelly research analysis (M10-19)", () => {
  it("computes exact fractions and is research-only", () => {
    const r = kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: 50 });
    expect(r).toMatchObject({ status: "OK", fullKellyFraction: "0.3333", halfKellyFraction: "0.1666", researchOnly: true, affectsSizing: false });
  });
  it("reports no edge as zero, not negative", () => {
    expect(kellyAnalysis({ winRate: "0.3", payoffRatio: "1", sample: 50 })).toMatchObject({ status: "OK", fullKellyFraction: "0.0000", edgePositive: false });
  });
  it("refuses small samples and invalid inputs", () => {
    expect(kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: 10 })).toMatchObject({ status: "REFUSED", reason: "SAMPLE_TOO_SMALL" });
    expect(kellyAnalysis({ winRate: "1", payoffRatio: "1.5", sample: 50 })).toMatchObject({ reason: "WIN_RATE_INVALID" });
    expect(kellyAnalysis({ winRate: "abc", payoffRatio: "1.5", sample: 50 })).toMatchObject({ reason: "WIN_RATE_INVALID" });
    expect(kellyAnalysis({ winRate: "0.5", payoffRatio: "0", sample: 50 })).toMatchObject({ reason: "PAYOFF_INVALID" });
    expect(kellyAnalysis({ winRate: "0", payoffRatio: "1.5", sample: 50 })).toMatchObject({ reason: "WIN_RATE_INVALID" });
    expect(kellyAnalysis({ winRate: "-0.2", payoffRatio: "1.5", sample: 50 })).toMatchObject({ reason: "WIN_RATE_INVALID" });
    expect(kellyAnalysis({ winRate: "0.5", payoffRatio: "-1", sample: 50 })).toMatchObject({ reason: "PAYOFF_INVALID" });
    expect(kellyAnalysis({ winRate: "0.5", payoffRatio: "x", sample: 50 })).toMatchObject({ reason: "PAYOFF_INVALID" });
    expect(kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: 30.5 })).toMatchObject({ reason: "SAMPLE_TOO_SMALL" });
    expect(kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: -1 })).toMatchObject({ reason: "SAMPLE_TOO_SMALL" });
  });
  it("the 30-outcome minimum is exact: 29 refuses, 30 computes", () => {
    expect(kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: 29 })).toMatchObject({ status: "REFUSED" });
    expect(kellyAnalysis({ winRate: "0.6", payoffRatio: "1.5", sample: 30 })).toMatchObject({ status: "OK" });
  });
  it("rounds fractions DOWN, never up", () => {
    // p=0.7, b=1 => f=0.4 exactly; p=0.55,b=1.3 => f=0.55-0.45/1.3=0.20384615... -> 0.2038 (not 0.2039)
    expect(kellyAnalysis({ winRate: "0.55", payoffRatio: "1.3", sample: 40 })).toMatchObject({ fullKellyFraction: "0.2038", halfKellyFraction: "0.1019" });
  });
  it("is reproducible", () => {
    const a = { winRate: "0.55", payoffRatio: "1.2", sample: 40 };
    expect(kellyAnalysis(a)).toEqual(kellyAnalysis(a));
  });
});

describe("implied-move analysis (M11-04)", () => {
  const now = new Date("2026-01-05T10:00:00Z"), fresh = new Date("2026-01-05T09:59:30Z");
  const leg = (premium: string | null, o: Record<string, unknown> = {}) => ({ strike: "22000", expiry: "2026-01-29", premium, ...o });
  const ok = { underlying: "22050", call: leg("150.25"), put: leg("140.75"), quoteAsOf: fresh, now, maxAgeSeconds: 60 };
  it("derives the move from the straddle, labelled an estimate and never guaranteed", () => {
    expect(impliedMove(ok)).toMatchObject({ status: "OK", impliedMove: "291.00", impliedMovePct: "1.31", upperBound: "22341.00", lowerBound: "21759.00", guaranteed: false, estimate: true, affectsSizing: false });
  });
  it("refuses on missing data", () => {
    expect(impliedMove({ ...ok, underlying: null })).toMatchObject({ reason: "UNDERLYING_MISSING" });
    expect(impliedMove({ ...ok, underlying: "0" })).toMatchObject({ reason: "UNDERLYING_MISSING" });
    expect(impliedMove({ ...ok, call: null })).toMatchObject({ reason: "STRADDLE_MISSING" });
    expect(impliedMove({ ...ok, put: leg(null) })).toMatchObject({ reason: "STRADDLE_MISSING" });
    expect(impliedMove({ ...ok, put: leg("140", { expiry: null }) })).toMatchObject({ reason: "STRADDLE_MISSING" });
  });
  it("refuses invalid values", () => {
    expect(impliedMove({ ...ok, put: leg("0") })).toMatchObject({ reason: "STRADDLE_MISSING" });
    expect(impliedMove({ ...ok, put: leg("-5") })).toMatchObject({ reason: "STRADDLE_MISSING" });
    expect(impliedMove({ ...ok, call: leg("abc") })).toMatchObject({ reason: "STRADDLE_MISSING" });
  });
  it("refuses stale, future-dated and missing-time quotes", () => {
    expect(impliedMove({ ...ok, quoteAsOf: new Date("2026-01-05T09:00:00Z") })).toMatchObject({ reason: "STRADDLE_STALE" });
    expect(impliedMove({ ...ok, quoteAsOf: new Date("2026-01-05T10:05:00Z") })).toMatchObject({ reason: "STRADDLE_STALE" });
    expect(impliedMove({ ...ok, quoteAsOf: null })).toMatchObject({ reason: "STRADDLE_STALE" });
  });
  it("refuses contradictory quotes: mismatched strike or expiry, or a premium above the underlying", () => {
    expect(impliedMove({ ...ok, put: leg("140.75", { strike: "22100" }) })).toMatchObject({ reason: "STRADDLE_CONTRADICTORY" });
    expect(impliedMove({ ...ok, put: leg("140.75", { expiry: "2026-02-26" }) })).toMatchObject({ reason: "STRADDLE_CONTRADICTORY" });
    expect(impliedMove({ ...ok, call: leg("22050") })).toMatchObject({ reason: "STRADDLE_CONTRADICTORY" });
  });
  it("refuses a straddle that is not at the money", () => {
    expect(impliedMove({ ...ok, call: leg("150.25", { strike: "23000" }), put: leg("140.75", { strike: "23000" }) })).toMatchObject({ reason: "NOT_AT_THE_MONEY" });
    expect(impliedMove({ ...ok, atmTolerancePct: "0" })).toMatchObject({ reason: "NOT_AT_THE_MONEY" });
  });
  it("is reproducible and invents nothing: the same input gives the same output", () => {
    expect(impliedMove(ok)).toEqual(impliedMove(ok));
  });
});

describe("research analyses are disconnected from sizing, risk and eligibility", () => {
  it("no decision-path source imports or references them", () => {
    const dir = join(__dirname, "../../../packages");
    for (const f of ["planning/src/sizing.ts", "planning/src/risk.ts", "planning/src/evaluate.ts", "planning/src/cycle.ts", "planning/src/simulator.ts", "confidence/src/score.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/kellyAnalysis|impliedMove|from "\.\/analysis"/);
    }
  });
});
