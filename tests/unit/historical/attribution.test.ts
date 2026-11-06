import { describe, expect, it } from "vitest";
import { buildAttribution, sessionOf, weekdayOf, wilson, type AttributionRow } from "../../../packages/historical/src/attribution/attribution";
import { renderText } from "../../../scripts/ops/outcome-attribution";

// 2026-11-02 is a Monday. 04:30Z = 10:00 IST (OPENING); 07:00Z = 12:30 IST (MIDDAY).
const row = (i: number, o: Partial<AttributionRow> = {}): AttributionRow => ({
  key: `k${i}`, source: "A", market: "NIFTY", side: "buy", at: new Date("2026-11-02T04:30:00Z"), outcome: "WIN_T1", dataQuality: "GOOD", ...o,
});
const many = (n: number, o: Partial<AttributionRow>, start = 0): AttributionRow[] => Array.from({ length: n }, (_, i) => row(start + i, o));

describe("attribution buckets", () => {
  it("maps IST sessions and weekdays", () => {
    expect(sessionOf(new Date("2026-11-02T03:30:00Z"))).toBe("PRE_OPEN"); // 09:00 IST
    expect(sessionOf(new Date("2026-11-02T04:30:00Z"))).toBe("OPENING");
    expect(sessionOf(new Date("2026-11-02T07:00:00Z"))).toBe("MIDDAY");
    expect(sessionOf(new Date("2026-11-02T09:30:00Z"))).toBe("CLOSING"); // 15:00 IST
    expect(sessionOf(new Date("2026-11-02T11:00:00Z"))).toBe("AFTER_HOURS");
    expect(weekdayOf(new Date("2026-11-02T04:30:00Z"))).toBe("MON");
    expect(weekdayOf(new Date("2026-11-01T20:00:00Z"))).toBe("MON"); // 01:30 IST Monday
  });
  it("wilson interval is null for n=0 and brackets the rate", () => {
    expect(wilson(0, 0)).toBeNull();
    const w = wilson(15, 30)!;
    expect(w.low).toBeLessThan(0.5);
    expect(w.high).toBeGreaterThan(0.5);
  });
});

describe("buildAttribution", () => {
  it("computes R, win rate and counts unscored/unevaluated separately", () => {
    const rows = [row(1), row(2, { outcome: "WIN_T2" }), row(3, { outcome: "LOSS_SL" }), row(4, { outcome: "NO_ENTRY" }), row(5, { outcome: "UNVERIFIABLE" }), row(6, { outcome: null })];
    const r = buildAttribution(rows, { minSample: 2 });
    expect(r.overall).toMatchObject({ evaluable: 4, entered: 3, wins: 2, losses: 1, unscored: 1, totalR: 2 });
    expect(r.overall.winRateEntered).toBeCloseTo(2 / 3, 5);
    expect(r.overall.expectancyR).toBe(0.5);
    expect(r.notEvaluated).toBe(1);
  });
  it("flags thin strata and never calls them different", () => {
    const rows = [...many(40, { source: "A", outcome: "WIN_T1" }), ...many(5, { source: "B", outcome: "LOSS_SL" }, 100)];
    const r = buildAttribution(rows, { dimensions: ["source"] });
    const b = r.strata.find((s) => s.value === "B")!;
    expect(b.thin).toBe(true);
    expect(b.reading).toBe("THIN");
    expect(b.differsFromOverall).toBeNull();
  });
  it("marks a readable stratum as differing only when its interval excludes the overall rate", () => {
    const rows = [...many(60, { source: "A", outcome: "LOSS_SL" }), ...many(60, { source: "B", outcome: "WIN_T1" }, 200), ...many(60, { source: "C", outcome: "WIN_T1" }, 400), ...many(60, { source: "C", outcome: "LOSS_SL" }, 600)];
    const r = buildAttribution(rows, { dimensions: ["source"] });
    const get = (v: string) => r.strata.find((s) => s.value === v)!;
    expect(get("A").differsFromOverall).toBe(true);
    expect(get("B").differsFromOverall).toBe(true);
    expect(get("C").reading).toBe("READABLE");
    expect(get("C").differsFromOverall).toBe(false);
  });
  it("is deterministic regardless of input order and lists unavailable factors", () => {
    const rows = [row(1), row(2, { outcome: "LOSS_SL", source: "B" }), row(3, { at: new Date("2026-11-03T07:00:00Z") })];
    const a = buildAttribution(rows);
    const b = buildAttribution([...rows].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.unavailable.map((u) => u.factor)).toEqual(["agentVerdict", "confidenceTier", "expiryProximity", "executionEffects"]);
    expect(a.grantsApproval).toBe(false);
    expect(a.usedForDecisions).toBe(false);
  });
  it("handles an empty input", () => {
    const r = buildAttribution([]);
    expect(r.overall.evaluable).toBe(0);
    expect(r.overall.winRateEntered).toBeNull();
    expect(r.strata).toEqual([]);
  });
  it("renders text with THIN markers", () => {
    const text = renderText(buildAttribution([row(1), row(2, { source: "B", outcome: "LOSS_SL" })], { dimensions: ["source"] })).join("\n");
    expect(text).toContain("THIN");
    expect(text).toContain("not attributable yet");
  });
});
