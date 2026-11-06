import { describe, expect, it } from "vitest";
import { assessExposure, correlationBreak, correlationMatrix, DEFAULT_EXPOSURE_LIMITS, effectiveBets, ExposureInputError, leadLag, pearson, returnsOf, runStress, StressInputError, type Position, type StressPosition } from "../../../packages/risk/src/index";

const CAP = 100_000;
const pos = (symbol: string, notional: number, o: Partial<Position> = {}): Position => ({ symbol, sector: "IT", side: "BUY", notional, ...o });

describe("exposure governor (#10)", () => {
  it("aggregates gross, net and concentrations as percent of capital", () => {
    const r = assessExposure([pos("A", 20_000), pos("B", 10_000, { sector: "BANK", side: "SELL" }), pos("C", 5_000, { sector: null })], DEFAULT_EXPOSURE_LIMITS(CAP));
    expect(r).toMatchObject({ grossPct: 35, netPct: 15, longPct: 25, shortPct: 10, unclassifiedPct: 5, breaches: [], candidateOutcome: "NO_CANDIDATE", headroom: null, grantsApproval: false, forcesExit: false });
    expect(r.bySymbolPct).toEqual({ A: 20, B: 10, C: 5 });
    expect(r.bySectorPct).toEqual({ BANK: 10, IT: 20 });
  });
  it("reports breaches without recommending any exit", () => {
    const r = assessExposure([pos("A", 30_000)], DEFAULT_EXPOSURE_LIMITS(CAP));
    expect(r.breaches.map((b) => b.limit)).toEqual(["SYMBOL:A"]);
    expect(r.forcesExit).toBe(false);
  });
  it("headroom is the tightest limit and never exceeds the request", () => {
    const base = [pos("A", 20_000)];
    const fits = assessExposure(base, DEFAULT_EXPOSURE_LIMITS(CAP), { symbol: "B", sector: "BANK", side: "BUY", notional: 10_000 });
    expect(fits).toMatchObject({ candidateOutcome: "FITS", headroom: 10_000 });
    const reduce = assessExposure(base, DEFAULT_EXPOSURE_LIMITS(CAP), { symbol: "A", sector: "IT", side: "BUY", notional: 20_000 });
    expect(reduce).toMatchObject({ candidateOutcome: "REDUCE", headroom: 5_000 }); // symbol cap 25% = 25,000
    const refuse = assessExposure([pos("A", 25_000)], DEFAULT_EXPOSURE_LIMITS(CAP), { symbol: "A", sector: "IT", side: "BUY", notional: 1 });
    expect(refuse).toMatchObject({ candidateOutcome: "REFUSE", headroom: 0 });
  });
  it("an opposite-direction candidate is not limited by the net cap but still by the others", () => {
    const longs = [pos("A", 24_000), pos("B", 24_000, { sector: "BANK" }), pos("C", 24_000, { sector: "AUTO" }), pos("D", 24_000, { sector: "FMCG" })];
    const lim = { ...DEFAULT_EXPOSURE_LIMITS(CAP), maxNetPct: 90 };
    const short = assessExposure(longs, lim, { symbol: "E", sector: "PHARMA", side: "SELL", notional: 20_000 });
    expect(short.headroom).toBe(20_000);
    const more = assessExposure(longs, lim, { symbol: "E", sector: "PHARMA", side: "BUY", notional: 20_000 });
    expect(more.headroom).toBe(0); // already 96% net long > 90%
  });
  it("property: headroom never exceeds the request or goes negative", () => {
    let s = 11; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 2000; i++) {
      const ps = Array.from({ length: Math.floor(rnd() * 6) }, (_, k) => pos(`S${k}`, rnd() * 40_000, { sector: rnd() < 0.2 ? null : `X${Math.floor(rnd() * 3)}`, side: rnd() < 0.5 ? "BUY" : "SELL" }));
      const n = rnd() * 50_000;
      const r = assessExposure(ps, DEFAULT_EXPOSURE_LIMITS(CAP), { symbol: "S0", sector: "X0", side: rnd() < 0.5 ? "BUY" : "SELL", notional: n });
      expect(r.headroom).toBeGreaterThanOrEqual(0);
      expect(r.headroom as number).toBeLessThanOrEqual(Math.floor(n));
    }
  });
  it("refuses bad input", () => {
    expect(() => assessExposure([pos("A", -1)], DEFAULT_EXPOSURE_LIMITS(CAP))).toThrow(ExposureInputError);
    expect(() => assessExposure([], DEFAULT_EXPOSURE_LIMITS(0))).toThrow(ExposureInputError);
    expect(() => assessExposure([], DEFAULT_EXPOSURE_LIMITS(CAP), { symbol: "A", sector: null, side: "BUY", notional: NaN })).toThrow(ExposureInputError);
  });
});

const sp = (o: Partial<StressPosition> = {}): StressPosition => ({ symbol: "A", side: "BUY", quantity: 100, price: 100, beta: 1, stop: 95, ...o });
describe("scenario stress test (#14)", () => {
  it("long equity loses with a down move but is capped by stop distance plus gap-through", () => {
    const r = runStress([sp()], CAP, 5);
    const d3 = r.results.find((x) => x.id === "MARKET_DOWN_3")!;
    expect(d3.pnl).toBe(-300); // -3% of 10,000, inside the stop distance (500) + gap
    const gap = r.results.find((x) => x.id === "GAP_DOWN_10")!;
    expect(gap.pnl).toBe(-650); // unbounded would be -1000; capped at 500 + 1.5% x 10,000
    expect(r.worst?.id).toBe("GAP_DOWN_10");
  });
  it("short equity loses on a rise and gains on a fall", () => {
    const r = runStress([sp({ side: "SELL", stop: 105 })], CAP, 5);
    expect(r.results.find((x) => x.id === "MARKET_UP_5")!.pnl).toBe(-500);
    expect(r.results.find((x) => x.id === "MARKET_DOWN_3")!.pnl).toBe(300);
  });
  it("a long option cannot lose more than its premium", () => {
    const opt = sp({ stop: null, option: { delta: 0.5, gamma: 0.01, vega: 0.2, premium: 40, underlyingPrice: 24_000 } });
    const r = runStress([{ ...opt, quantity: 25, price: 40 }], CAP, 5);
    for (const x of r.results) expect(x.pnl).toBeGreaterThanOrEqual(-40 * 25);
    expect(r.results.find((x) => x.id === "GAP_DOWN_10")!.pnl).toBe(-1000);
    expect(r.results.find((x) => x.id === "VOL_SPIKE")!.pnl).toBeGreaterThan(0);
  });
  it("flags a breach of the maximum loss and reports the worst position", () => {
    const r = runStress([sp({ quantity: 1000, stop: null })], CAP, 5); // 100,000 notional, no stop
    expect(r.anyBreach).toBe(true);
    expect(r.results.find((x) => x.id === "MARKET_DOWN_7")!.worstPosition).toEqual({ symbol: "A", pnl: -7000 });
    expect(r.limitations.length).toBeGreaterThan(0);
  });
  it("empty book is a zero-loss report and bad input throws", () => {
    expect(runStress([], CAP, 5).worst?.pnl).toBe(0);
    expect(() => runStress([sp({ quantity: 0 })], CAP, 5)).toThrow(StressInputError);
    expect(() => runStress([sp({ side: "SELL", option: { delta: 1, gamma: 0, vega: 0, premium: 1, underlyingPrice: 1 } })], CAP, 5)).toThrow(StressInputError);
    expect(() => runStress([], 0, 5)).toThrow(StressInputError);
  });
});

const wave = (n: number, f: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => f(i));
describe("cross-market correlation (#15)", () => {
  const a = wave(60, (i) => Math.sin(i / 3) * 0.01);
  it("pearson: identical = 1, opposite = -1, constant or short = null", () => {
    expect(pearson(a, a)).toBe(1);
    expect(pearson(a, a.map((x) => -x))).toBe(-1);
    expect(pearson(a, a.map(() => 0.01))).toBeNull();
    expect(pearson(a.slice(0, 10), a.slice(0, 10))).toBeNull();
    expect(pearson(a, a.slice(1))).toBeNull();
    expect(pearson([...a.slice(1), NaN], a)).toBeNull();
  });
  it("returnsOf rejects bad prices", () => {
    expect(returnsOf([100, 110])).toEqual([0.1].map((x) => expect.closeTo(x, 10)));
    expect(returnsOf([100, 0])).toBeNull();
    expect(returnsOf([100])).toBeNull();
  });
  it("matrix flags high pairs and effective bets falls with correlation", () => {
    const b = a.map((x) => x * 2), c = wave(60, (i) => Math.cos(i / 2.2) * 0.01 + (i % 7) * 0.001);
    const m = correlationMatrix({ A: a, B: b, C: c }, 0.95);
    expect(m.highPairs).toEqual([{ a: "A", b: "B", corr: 1 }]);
    expect(m.observations).toBe(60);
    const two = correlationMatrix({ A: a, B: b });
    expect(effectiveBets(two)).toBe(1);
    const indep = correlationMatrix({ A: a, C: c });
    expect(effectiveBets(indep) as number).toBeGreaterThan(1.3);
    expect(effectiveBets(correlationMatrix({ A: a, S: a.slice(0, 5) }))).toBeNull();
  });
  it("lead-lag finds a shifted copy and refuses misaligned or short series", () => {
    const lead = wave(80, (i) => Math.sin(i / 2.5) * 0.01 + Math.sin(i * 1.3) * 0.004);
    const follow = [0, 0, ...lead.slice(0, -2)].map((x) => x);
    const r = leadLag(lead, follow, 5);
    expect(r.bestLag).toBe(2);
    expect(r.bestCorr as number).toBeGreaterThan(0.9);
    expect(leadLag(lead, follow.slice(1)).reason).toBe("SERIES_NOT_ALIGNED");
    expect(leadLag(lead.slice(0, 10), follow.slice(0, 10)).reason).toBe("INSUFFICIENT_OBSERVATIONS");
  });
  it("detects a correlation regime break", () => {
    const x = wave(100, (i) => Math.sin(i / 3) * 0.01 + Math.sin(i * 1.7) * 0.003);
    const y = x.map((v, i) => (i < 75 ? v : -v));
    const r = correlationBreak(x, y, 25, 0.4);
    expect(r.broken).toBe(true);
    expect(r.recent as number).toBeLessThan(-0.9);
    expect(correlationBreak(x, x, 25).broken).toBe(false);
    expect(correlationBreak(x.slice(0, 30), x.slice(0, 30)).reason).toBe("INSUFFICIENT_OBSERVATIONS");
  });
});
