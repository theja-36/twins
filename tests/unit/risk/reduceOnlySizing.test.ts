import { describe, expect, it } from "vitest";
import { DEFAULT_REDUCE_ONLY_POLICY, reduceOnlySize, ReduceOnlyPolicyError, summarizeReduceOnly, validateReduceOnlyPolicy, type ReduceOnlyInputs, type ReduceOnlyPolicy } from "../../../packages/risk/src/sizing/reduceOnly";

const calm = (o: Partial<ReduceOnlyInputs> = {}): ReduceOnlyInputs => ({ v1Quantity: 40, drawdownPct: 0, volatilityRatio: 1, hoursToHighImpactEvent: null, unusableSources: 0, thinEvidence: false, ...o });

describe("reduce-only sizing (P0 #3, shadow)", () => {
  it("leaves the size alone when everything is calm, and says it is not used for decisions", () => {
    const r = reduceOnlySize(calm({ hoursToHighImpactEvent: 30 }));
    expect(r).toMatchObject({ v1Quantity: 40, adjustedQuantity: 40, multiplier: 1, reduced: false, factors: [], usedForDecisions: false });
  });
  it("reduces for drawdown on a ramp, down to the drawdown minimum at the full level", () => {
    expect(reduceOnlySize(calm({ drawdownPct: 2 })).adjustedQuantity).toBe(40); // at the start: no reduction
    expect(reduceOnlySize(calm({ drawdownPct: 4 }))).toMatchObject({ multiplier: 0.75, adjustedQuantity: 30 });
    expect(reduceOnlySize(calm({ drawdownPct: 9 }))).toMatchObject({ multiplier: 0.5, adjustedQuantity: 20 });
  });
  it("reduces for volatility, a close high-impact event, unusable sources and thin evidence, and compounds them above the floor", () => {
    expect(reduceOnlySize(calm({ volatilityRatio: 3 })).multiplier).toBe(0.5);
    expect(reduceOnlySize(calm({ hoursToHighImpactEvent: 2 })).multiplier).toBe(0.5);
    expect(reduceOnlySize(calm({ unusableSources: 2 })).multiplier).toBe(0.81);
    expect(reduceOnlySize(calm({ thinEvidence: true })).multiplier).toBe(0.75);
    const r = reduceOnlySize(calm({ thinEvidence: true, unusableSources: 1, hoursToHighImpactEvent: 1 })); // 0.75 x 0.9 x 0.5 = 0.3375
    expect(r.multiplier).toBe(0.3375); expect(r.adjustedQuantity).toBe(13); expect(r.factors.map((f) => f.name).sort()).toEqual(["event", "sources", "thin_evidence"]);
  });
  it("never goes below the floor, and reports it", () => {
    const r = reduceOnlySize(calm({ drawdownPct: 9, volatilityRatio: 3, hoursToHighImpactEvent: 0, thinEvidence: true, unusableSources: 3 }));
    expect(r.multiplier).toBe(0.25); expect(r.adjustedQuantity).toBe(10); expect(r.notes).toContain("FLOOR_APPLIED");
  });
  it("rounds DOWN to whole lots and can reach zero (reported), never rounds up", () => {
    expect(reduceOnlySize(calm({ v1Quantity: 3, thinEvidence: true })).adjustedQuantity).toBe(2); // 2.25 -> 2
    const r = reduceOnlySize(calm({ v1Quantity: 1, thinEvidence: true }));
    expect(r.adjustedQuantity).toBe(0); expect(r.notes).toContain("ROUNDED_TO_ZERO"); expect(r.reduced).toBe(true);
    expect(reduceOnlySize(calm({ v1Quantity: 0, thinEvidence: true }))).toMatchObject({ adjustedQuantity: 0, reduced: false });
  });
  it("an unknown input changes nothing and is reported, never treated as good news or bad news", () => {
    const r = reduceOnlySize({ v1Quantity: 40, drawdownPct: null, volatilityRatio: null, hoursToHighImpactEvent: null, unusableSources: null, thinEvidence: false });
    expect(r).toMatchObject({ adjustedQuantity: 40, multiplier: 1 }); expect(r.unknownInputs).toEqual(["drawdownPct", "volatilityRatio", "hoursToHighImpactEvent", "unusableSources"]); expect(r.notes).toContain("UNKNOWN_INPUTS_DID_NOT_CHANGE_SIZE");
  });
  it("refuses a policy that could scale up, and a bad v1 quantity", () => {
    const bad = (o: Partial<ReduceOnlyPolicy>) => expect(() => reduceOnlySize(calm(), { ...DEFAULT_REDUCE_ONLY_POLICY, ...o })).toThrow(ReduceOnlyPolicyError);
    bad({ thinEvidenceMultiplier: 1.1 }); bad({ floor: 0 }); bad({ eventMultiplier: Number.NaN }); bad({ perUnusableSourceMultiplier: 2 }); bad({ drawdownFullPct: 1 }); bad({ volatilityStart: 0.5 }); bad({ eventWindowHours: 0 });
    for (const q of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => reduceOnlySize(calm({ v1Quantity: q }))).toThrow(ReduceOnlyPolicyError);
    expect(() => validateReduceOnlyPolicy(DEFAULT_REDUCE_ONLY_POLICY)).not.toThrow();
  });
  it("PROPERTY: over many pseudo-random inputs the adjusted size is never above v1, never negative, a whole number, and the multiplier stays within [floor, 1]", () => {
    let seed = 12345; const rnd = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    for (let n = 0; n < 5000; n++) {
      const i: ReduceOnlyInputs = { v1Quantity: Math.floor(rnd() * 500), drawdownPct: pick([null, rnd() * 20, 0, -3]), volatilityRatio: pick([null, rnd() * 6, 0.2, 1]), hoursToHighImpactEvent: pick([null, rnd() * 12, 0, -2]), unusableSources: pick([null, 0, 1, 2, 7]), thinEvidence: rnd() < 0.5 };
      const r = reduceOnlySize(i);
      expect(r.adjustedQuantity).toBeLessThanOrEqual(i.v1Quantity); expect(r.adjustedQuantity).toBeGreaterThanOrEqual(0); expect(Number.isInteger(r.adjustedQuantity)).toBe(true);
      expect(r.multiplier).toBeGreaterThanOrEqual(DEFAULT_REDUCE_ONLY_POLICY.floor); expect(r.multiplier).toBeLessThanOrEqual(1);
    }
  });
});

describe("shadow comparison summary", () => {
  it("counts how often and why it would have reduced, and never reports a total above v1", () => {
    const rs = [calm(), calm({ thinEvidence: true }), calm({ drawdownPct: 9, thinEvidence: true }), calm({ drawdownPct: null })].map((i) => reduceOnlySize(i));
    const s = summarizeReduceOnly(rs);
    expect(s).toMatchObject({ n: 4, reduced: 2, reducedShare: 0.5, byFactor: { thin_evidence: 2, drawdown: 1 }, withUnknownInputs: 4 }); // calm() leaves the event horizon unknown in every case
    expect(s.totalAdjusted).toBeLessThanOrEqual(s.totalV1);
    expect(summarizeReduceOnly([])).toMatchObject({ n: 0, reducedShare: null, meanMultiplier: null });
  });
});
