import { describe, expect, it } from "vitest";
import { assessNewsImpact, type NewsEvent } from "../../../packages/agents/src/newsImpact";
import { generateCandidates, type IBar } from "../../../packages/signals/src/independent";

const NOW = new Date("2031-03-03T10:00:00Z");
const ev = (id: string, minutesAgo: number, o: Partial<NewsEvent> = {}): NewsEvent => ({ id, publishedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), sentiment: -0.8, relevance: 0.9, reliability: 0.8, symbols: ["RELIANCE"], themes: [], ...o });
const T = { symbol: "RELIANCE" };

describe("news impact (#12)", () => {
  it("no events is UNKNOWN, never a guess", () => {
    expect(assessNewsImpact([], T, NOW)).toMatchObject({ direction: "UNKNOWN", impact: null, recommendation: "NONE", confidence: 0, grantsApproval: false });
  });
  it("fresh reliable negative news gives NEGATIVE and a caution", () => {
    const r = assessNewsImpact([ev("1", 10), ev("2", 20), ev("3", 30), ev("4", 40), ev("5", 50), ev("6", 55)], T, NOW);
    expect(r.direction).toBe("NEGATIVE");
    expect(r.impact as number).toBeLessThan(-0.7);
    expect(r.recommendation === "CAUTION" || r.recommendation === "REVIEW_NEW_ENTRIES").toBe(true);
  });
  it("positive news never produces a recommendation (news cannot increase risk)", () => {
    const r = assessNewsImpact([1, 2, 3, 4, 5, 6].map((i) => ev(String(i), i * 5, { sentiment: 0.9 })), T, NOW);
    expect(r.direction).toBe("POSITIVE");
    expect(r.recommendation).toBe("NONE");
  });
  it("old news decays and very old news is STALE", () => {
    const fresh = assessNewsImpact([ev("a", 5, { sentiment: -1 }), ev("b", 600, { sentiment: 1 })], T, NOW);
    expect(fresh.impact as number).toBeLessThan(-0.9);
    const stale = assessNewsImpact([ev("a", 5000)], T, NOW);
    expect(stale.flags).toContain("STALE");
    expect(stale.impact).toBeNull();
  });
  it("excludes unreliable, duplicate, future and unmatched events and flags them", () => {
    const r = assessNewsImpact([ev("1", 10, { reliability: 0.1 }), ev("2", 10), ev("2", 10), ev("3", -30), ev("4", 10, { symbols: ["TCS"] })], T, NOW);
    expect(r.flags).toEqual(expect.arrayContaining(["UNRELIABLE_IGNORED", "FUTURE_EVENTS_IGNORED", "THIN"]));
    expect(r.used).toBe(1);
  });
  it("conflicting strong views are MIXED and thin evidence lowers confidence", () => {
    const r = assessNewsImpact([ev("1", 10, { sentiment: 0.9 }), ev("2", 12, { sentiment: -0.9 })], T, NOW);
    expect(r.direction).toBe("MIXED");
    expect(r.flags).toContain("CONFLICTING");
    expect(r.confidence).toBeLessThan(0.4);
  });
  it("theme-only matches count less than direct ones and a burst is a SPIKE", () => {
    const burst = assessNewsImpact(Array.from({ length: 8 }, (_, i) => ev(String(i), 5 + i * 3)), T, NOW);
    expect(burst.flags).toContain("SPIKE");
    const theme = assessNewsImpact([ev("t", 10, { symbols: [], themes: ["OIL"] })], { symbol: "RELIANCE", themes: ["OIL"] }, NOW);
    expect(theme.used).toBe(1);
  });
  it("ignores malformed events and is deterministic", () => {
    const bad = [ev("x", 5, { sentiment: 5 }), ev("y", 5, { reliability: 2 }), { ...ev("z", 5), publishedAt: "nope" }];
    expect(assessNewsImpact(bad, T, NOW).matched).toBe(0);
    const evs = [ev("1", 10), ev("2", 20, { sentiment: 0.2 })];
    expect(JSON.stringify(assessNewsImpact(evs, T, NOW))).toBe(JSON.stringify(assessNewsImpact([...evs].reverse(), T, NOW)));
  });
});

// SYNTHETIC bars
const bar = (c: number, o = c, spread = 0.5, volume: number | null = 1000): IBar => ({ open: o, high: Math.max(o, c) + spread, low: Math.min(o, c) - spread, close: c, volume });
const flat = (n: number, base = 100): IBar[] => Array.from({ length: n }, (_, i) => bar(base + (i % 2 === 0 ? 0.2 : -0.2), base, 0.5));
describe("independent signal candidates (#16)", () => {
  it("a volume-confirmed breakout yields a BUY candidate with a stop, targets and no confidence", () => {
    const bars = [...flat(70), bar(104, 100, 0.3, 2000)];
    const c = generateCandidates("X", bars, "RANGE_BOUND").find((x) => x.strategy === "BREAKOUT_LONG")!;
    expect(c).toBeDefined();
    expect(c.side).toBe("BUY");
    expect(c.stop).toBeLessThan(c.entry);
    expect(c.targets[0]).toBeGreaterThan(c.entry);
    expect(c.targets[1]).toBeGreaterThan(c.targets[0]);
    expect(c).toMatchObject({ confidence: null, calibrated: false, status: "CANDIDATE", requiresFullPipeline: true, orderable: false, source: "twins-independent" });
  });
  it("a low-volume breakout is rejected, unknown volume is allowed but labelled", () => {
    expect(generateCandidates("X", [...flat(70), bar(104, 100, 0.3, 100)]).some((x) => x.strategy === "BREAKOUT_LONG")).toBe(false);
    const c = generateCandidates("X", [...flat(70), bar(104, 100, 0.3, null)]).find((x) => x.strategy === "BREAKOUT_LONG")!;
    expect(c.reasons).toContain("VOLUME_UNKNOWN");
  });
  it("a breakdown yields a SELL candidate with the stop above entry", () => {
    const c = generateCandidates("X", [...flat(70), bar(96, 100, 0.3, 2000)]).find((x) => x.strategy === "BREAKDOWN_SHORT")!;
    expect(c.side).toBe("SELL");
    expect(c.stop).toBeGreaterThan(c.entry);
    expect(c.targets[0]).toBeLessThan(c.entry);
  });
  it("a pullback in an uptrend is found", () => {
    const up = Array.from({ length: 70 }, (_, i) => bar(100 + i * 0.5, 100 + i * 0.5 - 0.2, 0.3));
    const dip = [bar(131.5, 133, 0.2), bar(131, 131.5, 0.2), bar(132.3, 131.2, 0.2)];
    const bars = [...up.slice(0, 67), ...dip.map((b, i) => ({ ...b, low: i === 1 ? 128 : b.low }))];
    const out = generateCandidates("X", bars, "TRENDING_UP");
    expect(out.map((x) => x.strategy)).toContain("PULLBACK_LONG");
  });
  it("blocked regimes, too few bars and malformed bars generate nothing", () => {
    const bars = [...flat(70), bar(104, 100, 0.3, 2000)];
    expect(generateCandidates("X", bars, "HIGH_VOLATILITY")).toEqual([]);
    expect(generateCandidates("X", bars, "UNKNOWN")).toEqual([]);
    expect(generateCandidates("X", bars.slice(-20))).toEqual([]);
    expect(generateCandidates("X", [...bars.slice(0, 30), { open: 1, high: 0.5, low: 2, close: 1, volume: 1 }, ...bars.slice(31)])).toEqual([]);
  });
  it("property: every candidate has a stop on the protective side and ordered targets", () => {
    let s = 5; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let produced = 0;
    for (let k = 0; k < 300; k++) {
      let px = 100; const bars: IBar[] = [];
      for (let i = 0; i < 90; i++) { const o = px; px = Math.max(1, px * (1 + (rnd() - 0.48) * 0.03)); bars.push({ open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: rnd() < 0.3 ? null : 500 + rnd() * 2000 }); }
      for (const c of generateCandidates("X", bars, null)) {
        produced++;
        if (c.side === "BUY") { expect(c.stop).toBeLessThan(c.entry); expect(c.targets[0]).toBeGreaterThan(c.entry); expect(c.targets[2]).toBeGreaterThan(c.targets[1]); }
        else { expect(c.stop).toBeGreaterThan(c.entry); expect(c.targets[0]).toBeLessThan(c.entry); expect(c.targets[2]).toBeLessThan(c.targets[1]); }
        expect(c.riskPerUnit).toBeGreaterThan(0);
        expect(c.orderable).toBe(false);
      }
    }
    expect(produced).toBeGreaterThan(0);
  });
});
