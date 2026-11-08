import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_CONFIG, PROFILE_VERSION, buildChannelProfile, distribution, quantiles, type ChannelSignal } from "../../../packages/historical/src/strategy/index";

let n = 0;
const sig = (o: Partial<ChannelSignal> = {}): ChannelSignal => ({ id: `s${n++}`, at: new Date(Date.UTC(2026, 10, 1 + (n % 20), 4, 30)), underlying: "NIFTY", optionType: "CE", action: "buy", entryKind: "above", setup: "BREAKOUT", horizon: "INTRADAY", sessionBucket: "MORNING", riskProfile: "MODERATE", stopPresent: true, stopDistancePct: 20, firstTargetDistancePct: 30, rewardToRisk: [1.5], targetCount: 2, levelBasisStated: false, ...o });
const many = (k: number, o: Partial<ChannelSignal> = {}) => Array.from({ length: k }, () => sig(o));

describe("distributions and quantiles", () => {
  it("counts known values, keeps unknown apart, and names a top only with enough signals and a clear majority", () => {
    const d = distribution([...Array(14).fill("above"), ...Array(6).fill("range"), null, "UNKNOWN_X"], DEFAULT_PROFILE_CONFIG);
    expect(d).toMatchObject({ known: 20, unknown: 2, top: "ABOVE", topShare: 0.7 });
    expect(distribution([...Array(11).fill("a"), ...Array(9).fill("b")], DEFAULT_PROFILE_CONFIG).top).toBeNull(); // 55 percent is not a clear majority
    expect(distribution(Array(5).fill("a"), DEFAULT_PROFILE_CONFIG)).toMatchObject({ top: null, topShare: 1 }); // too few signals: reported share, no "preference"
  });
  it("computes quantiles over finite numbers only", () => {
    expect(quantiles([1, 2, 3, 4, 5, null, undefined, Number.NaN])).toEqual({ n: 5, p25: 2, median: 3, p75: 4 }); expect(quantiles([])).toBeNull(); expect(quantiles([null])).toBeNull();
  });
});

describe("channel profile", () => {
  it("an empty channel has an unknown strategy and says why", () => {
    const p = buildChannelProfile([]);
    expect(p).toMatchObject({ version: PROFILE_VERSION, sampleSize: 0, strategyConfidence: "UNKNOWN", clusters: [] }); expect(p.window).toEqual({ from: null, to: null }); expect(p.limitations.join(" ")).toMatch(/at least 20/);
  });
  it("infers entry style, option-type preference, trading time and a recurring cluster from a consistent channel", () => {
    const p = buildChannelProfile([...many(25), ...many(5, { optionType: "PE", entryKind: "range", setup: "REVERSAL", sessionBucket: "AFTERNOON" })]);
    expect(p.entryStyle.top).toBe("ABOVE"); expect(p.optionTypePreference.top).toBe("CE"); expect(p.tradingTimes.top).toBe("MORNING"); expect(p.setups.top).toBe("BREAKOUT");
    expect(p.clusters[0]).toMatchObject({ setup: "BREAKOUT", horizon: "INTRADAY", optionType: "CE", entryKind: "above", count: 25 }); expect(p.clusters.map((c) => c.count)).toEqual([25, 5]);
    expect(p.strategyConfidence).toBe("LOW"); // 30 signals: consistent but not yet a large sample
  });
  it("infers stop, target and risk rules from the stated levels", () => {
    const p = buildChannelProfile([...many(10, { stopDistancePct: 10, rewardToRisk: [3] }), ...many(10, { stopDistancePct: 30, rewardToRisk: [1] }), ...many(5, { stopPresent: false, stopDistancePct: null, rewardToRisk: [], riskProfile: "UNKNOWN" })]);
    expect(p.rules.stop).toMatchObject({ presentShare: 0.8, basisStatedShare: 0 }); expect(p.rules.stop.distancePct).toMatchObject({ n: 20, median: 20 });
    expect(p.rules.targets.rewardToRisk).toMatchObject({ n: 20, median: 2 }); expect(p.rules.risk.noStopShare).toBe(0.2); expect(p.rules.risk.bands.unknown).toBe(5);
  });
  it("never invents what it was not given: no strike distance or market condition is reported, and the limits say so", () => {
    const p = buildChannelProfile(many(30));
    expect(p.strikeDistancePct).toBeNull(); expect(p.marketConditions.top).toBeNull(); expect(p.marketConditions.known).toBe(0);
    expect(p.limitations.join(" ")).toMatch(/strike distance is unknown/); expect(p.limitations.join(" ")).toMatch(/market conditions are unknown/);
    const withRegime = buildChannelProfile(many(30, { regime: "TRENDING_UP", strikeDistancePct: 1.5 })); expect(withRegime.marketConditions.top).toBe("TRENDING_UP"); expect(withRegime.strikeDistancePct).toMatchObject({ median: 1.5 });
  });
  it("small clusters are dropped, and a large steady sample reaches MEDIUM confidence", () => {
    expect(buildChannelProfile([...many(3), ...many(30, { setup: "GAP" })]).clusters.map((c) => c.setup)).toEqual(["GAP"]);
    expect(buildChannelProfile(many(60)).strategyConfidence).toBe("MEDIUM"); expect(buildChannelProfile(many(9)).strategyConfidence).toBe("UNKNOWN");
  });
  it("is deterministic and reports the window", () => { const s = many(30); expect(buildChannelProfile(s)).toEqual(buildChannelProfile([...s].reverse())); expect(buildChannelProfile(s).window.from).toBeInstanceOf(Date); });
});
