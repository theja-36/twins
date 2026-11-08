import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessRisk, DEFAULT_RISK_EXTRAS, haltTriggers, preflightRisk, sizePosition, type RiskContext, type RiskDecision } from "../../../packages/planning/src/index";
import { FEES, SPEC } from "./fixtures";

const MON_1030 = new Date("2031-01-06T05:00:00Z"); // Monday 10:30 IST
const regime = (o: Record<string, unknown> = {}) => ({ underlying: "ACME", regime: "TRENDING_UP", volatilityRegime: "NORMAL", eventRisk: "NONE", riskOff: false, dataSource: "LIVE", asOf: MON_1030.toISOString(), freshness: { stale: false }, ...o });
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: MON_1030, userId: "11111111-1111-4111-8111-111111111111", extras: DEFAULT_RISK_EXTRAS, capital: { total: "1000000", available: "1000000" },
  limits: { policyVersion: 3, riskPercent: "1", maxRiskPerTrade: null, maxDailyLoss: "20000", maxConcurrentPositions: 3, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: null, maxPortfolioExposurePct: null, maxCorrelatedRiskPct: null, maxPositionNotionalPct: null },
  candidate: { id: "c1", source: "INDEPENDENT", underlying: "ACME", exchange: "NSE", side: "BUY", instrumentType: "equity", entry: 100, stop: 98, stopBasis: "price", targets: [104, 106], expiry: null, setup: "BREAKOUT" },
  spec: SPEC, fees: FEES, portfolio: { openPositions: [], realizedLossToday: "0", equityCurve: null, asOf: MON_1030.toISOString() }, regime: regime(), liquidityQuoteAvailable: true, controls: [], evidence: ["research_package:p1"], ...o,
});
function run(c: RiskContext, liq = null): { d: RiskDecision; sizing: ReturnType<typeof sizePosition> } {
  const pre = preflightRisk(c);
  const sizing = sizePosition({ side: c.candidate.side, entry: c.candidate.entry ?? 0, stop: c.candidate.stop, stopBasis: c.candidate.stopBasis, targets: c.candidate.targets, spec: c.spec, fees: c.fees, capital: c.capital, caps: pre.caps, sizeMultiplier: pre.sizeMultiplier, slippageBps: { entry: 5, exit: 5 }, policy: { riskPercent: c.limits.riskPercent, maxRiskPerTrade: c.limits.maxRiskPerTrade, maxLots: c.limits.maxLots, maxPositionNotionalPct: c.limits.maxPositionNotionalPct } });
  return { d: assessRisk(c, pre, sizing, liq), sizing };
}
const codes = (d: RiskDecision, sev?: string) => d.reasons.filter((r) => !sev || r.severity === sev).map((r) => r.code);

describe("risk assessment", () => {
  it("PASSES a clean, fully-evidenced trade and still says the stop is only structurally checked", () => {
    const { d, sizing } = run(ctx());
    expect(d.verdict).toBe("PASS"); expect(sizing.status).toBe("SIZED");
    expect(d).toMatchObject({ policyVersion: 3, engineVersion: "risk-assessment-v1", grantsApproval: false, sizeMultiplier: 1, evaluatedAt: MON_1030.toISOString() });
    expect(d.stop).toMatchObject({ structurallyValid: true, independentlyValidated: false });
    expect(codes(d, "INFO")).toContain("STOP_VALIDATION_PENDING");
    expect(d.evidence).toEqual(expect.arrayContaining(["research_package:p1", "candidate:c1", "spec:test-spec-1", "fees:test-fees-1"]));
    expect(d.limits).toMatchObject({ riskPercent: "1", maxDailyLoss: "20000", minRewardToRisk: "1.5" });
  });
  it("BLOCKS every unsafe stop with the exact reason and a corrective action", () => {
    for (const [stop, code] of [[null, "STOP_MISSING"], [101, "STOP_WRONG_SIDE"], [0, "STOP_INVALID"], [100, "STOP_EQUALS_ENTRY"], [98.03, "PRICE_OFF_TICK"]] as const) {
      const { d } = run(ctx({ candidate: { ...ctx().candidate, stop } }));
      expect(d.verdict, String(stop)).toBe("BLOCKED"); expect(codes(d, "BLOCK")).toContain(code);
      expect(d.stop.structurallyValid).toBe(false); expect(d.correctiveActions.length).toBeGreaterThan(0);
    }
    expect(codes(run(ctx({ candidate: { ...ctx().candidate, stopBasis: "premium" } })).d, "BLOCK")).toContain("STOP_BASIS_MISMATCH");
    expect(run(ctx({ candidate: { ...ctx().candidate, entry: null } })).d.verdict).toBe("BLOCKED");
  });
  it("BLOCKS when the specification, fees, portfolio state or an allowed-underlying rule cannot be satisfied", () => {
    expect(codes(run(ctx({ spec: null })).d, "BLOCK")).toContain("SPEC_UNAVAILABLE");
    expect(codes(run(ctx({ fees: null })).d, "BLOCK")).toContain("FEES_UNAVAILABLE");
    expect(codes(run(ctx({ portfolio: null })).d, "BLOCK")).toContain("PORTFOLIO_STATE_UNAVAILABLE");
    expect(codes(run(ctx({ limits: { ...ctx().limits, allowedUnderlyings: ["NIFTY"] } })).d, "BLOCK")).toContain("UNDERLYING_NOT_ALLOWED");
  });
  it("RESTRICTS (smaller size) on unverified specs, missing/fixture/high-volatility/event conditions, unknown liquidity and expiry day", () => {
    const full = run(ctx()).sizing.lots;
    const cases: Array<[string, Partial<RiskContext>]> = [
      ["SPEC_UNVERIFIED", { spec: { ...SPEC, sourceKind: "OPERATOR_FILE", sourceRef: null } }], ["FEES_UNVERIFIED", { fees: { ...FEES, sourceKind: "FIXTURE" } }],
      ["MARKET_DATA_UNAVAILABLE", { regime: null }], ["MARKET_DATA_UNAVAILABLE", { regime: regime({ freshness: { stale: true } }) }], ["MARKET_DATA_UNAVAILABLE", { regime: regime({ regime: "UNKNOWN" }) }], ["MARKET_DATA_UNAVAILABLE", { regime: regime({ underlying: "OTHER" }) }],
      ["REGIME_FIXTURE_BACKED", { regime: regime({ dataSource: "FIXTURE" }) }], ["VOLATILITY_HIGH", { regime: regime({ volatilityRegime: "HIGH" }) }], ["VOLATILITY_HIGH", { regime: regime({ regime: "HIGH_VOLATILITY" }) }],
      ["EVENT_RISK_ELEVATED", { regime: regime({ eventRisk: "ELEVATED" }) }], ["EVENT_RISK_UNKNOWN", { regime: regime({ eventRisk: "UNKNOWN" }) }], ["LIQUIDITY_UNKNOWN", { liquidityQuoteAvailable: false }],
      ["EXPIRY_DAY", { candidate: { ...ctx().candidate, expiry: "2031-01-06" } }],
    ];
    for (const [code, o] of cases) {
      const { d, sizing } = run(ctx(o));
      expect(d.verdict, code).toBe("RESTRICTED"); expect(codes(d, "RESTRICT"), code).toContain(code);
      expect(d.sizeMultiplier).toBeLessThan(1); expect(sizing.lots).toBeLessThan(full);
    }
  });
  it("BLOCKS on risk-off, extreme volatility, high event risk, an expired instrument and a regime policy of BLOCK", () => {
    expect(codes(run(ctx({ regime: regime({ riskOff: true }) })).d, "BLOCK")).toContain("REGIME_RISK_OFF");
    expect(codes(run(ctx({ regime: regime({ volatilityRegime: "EXTREME" }) })).d, "BLOCK")).toContain("VOLATILITY_EXTREME");
    expect(codes(run(ctx({ regime: regime({ eventRisk: "HIGH" }) })).d, "BLOCK")).toContain("EVENT_RISK_HIGH");
    expect(codes(run(ctx({ candidate: { ...ctx().candidate, expiry: "2031-01-03" } })).d, "BLOCK")).toContain("INSTRUMENT_EXPIRED");
    expect(codes(run(ctx({ regime: null, extras: { ...DEFAULT_RISK_EXTRAS, missingRegime: "BLOCK" } })).d, "BLOCK")).toContain("MARKET_DATA_UNAVAILABLE");
  });
  it("BLOCKS outside the session, on weekends and in the closing window", () => {
    const at = (iso: string) => codes(run(ctx({ now: new Date(iso) })).d, "BLOCK");
    expect(at("2031-01-04T05:00:00Z")).toContain("MARKET_CLOSED");      // Saturday
    expect(at("2031-01-06T03:00:00Z")).toContain("OUTSIDE_SESSION");    // 08:30 IST
    expect(at("2031-01-06T10:00:00Z")).toContain("OUTSIDE_SESSION");    // 15:30 IST
    expect(at("2031-01-06T09:50:00Z")).toContain("CLOSING_WINDOW");     // 15:20 IST
    expect(at("2031-01-06T09:30:00Z")).not.toContain("CLOSING_WINDOW"); // 15:00 IST, before the 15-minute buffer
  });
  it("enforces the daily loss limit, the open-risk budget, concurrency, correlated exposure and total exposure", () => {
    const pf = (o: Record<string, unknown>) => ({ openPositions: [], realizedLossToday: "0", equityCurve: null, asOf: MON_1030.toISOString(), ...o }) as never;
    const open = (u: string, risk: string, notional = "100000") => ({ underlying: u, side: "BUY" as const, notional, riskAmount: risk });
    expect(codes(run(ctx({ portfolio: pf({ realizedLossToday: "20000" }) })).d, "BLOCK")).toContain("DAILY_LOSS_LIMIT_REACHED");
    expect(codes(run(ctx({ portfolio: pf({ realizedLossToday: "12000", openPositions: [open("X", "8000")] }) })).d, "BLOCK")).toContain("DAILY_RISK_BUDGET_EXHAUSTED");
    expect(codes(run(ctx({ portfolio: pf({ openPositions: [open("A", "1"), open("B", "1"), open("C", "1")] }) })).d, "BLOCK")).toContain("MAX_CONCURRENT_POSITIONS");
    expect(codes(run(ctx({ portfolio: pf({ openPositions: [open("X", "50000")] }) })).d, "BLOCK")).toContain("PORTFOLIO_RISK_BUDGET_EXHAUSTED");
    const grp = run(ctx({ candidate: { ...ctx().candidate, underlying: "NIFTY" }, spec: { ...SPEC, underlying: "NIFTY" }, regime: regime({ underlying: "NIFTY" }), portfolio: pf({ openPositions: [open("BANKNIFTY", "30000")] }) }));
    expect(codes(grp.d, "BLOCK")).toContain("CORRELATED_EXPOSURE_LIMIT");
    expect(codes(run(ctx({ portfolio: pf({ openPositions: [open("X", "100", "999000")] }) })).d, "BLOCK")).toContain("PORTFOLIO_EXPOSURE_LIMIT");
  });
  it("shrinks the size to the remaining daily and group headroom (RESTRICTED) instead of ignoring it", () => {
    const pf = { openPositions: [{ underlying: "X", side: "BUY" as const, notional: "50000", riskAmount: "4000" }], realizedLossToday: "10000", equityCurve: null, asOf: MON_1030.toISOString() };
    const { d, sizing } = run(ctx({ portfolio: pf }));
    expect(d.verdict).toBe("RESTRICTED"); expect(codes(d, "RESTRICT")).toContain("SIZE_LIMITED_BY_BUDGET");
    expect(Number(sizing.maxLossAtStop)).toBeLessThanOrEqual(6000); // 20,000 - 10,000 - 4,000
    expect(d.exposure).toMatchObject({ openCount: 1, openRisk: "4000.00", realizedLossToday: "10000.00" });
  });
  it("applies reward-to-risk, liquidity and drawdown rules", () => {
    expect(codes(run(ctx({ candidate: { ...ctx().candidate, targets: [100.5] } })).d, "BLOCK")).toContain("REWARD_TO_RISK_TOO_LOW");
    expect(codes(run(ctx({ candidate: { ...ctx().candidate, targets: [] } })).d, "BLOCK")).toContain("REWARD_TO_RISK_UNKNOWN");
    expect(codes(run(ctx({ candidate: { ...ctx().candidate, targets: [97] } })).d, "BLOCK")).toContain("REWARD_TO_RISK_UNKNOWN");
    const liq = (verdict: string) => ({ version: "liquidity-guard-v1", verdict, spreadBps: null, halfSpreadBps: null, participation: null, impactBps: null, expectedSlippageBps: null, touchShare: null, suggestedMaxQuantity: 0, reasons: [], unknownInputs: [], grantsApproval: false }) as never;
    expect(codes(run(ctx(), liq("TOO_LARGE")).d, "BLOCK")).toContain("LIQUIDITY_TOO_LARGE");
    expect(run(ctx(), liq("CAUTION")).d.verdict).toBe("RESTRICTED");
    const curve = (peak: number, now: number) => [{ at: "2031-01-01T00:00:00Z", equity: peak }, { at: "2031-01-05T00:00:00Z", equity: now }];
    const withCurve = (now: number) => run(ctx({ portfolio: { openPositions: [], realizedLossToday: "0", equityCurve: curve(1_000_000, now), asOf: MON_1030.toISOString() } }));
    expect(codes(withCurve(900_000).d, "BLOCK")).toContain("DRAWDOWN_HALT");
    expect(withCurve(965_000).d.verdict).toBe("RESTRICTED");
    expect(withCurve(1_000_000).d.verdict).toBe("PASS");
  });
  it("any active matching control BLOCKS: user, market, source, strategy, halts; expired and non-matching ones do not", () => {
    const k = (o: Record<string, unknown>) => ({ scope: "MARKET", scopeKey: "NSE", kind: "RESTRICTION", reason: "test restriction", setAt: MON_1030.toISOString(), expiresAt: null, id: "k1", ...o }) as never;
    expect(codes(run(ctx({ controls: [k({})] })).d, "BLOCK")).toContain("CONTROL_RESTRICTION");
    expect(run(ctx({ controls: [k({ scope: "USER", scopeKey: "11111111-1111-4111-8111-111111111111", kind: "DAILY_LOSS_HALT" })] })).d.verdict).toBe("BLOCKED");
    expect(run(ctx({ controls: [k({ scope: "SOURCE", scopeKey: "INDEPENDENT", kind: "KILL_SWITCH" })] })).d.verdict).toBe("BLOCKED");
    expect(run(ctx({ controls: [k({ scope: "STRATEGY", scopeKey: "BREAKOUT" })] })).d.verdict).toBe("BLOCKED");
    for (const other of [k({ scopeKey: "BSE" }), k({ scope: "SOURCE", scopeKey: "TELEGRAM" }), k({ scope: "STRATEGY", scopeKey: "REVERSAL" }), k({ scope: "USER", scopeKey: "22222222-2222-4222-8222-222222222222" }), k({ expiresAt: new Date(MON_1030.getTime() - 1).toISOString() })]) expect(run(ctx({ controls: [other] })).d.verdict).toBe("PASS");
  });
  it("cannot be relaxed: confidence and verdicts are not inputs, and the engine source never reads them", () => {
    const a = run(ctx()).d, b = run({ ...ctx(), confidence: { score: 100 }, agentVerdict: "SUPPORTIVE", userPreference: "ignore limits" } as never).d;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const src = readFileSync(join(__dirname, "../../../packages/planning/src/risk.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/confidence|calibrat|winProbab|sentiment|SUPPORTIVE/i);
  });
  it("is deterministic and never returns a multiplier above 1", () => {
    const a = JSON.stringify(run(ctx()).d), b = JSON.stringify(run(ctx()).d);
    expect(a).toBe(b);
    for (const c of [ctx({ regime: null }), ctx({ regime: regime({ volatilityRegime: "HIGH", eventRisk: "ELEVATED" }) })]) { const m = preflightRisk(c).sizeMultiplier; expect(m).toBeGreaterThan(0); expect(m).toBeLessThanOrEqual(1); }
  });
  it("user tightenings only tighten: a per-user group limit and drawdown threshold", () => {
    const base = preflightRisk(ctx()).exposure.groupRiskLimit, tight = preflightRisk(ctx({ limits: { ...ctx().limits, maxCorrelatedRiskPct: "1" } })).exposure.groupRiskLimit;
    expect(Number(tight)).toBeLessThan(Number(base));
  });
});

describe("halt triggers and recovery policy", () => {
  const L = { maxDailyLoss: "20000", maxDrawdownPct: null };
  it("a breached daily limit calls for a halt that expires at the next IST day; a deep drawdown calls for one that never auto-expires", () => {
    const h = haltTriggers({ openPositions: [], realizedLossToday: "20000", equityCurve: [{ at: "2031-01-01T00:00:00Z", equity: 1000 }, { at: "2031-01-05T00:00:00Z", equity: 900 }], asOf: "x" }, L, DEFAULT_RISK_EXTRAS, MON_1030);
    expect(h.map((x) => x.kind).sort()).toEqual(["DAILY_LOSS_HALT", "DRAWDOWN_HALT"]);
    expect(h.find((x) => x.kind === "DAILY_LOSS_HALT")!.expiresAt!.toISOString()).toBe("2031-01-06T18:30:00.000Z"); // 2031-01-07 00:00 IST
    expect(h.find((x) => x.kind === "DRAWDOWN_HALT")!.expiresAt).toBeNull();
    expect(haltTriggers({ openPositions: [], realizedLossToday: "100", equityCurve: null, asOf: "x" }, L, DEFAULT_RISK_EXTRAS, MON_1030)).toEqual([]);
    expect(haltTriggers(null, L, DEFAULT_RISK_EXTRAS, MON_1030)).toEqual([]);
  });
});

describe("package boundaries", () => {
  it("the planning and confidence packages import no network, broker, Telegram, order or approval code and enable no sizing tier", () => {
    for (const pkg of ["planning", "confidence"]) {
      const dir = join(__dirname, `../../../packages/${pkg}/src`);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
        const code = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        expect(code, `${pkg}/${f}`).not.toMatch(/adapter-telegram|adapter-broker|kite|fetch\(|node:https?|node:net|axios|placeOrder|approveTrade|TRADING_ENABLED|liveTrading|tierPct|confidenceTier/i);
        expect(code, `${pkg}/${f}`).not.toMatch(/from "@twins\/(adapter|ingestion|approval|paper|signals)/);
      }
    }
  });
});
