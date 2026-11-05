import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPaperOnly, computeStats, createTrade, DEFAULT_PAPER_CONFIG, exitNow, loadPaperConfig, step, toOutcome, type PaperConfig, type PaperTrade, type TradeOutcome } from "../../../packages/paper/src/index";

const T0 = "2026-11-06T04:00:00.000Z";
const at = (m: number): string => new Date(Date.parse(T0) + m * 60_000).toISOString();
const c: PaperConfig = { ...DEFAULT_PAPER_CONFIG, slippageBps: 0, trail: { kind: "none" } };
const closed = (id: string, ticks: Array<[number, number]>, extra: Partial<Parameters<typeof createTrade>[0]> = {}): PaperTrade => {
  let t = createTrade({ id, riskDecisionId: "d" + id, symbol: "NIFTY", side: "BUY", quantity: 100, entryPrice: 100, stop: 95, targets: [110, 120, 130], now: T0, ...extra }).trade;
  for (const [m, p] of ticks) t = step(t, { price: p, at: at(m) }, c).trade;
  return t;
};
const ctx = { sourceTrustTier: "TIER_1", confidenceScore: 0.7, researchAssessment: "RESEARCH_SUPPORTIVE" };

describe("outcomes", () => {
  it("records a win with R, MFE/MAE and holding time; refuses open or pending trades", () => {
    const o = toOutcome(closed("a", [[1, 100], [2, 110], [3, 120], [4, 130]]), ctx)!;
    expect(o).toMatchObject({ outcome: "WIN", closeReason: "TARGET", targetsHit: 3, holdingSeconds: 180, mfeR: 6, maeR: 0 }); expect(o.rMultiple).toBeCloseTo(3.5, 5); // (50*10 + 25*20 + 25*30) / (5 * 100)
    expect(toOutcome(closed("p", []), ctx)).toBeNull(); expect(toOutcome(closed("o", [[1, 100]]), ctx)).toBeNull();
  });
  it("classifies a loss and a break-even", () => {
    expect(toOutcome(closed("l", [[1, 100], [2, 95]]), ctx)).toMatchObject({ outcome: "LOSS", rMultiple: -1, closeReason: "STOP_LOSS" });
    const be = exitNow(closed("b", [[1, 100]]), { price: 100.1, at: at(5) }, c, "SQUARE_OFF").trade;
    expect(toOutcome(be, ctx)!.outcome).toBe("BREAKEVEN");
  });
});

describe("statistics", () => {
  const outs: TradeOutcome[] = [
    toOutcome(closed("1", [[1, 100], [2, 110], [3, 120], [4, 130]]), ctx)!, toOutcome(closed("2", [[1, 100], [2, 95]]), { ...ctx, sourceTrustTier: "TIER_2" })!, toOutcome(closed("3", [[1, 100], [2, 95]]), ctx)!,
  ];
  it("computes win rate, expectancy, profit factor, drawdown and breakdowns, and flags a small sample", () => {
    const s = computeStats(outs);
    expect(s).toMatchObject({ n: 3, wins: 1, losses: 2, winRate: 0.33, totalR: 1.5, sampleIsMeaningful: false, minSampleForMeaning: 30 });
    expect(s.expectancyR).toBe(0.5); expect(s.profitFactor).toBe(1.75); expect(s.maxDrawdownR).toBe(2);
    expect(s.byCloseReason["STOP_LOSS"]!.n).toBe(2); expect(Object.keys(s.bySourceTrustTier)).toEqual(["TIER_1", "TIER_2"]); expect(s.byResearchAssessment["RESEARCH_SUPPORTIVE"]!.n).toBe(3);
  });
  it("is well-defined for no outcomes", () => {
    expect(computeStats([])).toMatchObject({ n: 0, winRate: null, expectancyR: null, profitFactor: null, maxDrawdownR: 0, avgHoldingSeconds: null });
  });
});

describe("configuration", () => {
  it("is OFF by default and parses every setting strictly", () => {
    expect(loadPaperConfig({}).enabled).toBe(false);
    expect(loadPaperConfig({ TWINS_PAPER_TRADING_ENABLED: "true", TWINS_PAPER_TRAIL: "points:12.5", TWINS_PAPER_EXIT_FRACTIONS: "0.4,0.3,0.3", TWINS_PAPER_SLIPPAGE_BPS: "10" })).toMatchObject({ enabled: true, trail: { kind: "points", value: 12.5 }, exitFractions: [0.4, 0.3, 0.3], slippageBps: 10 });
    for (const env of [{ TWINS_PAPER_TRADING_ENABLED: "yes" }, { TWINS_PAPER_TRAIL: "percent:0" }, { TWINS_PAPER_TRAIL: "x" }, { TWINS_PAPER_EXIT_FRACTIONS: "0.5,0.5,0.5" }, { TWINS_PAPER_EXIT_FRACTIONS: "1,0" }, { TWINS_PAPER_SLIPPAGE_BPS: "-1" }, { TWINS_PAPER_ENTRY_EXPIRY_MIN: "0" }, { TWINS_PAPER_BREAKEVEN: "1" }]) expect(() => loadPaperConfig(env)).toThrow();
  });
  it("refuses to run with LIVE_TRADING on or outside paper mode", () => {
    expect(() => assertPaperOnly({ LIVE_TRADING: "true" })).toThrow(); expect(() => assertPaperOnly({ TRADING_MODE: "live" })).toThrow();
    expect(() => assertPaperOnly({ LIVE_TRADING: "false", TRADING_MODE: "paper" })).not.toThrow(); expect(() => assertPaperOnly({})).not.toThrow();
  });
});

describe("no order path (static)", () => {
  const dir = join(process.cwd(), "packages/paper/src");
  const code = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")] as const);
  it("never imports the Kite client, a network library or the real orders/fills/positions tables", () => {
    for (const [f, text] of code) {
      expect(text, f).not.toMatch(/@twins\/kite|packages\/kite|node:https?|node:net|\bfetch\s*\(|WebSocket|axios|undici/);
      expect(text, f).not.toMatch(/schema\.(orders|fills|positions)\b|\b(orders|fills|positions)\s*[,}]\s*from|from\s+["'][^"']*\/(orders|fills|positions)["']/);
      expect(text, f).not.toMatch(/placeOrder|modifyOrder|cancelOrder|transaction_type/i);
    }
  });
});
