import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearRiskControl, setRiskControl, RiskControlError } from "../../../packages/database/src/index";
import { dec, simulate, type SimulationInput } from "../../../packages/planning/src/index";
import { FEES, POLICY, SPEC, base } from "./fixtures";

const { policy: _p, ...b } = base();
const input = (o: Partial<SimulationInput> = {}): SimulationInput => ({ base: b as never, policy: POLICY, scenarios: [{ id: "BASE", label: "base" }], portfolio: null, groupOf: () => null, underlying: "ACME", ...o });

describe("what-if simulator", () => {
  it("runs scenarios through the production sizing engine and reports the financial outcomes with versions", () => {
    const r = simulate(input({ scenarios: [{ id: "BASE", label: "base" }, { id: "WIDE", label: "wider stop", stop: 96 }, { id: "TARGETS", label: "farther targets", targets: [110, 120] }] }));
    expect(r.informationalOnly).toBe(true); expect(r.grantsApproval).toBe(false);
    expect(r.versions).toEqual({ spec: "test-spec-1", specSource: "OFFICIAL", fees: "test-fees-1", feeSource: "OFFICIAL" });
    const [bs, wide, far] = r.scenarios;
    expect(bs!.permitted).toBe(true);
    expect(wide!.sizing.lots).toBeLessThan(bs!.sizing.lots);                       // a wider stop risks more per lot, so fewer lots
    expect(dec(wide!.sizing.maxLossAtStop)).toBeLessThanOrEqual(dec("10000"));
    expect(Number(far!.sizing.targets[0]!.grossRewardToRisk)).toBeGreaterThan(Number(bs!.sizing.targets[0]!.grossRewardToRisk));
    expect(bs!.sizing.targets[0]!.netProfit < bs!.sizing.targets[0]!.grossProfit || dec(bs!.sizing.targets[0]!.netProfit) < dec(bs!.sizing.targets[0]!.grossProfit)).toBe(true);
    expect(r.assumptions.length).toBeGreaterThan(3); expect(r.limitations.join(" ")).toMatch(/not a forecast/);
  });
  it("a scenario can request lots or a different risk allocation but is marked not permitted when it exceeds policy or the budget", () => {
    const r = simulate(input({ scenarios: [{ id: "FEW", label: "3 lots", lots: 3 }, { id: "MANY", label: "10000 lots", lots: 10_000 }, { id: "RISKY", label: "3% risk", riskPercent: "3" }, { id: "WILD", label: "9% risk", riskPercent: "9" }, { id: "HALF", label: "0.5%", riskPercent: "0.5" }] }));
    const by = Object.fromEntries(r.scenarios.map((s) => [s.id, s]));
    expect(by["FEW"]!.sizing.lots).toBe(3); expect(by["FEW"]!.permitted).toBe(true);
    expect(by["MANY"]!.permitted).toBe(false); expect(by["MANY"]!.notPermittedReasons.join()).toMatch(/LOTS_ABOVE_POLICY_MAX/);
    expect(by["RISKY"]!.notPermittedReasons).toContain("RISK_PERCENT_ABOVE_POLICY");
    expect(by["WILD"]!.notPermittedReasons).toContain("RISK_PERCENT_ABOVE_HARD_CEILING");
    expect(dec(by["WILD"]!.sizing.maxLossAtStop)).toBeLessThanOrEqual(dec("50000"));    // sized at the 5% ceiling, not at 9%
    expect(by["HALF"]!.sizing.lots).toBeLessThan(simulate(input()).scenarios[0]!.sizing.lots);
  });
  it("shows a scenario that cannot be sized as such, with the reason, and rejects duplicate ids", () => {
    const r = simulate(input({ scenarios: [{ id: "BAD", label: "no stop", stop: null }] }));
    expect(r.scenarios[0]).toMatchObject({ permitted: false }); expect(r.scenarios[0]!.notPermittedReasons).toContain("NOT_SIZED_STOP_MISSING"); expect(r.riskScenarios).toBeNull();
    expect(() => simulate(input({ scenarios: [{ id: "A", label: "" }, { id: "A", label: "" }] }))).toThrow(/duplicate/);
  });
  it("gap risk: a gap through the stop loses more than planned and may exceed the budget; a small gap does not", () => {
    const r = simulate(input({ shocks: { gapPct: [0.5, 5], adversePct: [1, 5], volShockPoints: [5], greeks: null } }));
    const [small, big] = r.riskScenarios!.gaps;
    expect(small!.gappedThroughStop).toBe(false); expect(dec(small!.totalLoss)).toBeLessThanOrEqual(dec(r.scenarios[0]!.sizing.maxLossAtStop));
    expect(big!.gappedThroughStop).toBe(true); expect(dec(big!.totalLoss)).toBeGreaterThan(dec(r.scenarios[0]!.sizing.maxLossAtStop)); expect(big!.exceedsRiskBudget).toBe(true);
    expect(Number(big!.multipleOfPlannedLoss)).toBeGreaterThan(1);
    const [adv1, adv5] = r.riskScenarios!.adverse;
    expect(adv1!.stoppedOut).toBe(false); expect(adv5!.stoppedOut).toBe(true);
    expect(r.riskScenarios!.volatility[0]).toMatchObject({ status: "NOT_MODELLED", pnl: null });
  });
  it("short positions gap upward", () => {
    const s = { ...b, side: "SELL", entry: 100, stop: 102, targets: [96] } as never;
    const r = simulate(input({ base: s, shocks: { gapPct: [5], adversePct: [], volShockPoints: [], greeks: null } }));
    expect(Number(r.riskScenarios!.gaps[0]!.fillPrice)).toBeGreaterThan(100);
  });
  it("volatility is modelled for options only when greeks are supplied", () => {
    const opt = { ...b, spec: { ...SPEC, instrumentType: "option" }, stopBasis: "premium", entry: 100, stop: 80, targets: [140] } as never;
    const r = simulate(input({ base: opt, shocks: { gapPct: [], adversePct: [], volShockPoints: [-5, 5], greeks: { delta: 0.5, vega: 0.8 } } }));
    expect(r.riskScenarios!.volatility.every((v) => v.status === "MODELLED")).toBe(true);
    expect(Number(r.riskScenarios!.volatility[0]!.pnl)).toBeLessThan(0); expect(Number(r.riskScenarios!.volatility[1]!.pnl)).toBeGreaterThan(0);
  });
  it("portfolio and correlated-position impact use the open positions and the daily budget", () => {
    const pf = { openPositions: [{ underlying: "BANKNIFTY", side: "BUY" as const, notional: "200000", riskAmount: "5000" }], realizedLossToday: "0", equityCurve: null, asOf: "x" };
    const caps = { remainingDailyRisk: "15000", remainingPortfolioRisk: null, remainingGroupRisk: null };
    const r = simulate(input({ base: { ...b, caps } as never, portfolio: pf, groupOf: (u) => (["NIFTY", "BANKNIFTY", "ACME"].includes(u) ? "INDEX" : null) }));
    expect(r.portfolioImpact).toMatchObject({ groupKey: "INDEX", positionsAfter: 2 });
    expect(dec(r.portfolioImpact!.openRiskAfter)).toBe(dec("5000") + dec(r.scenarios[0]!.sizing.maxLossAtStop));
    expect(dec(r.portfolioImpact!.groupRiskAfter)).toBe(dec(r.portfolioImpact!.openRiskAfter));
    expect(dec(r.portfolioImpact!.dailyBudgetAfterStopOut!)).toBe(dec("15000") - dec(r.scenarios[0]!.sizing.maxLossAtStop));
  });
  it("simultaneous scenarios add their worst cases with no diversification credit and are checked against capital and the daily limit", () => {
    const caps = { remainingDailyRisk: "12000", remainingPortfolioRisk: null, remainingGroupRisk: null };
    const r = simulate(input({ base: { ...b, caps } as never, scenarios: [{ id: "A", label: "a" }, { id: "B", label: "b" }, { id: "C", label: "c" }], simultaneous: ["A", "B"] }));
    expect(r.simultaneous!.ids).toEqual(["A", "B"]);
    expect(dec(r.simultaneous!.totalMaxLoss)).toBe(dec(r.scenarios[0]!.sizing.maxLossAtStop) * 2n);
    expect(r.simultaneous!.withinDailyLimit).toBe(false);  // two 10,000-ish losses against 12,000
    expect(r.simultaneous!.note).toMatch(/no diversification credit/);
  });
  it("is deterministic and writes nothing: pure in, pure out", () => {
    expect(JSON.stringify(simulate(input()))).toBe(JSON.stringify(simulate(input())));
    const src = readFileSync(join(__dirname, "../../../packages/planning/src/simulator.ts"), "utf8");
    expect(src).not.toMatch(/@twins\/database|insert\(|execute\(|fetch\(/);
  });
});

describe("risk control rules (before any database call)", () => {
  const db = { transaction: async () => { throw new Error("must not reach the database"); } } as never;
  const c = { scope: "USER" as const, scopeKey: "u", kind: "DAILY_LOSS_HALT" as const, userId: "11111111-1111-4111-8111-111111111111" };
  it("needs a real reason, a user for USER scope, and only an owner may clear a drawdown halt or a kill switch", async () => {
    await expect(setRiskControl(db, c, { reason: "short", actor: "a", actorKind: "SYSTEM" })).rejects.toThrow(RiskControlError);
    await expect(setRiskControl(db, { ...c, userId: null }, { reason: "long enough reason", actor: "a", actorKind: "SYSTEM" })).rejects.toMatchObject({ code: "USER_REQUIRED" });
    await expect(clearRiskControl(db, { ...c, kind: "DRAWDOWN_HALT" }, { reason: "reviewed and accepted", actor: "planning-cycle", actorKind: "SYSTEM" })).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    await expect(clearRiskControl(db, { ...c, kind: "KILL_SWITCH" }, { reason: "reviewed and accepted", actor: "planning-cycle", actorKind: "SYSTEM" })).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    // an owner passes the rules and reaches the database
    await expect(clearRiskControl(db, { ...c, kind: "DRAWDOWN_HALT" }, { reason: "reviewed and accepted", actor: "owner", actorKind: "OWNER" })).rejects.toThrow("must not reach");
  });
});

describe("migration 0037", () => {
  const sql = readFileSync(join(__dirname, "../../../packages/database/drizzle/0037_capital_risk_confidence.sql"), "utf8");
  it("is additive, append-only and owner-isolated", () => {
    expect(sql).toContain('CREATE TABLE "risk_control_events"');
    expect(sql).toContain("risk_control_events_no_update_delete"); expect(sql).toContain("risk_control_events_no_truncate");
    expect(sql).toContain('ALTER TABLE "risk_control_events" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("risk_control_events_clear_policy_check"); expect(sql).toContain("risk_assessments_verdict_check"); expect(sql).toContain("simulations_assessment_owner_fk");
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM/);
  });
  it("the fee fixture used in these tests is not shipped in any package", () => {
    for (const f of ["specs.ts", "costs.ts", "sizing.ts"]) expect(readFileSync(join(__dirname, "../../../packages/planning/src", f), "utf8")).not.toMatch(/test-spec|test-fees|0\.00297/);
    void FEES;
  });
});
