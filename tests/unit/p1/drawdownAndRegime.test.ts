import { describe, expect, it } from "vitest";
import { DEFAULT_DRAWDOWN_POLICY, detectRegime, DrawdownPolicyError, evaluateDrawdown, validateDrawdownPolicy, type EquityPoint, type RegimeBar } from "../../../packages/risk/src/index";

const eq = (...v: number[]): EquityPoint[] => v.map((e, i) => ({ at: new Date(Date.UTC(2031, 0, 1 + i)).toISOString(), equity: e }));

describe("drawdown governor (#11)", () => {
  it("levels follow depth from the running peak", () => {
    expect(evaluateDrawdown(eq(100, 110, 108)).level).toBe("NORMAL");
    expect(evaluateDrawdown(eq(100, 110, 106)).level).toBe("CAUTION"); // 3.6%
    expect(evaluateDrawdown(eq(100, 100, 94.5)).level).toBe("REDUCE_ONLY"); // 5.5%
    const h = evaluateDrawdown(eq(100, 91));
    expect(h.level).toBe("HALT_NEW_ENTRIES");
    expect(h.sizeMultiplier).toBe(0);
    expect(h.drawdownPct).toBe(9);
  });
  it("is never a force-exit, never an approval, and never raises size", () => {
    for (const pts of [eq(100), eq(100, 50), eq(100, 120, 60)]) {
      const a = evaluateDrawdown(pts);
      expect(a.forcesExit).toBe(false);
      expect(a.grantsApproval).toBe(false);
      expect(a.sizeMultiplier).toBeGreaterThanOrEqual(0);
      expect(a.sizeMultiplier).toBeLessThanOrEqual(1);
    }
  });
  it("hysteresis holds a level until the drawdown is clearly below its threshold", () => {
    // 4.5% is raw CAUTION, but coming from REDUCE_ONLY (5%) it is held until below 0.8 x 5 = 4%
    const held = evaluateDrawdown(eq(100, 95.5), DEFAULT_DRAWDOWN_POLICY, "REDUCE_ONLY");
    expect(held.level).toBe("REDUCE_ONLY");
    expect(held.reasons).toContain("HELD_BY_HYSTERESIS");
    expect(evaluateDrawdown(eq(100, 96.5), DEFAULT_DRAWDOWN_POLICY, "REDUCE_ONLY").level).toBe("CAUTION");
  });
  it("bad data fails to CAUTION with a reason, not to NORMAL", () => {
    for (const pts of [[], eq(100, NaN), eq(100, -5), eq(0)]) {
      const a = evaluateDrawdown(pts);
      expect(a.level).toBe("CAUTION");
      expect(a.drawdownPct).toBeNull();
    }
    const unordered = [{ at: "2031-01-02T00:00:00Z", equity: 100 }, { at: "2031-01-01T00:00:00Z", equity: 99 }];
    expect(evaluateDrawdown(unordered).reasons).toEqual(["EQUITY_DATA_INVALID"]);
  });
  it("refuses a policy that could scale size up or has unordered thresholds", () => {
    expect(() => validateDrawdownPolicy({ ...DEFAULT_DRAWDOWN_POLICY, sizeMultipliers: { ...DEFAULT_DRAWDOWN_POLICY.sizeMultipliers, CAUTION: 1.2 } })).toThrow(DrawdownPolicyError);
    expect(() => validateDrawdownPolicy({ ...DEFAULT_DRAWDOWN_POLICY, reducePct: 2 })).toThrow(DrawdownPolicyError);
    expect(() => validateDrawdownPolicy({ ...DEFAULT_DRAWDOWN_POLICY, hysteresis: 1.5 })).toThrow(DrawdownPolicyError);
  });
  it("property: multiplier is non-increasing as drawdown deepens", () => {
    let last = 1;
    for (let dd = 0; dd <= 20; dd += 0.5) {
      const m = evaluateDrawdown(eq(100, 100 - dd)).sizeMultiplier;
      expect(m).toBeLessThanOrEqual(last);
      last = m;
    }
  });
});

// SYNTHETIC bar series (deterministic)
const series = (n: number, f: (i: number) => number, spread = 0.2): RegimeBar[] => Array.from({ length: n }, (_, i) => { const c = f(i), o = i === 0 ? c : f(i - 1); return { open: o, high: Math.max(o, c) + spread, low: Math.min(o, c) - spread, close: c }; });
describe("regime detector (#7)", () => {
  it("steady up-move is TRENDING_UP, steady down-move TRENDING_DOWN", () => {
    const up = detectRegime(series(60, (i) => 100 + i * 0.5));
    expect(up.regime).toBe("TRENDING_UP");
    expect(up.efficiencyRatio).toBeGreaterThan(0.9);
    expect(detectRegime(series(60, (i) => 200 - i * 0.5)).regime).toBe("TRENDING_DOWN");
  });
  it("oscillation without direction is RANGE_BOUND", () => {
    const r = detectRegime(series(60, (i) => 100 + (i % 2 === 0 ? 0.3 : -0.3)));
    expect(r.regime).toBe("RANGE_BOUND");
  });
  it("a recent volatility burst is HIGH_VOLATILITY and exposes the ratio for the sizing shadow", () => {
    const r = detectRegime(series(60, (i) => (i < 45 ? 100 + (i % 2 === 0 ? 0.1 : -0.1) : 100 + (i % 2 === 0 ? 3 : -3))));
    expect(r.regime).toBe("HIGH_VOLATILITY");
    expect(r.volatilityRatio).toBeGreaterThanOrEqual(1.5);
  });
  it("a recent calm after wide swings is LOW_VOLATILITY", () => {
    const r = detectRegime(series(60, (i) => (i < 45 ? 100 + (i % 2 === 0 ? 3 : -3) : 100 + (i % 2 === 0 ? 0.05 : -0.05)), 0.05));
    expect(r.regime).toBe("LOW_VOLATILITY");
  });
  it("too few or malformed bars give UNKNOWN, never a guess", () => {
    expect(detectRegime(series(10, (i) => 100 + i)).reasons).toEqual(["INSUFFICIENT_BARS"]);
    const bad = series(60, (i) => 100 + i * 0.1);
    bad[30] = { open: 100, high: 99, low: 101, close: 100 };
    expect(detectRegime(bad).reasons).toEqual(["MALFORMED_BAR"]);
    expect(detectRegime(series(60, () => 100, 0)).reasons).toEqual(["ZERO_LONG_VOLATILITY"]);
  });
  it("is deterministic and grants nothing", () => {
    const s = series(60, (i) => 100 + Math.sin(i / 3) * 2);
    expect(JSON.stringify(detectRegime(s))).toBe(JSON.stringify(detectRegime(s)));
    expect(detectRegime(s).grantsApproval).toBe(false);
  });
});
