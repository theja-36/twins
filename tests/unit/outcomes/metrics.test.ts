import { describe, expect, it } from "vitest";
import { computeMetrics, DIMENSIONS, isEligible, reliabilityOf, sliceBy } from "../../../packages/outcomes/src/index";
import { loss, many, rec, win } from "./fixtures";

describe("performance metrics", () => {
  it("counts wins, losses and breakeven separately and defines the win rate", () => {
    const m = computeMetrics([win(), win(), loss(), rec({ netPnl: "0.00", grossPnl: "20.00", costs: "20.00", rMultiple: "0" })], 30);
    expect(m).toMatchObject({ eligible: 4, wins: 2, losses: 1, breakeven: 1, status: "INSUFFICIENT_DATA", reliability: "INSUFFICIENT_DATA" });
    expect(m.winRate.value).toBe(0.5); expect(m.winRate.definition).toMatch(/breakeven counts as resolved and not a win/); expect(m.winRate.note).toMatch(/fewer than 30/);
  });
  it("sums money exactly (no binary float drift) and reports gross, costs and net separately", () => {
    const m = computeMetrics([rec({ grossPnl: "0.10", costs: "0.00", netPnl: "0.10" }), rec({ grossPnl: "0.20", costs: "0.00", netPnl: "0.20" })], 30);
    expect(m.netPnl).toBe("0.30"); expect(0.1 + 0.2).not.toBe(0.3);
    const n = computeMetrics([win(), loss()], 30); expect(n).toMatchObject({ grossPnl: "0.00", costs: "40.00", netPnl: "-40.00" });
  });
  it("average win / loss, payoff ratio and profit factor are null when they cannot be defined", () => {
    const only = computeMetrics(many(40, () => win()), 30);
    expect(only.avgLoss.value).toBeNull(); expect(only.payoffRatio.value).toBeNull(); expect(only.profitFactor.value).toBeNull(); expect(only.profitFactor.note).toMatch(/no losing outcomes/);
    const both = computeMetrics([...many(30, () => win()), ...many(10, () => loss())], 30);
    expect(both.avgWin.value).toBe("180.00"); expect(both.avgLoss.value).toBe("-220.00"); expect(both.payoffRatio.value).toBeCloseTo(0.8182, 3);
    expect(both.profitFactor.value).toBeCloseTo((30 * 180) / (10 * 220), 3);
  });
  it("expectancy needs the minimum sample; above it, it comes with a 95% interval", () => {
    expect(computeMetrics(many(10, () => win()), 30).expectancyR.value).toBeNull();
    expect(computeMetrics(many(10, () => win()), 30).expectancyMoney.value).toBeNull();
    const m = computeMetrics([...many(20, () => win()), ...many(20, () => loss())], 30);
    expect(m.expectancyR.value).toBeCloseTo(-0.1, 3); expect(m.expectancyR.interval95!.lower).toBeLessThan(m.expectancyR.interval95!.upper); expect(m.expectancyMoney.value).toBe("-20.00");
  });
  it("drawdown is the largest fall of cumulative net P&L from its running peak, in closing order, and needs two outcomes", () => {
    const rs = [rec({ netPnl: "100.00", closedAt: new Date(1000) }), rec({ netPnl: "-30.00", closedAt: new Date(2000) }), rec({ netPnl: "-50.00", closedAt: new Date(3000) }), rec({ netPnl: "60.00", closedAt: new Date(4000) }), rec({ netPnl: "-10.00", closedAt: new Date(5000) })];
    expect(computeMetrics(rs, 30).maxDrawdown.value).toBe("80.00");
    expect(computeMetrics([win()], 30).maxDrawdown.value).toBeNull();
    expect(computeMetrics(rs, 30).maxDrawdown.basis).toMatch(/not an account equity curve/);
  });
  it("holding duration is a distribution; slippage is reported as unmeasurable, not zero", () => {
    const m = computeMetrics([60, 120, 180, 240, 300].map((s) => win({ holdingSeconds: s })), 30);
    expect(m.holdingSeconds).toMatchObject({ n: 5, min: 60, median: 180, max: 300, mean: 180 }); expect(m.slippage.value).toBeNull(); expect(m.slippage.note).toMatch(/cannot be measured/);
    expect(m.costImpact.value).toBeCloseTo(10, 1);
  });
  it("only FINAL records with a result are eligible; PARTIAL and incomplete rows are ignored", () => {
    const rs = [win(), rec({ finality: "PARTIAL", outcomeId: null, netPnl: "50.00", closedAt: null, exitPrice: null }), rec({ netPnl: null as never })];
    expect(rs.filter(isEligible)).toHaveLength(1); expect(computeMetrics(rs, 30).eligible).toBe(1);
  });
  it("reliability: too few = INSUFFICIENT_DATA; any fixture record = NOT_VALIDATED_FIXTURE whatever the size; graded by size otherwise", () => {
    expect(reliabilityOf(many(10, () => win()), 30)).toBe("INSUFFICIENT_DATA");
    expect(reliabilityOf(many(500, () => win({ dataSource: "FIXTURE" })), 30)).toBe("NOT_VALIDATED_FIXTURE");
    expect(reliabilityOf([...many(499, () => win()), win({ dataSource: "FIXTURE" })], 30)).toBe("NOT_VALIDATED_FIXTURE"); // one fixture record taints the set
    expect(reliabilityOf(many(40, () => win()), 30)).toBe("LOW"); expect(reliabilityOf(many(150, () => win()), 30)).toBe("MODERATE"); expect(reliabilityOf(many(250, () => win()), 30)).toBe("ADEQUATE");
  });
  it("slices keep unknown values apart and never merge strategy versions", () => {
    const rs = [win({ setup: "BREAKOUT", detectorVersion: "v1" }), win({ setup: "BREAKOUT", detectorVersion: "v2" }), win({ setup: null }), loss({ setup: "REVERSAL", detectorVersion: "v1", instrument: "OTHER" })];
    const byVersion = sliceBy(rs, DIMENSIONS["strategyVersion"]!, 30).map((s) => s.key).sort();
    expect(byVersion).toEqual(["BREAKOUT@v1", "BREAKOUT@v2", "REVERSAL@v1", "UNKNOWN"]);
    expect(sliceBy(rs, DIMENSIONS["regime"]!, 30)).toEqual([expect.objectContaining({ key: "UNKNOWN" })]);
    expect(sliceBy(rs, DIMENSIONS["stopBehaviour"]!, 30).map((s) => s.key).sort()).toEqual(["STOP_HIT", "STOP_NOT_HIT"]);
    expect(sliceBy(rs, DIMENSIONS["instrument"]!, 30).find((s) => s.key === "OTHER")!.metrics.eligible).toBe(1);
  });
});
