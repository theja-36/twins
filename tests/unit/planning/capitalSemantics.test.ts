/** M08-07 trading budget semantics: the budget IS the account's available capital; capital committed elsewhere (total - available) never enlarges any limit. */
import { describe, expect, it } from "vitest";
import { sizePosition } from "../../../packages/planning/src";
import { base } from "./fixtures";

const sized = (o: Parameters<typeof base>[0]) => { const r = sizePosition(base(o)); if (r.status !== "SIZED") throw new Error(`not sized: ${r.reason}`); return r; };
describe("trading budget = available capital (M08-07)", () => {
  it("committed capital is excluded: the risk budget is a percent of AVAILABLE, not total", () => {
    const r = sized({ capital: { total: "1000000", available: "200000" } });
    expect(r.riskBudget.effectiveBudget).toBe("2000.00"); // 1% of 200,000
    expect(sizePosition(base({ capital: { total: "1000000", available: "1000000" } })).riskBudget.effectiveBudget).toBe("10000.00");
  });
  it("the same available capital gives the same size whatever the total", () => {
    const a = sized({ capital: { total: "300000", available: "200000" } }), b = sized({ capital: { total: "9000000", available: "200000" } });
    expect(a.lots).toBe(b.lots); expect(a.maxLossAtStop).toBe(b.maxLossAtStop);
  });
  it("the capital bound on lots uses available: a long position never costs more than what is free", () => {
    const r = sized({ capital: { total: "1000000", available: "10000" } });
    expect(Number(r.grossExposure)).toBeLessThanOrEqual(10000);
    expect(r.limitsApplied.some((l) => l.startsWith("capital="))).toBe(true);
  });
  it("maxPositionNotionalPct is a percent of AVAILABLE capital and only ever narrows", () => {
    const wide = sized({ capital: { total: "1000000", available: "400000" } });
    const capped = sized({ capital: { total: "1000000", available: "400000" }, policy: { ...base().policy, maxPositionNotionalPct: "10" } });
    expect(Number(capped.grossExposure)).toBeLessThanOrEqual(40000);
    expect(capped.lots).toBeLessThan(wide.lots);
    expect(capped.limitsApplied.some((l) => l.startsWith("position_notional_pct="))).toBe(true);
  });
  it("available above total, zero or missing capital is refused, never defaulted", () => {
    for (const capital of [{ total: "100", available: "200" }, { total: "0", available: "0" }, { total: "1000", available: "0" }]) {
      expect(sizePosition(base({ capital })).status).toBe("NOT_SIZED");
    }
  });
});
