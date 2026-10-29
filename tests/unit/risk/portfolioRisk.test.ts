import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  correlationGroupOf, DEFAULT_PORTFOLIO_CONFIG, directionOf, evaluatePortfolio, evaluatePortfolioRisk, loadPortfolioConfig, parseCorrelationGroups, PORTFOLIO_REASONS, type ExposureInput, type PortfolioConfig,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, resetRuntimeState } from "../../../packages/runtime-state/src/index";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;
afterEach(() => configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }));

const CAPITAL = 1_000_000; // default limits: total 30,000 · group 20,000 · underlying 15,000 · market 30,000 · expiry 10,000 · counts 5 / 3 / 2 / 2
let n = 0;
const ex = (underlying: string, amount: number, o: Partial<ExposureInput> = {}): ExposureInput => ({ id: `e${++n}`, source: "risk_decision", maxLossAmount: amount, market: "NSE", instrumentType: "equity", underlying, side: "BUY", expiry: null, ...o });
const run = (candidate: ExposureInput | null, active: ExposureInput[] = [], config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG, capital: number | null = CAPITAL) => evaluatePortfolio({ capital, candidate, active, config });
const cfg = (env: Record<string, string>) => loadPortfolioConfig(env);

describe("defaults", () => {
  it("3% total, 2% per correlation group, 1.5% per underlying, 5 active / 3 per group / 2 per underlying; NIFTY and BANKNIFTY share INDIA_INDEX", () => {
    const c = DEFAULT_PORTFOLIO_CONFIG;
    expect([c.maxTotalRiskPct, c.maxGroupRiskPct, c.maxUnderlyingRiskPct, c.maxActive, c.maxActivePerGroup, c.maxActivePerUnderlying]).toEqual([3, 2, 1.5, 5, 3, 2]);
    expect(c.correlationGroups).toEqual({ INDIA_INDEX: ["NIFTY", "BANKNIFTY"] });
    expect(correlationGroupOf("nifty", c)).toBe("INDIA_INDEX");
    expect(correlationGroupOf("BANKNIFTY", c)).toBe("INDIA_INDEX");
    expect(correlationGroupOf("RELIANCE", c)).toBe("UNDERLYING:RELIANCE");
  });
});

describe("outcomes: APPROVED_FOR_REVIEW only if every limit passes", () => {
  it("a single candidate within the limits", () => {
    const r = run(ex("RELIANCE", 5000));
    expect(r).toMatchObject({ outcome: "APPROVED_FOR_REVIEW", reasonCode: null, failures: [] });
    expect(r.resulting["total"]).toMatchObject({ amount: 5000, pct: 0.5, count: 1 });
    expect(r.proposed).toMatchObject({ amount: 5000, pct: 0.5 });
  });
  it("sitting exactly on a limit passes; one paisa above fails", () => {
    expect(run(ex("RELIANCE", 15000)).outcome).toBe("APPROVED_FOR_REVIEW");
    expect(run(ex("RELIANCE", 15000.01)).reasonCode).toBe("UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED");
  });
  // each row: [name, candidate, active, config overrides, expected outcome, expected primary reason]
  type Row = [string, ExposureInput, ExposureInput[], Record<string, string>, "APPROVED_FOR_REVIEW" | "REJECTED", string | null];
  const rows = (): Row[] => [
    ["total portfolio risk exceeded", ex("TCS", 5000), [ex("A", 9000), ex("B", 9000), ex("C", 9000)], {}, "REJECTED", "PORTFOLIO_RISK_LIMIT_EXCEEDED"],
    ["absolute total cap exceeded", ex("TCS", 5000), [ex("A", 4000)], { TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "8000" }, "REJECTED", "PORTFOLIO_RISK_LIMIT_EXCEEDED"],
    ["market risk exceeded (market cap tighter than total)", ex("TCS", 5000), [ex("A", 7000)], { TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "1" }, "REJECTED", "MARKET_RISK_LIMIT_EXCEEDED"],
    ["another market is not counted against this market", ex("TCS", 5000), [ex("A", 7000, { market: "BSE" })], { TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "1" }, "APPROVED_FOR_REVIEW", null],
    ["NIFTY + BANKNIFTY combined exposure (same correlation group)", ex("BANKNIFTY", 9000, { instrumentType: "option" }), [ex("NIFTY", 12000, { instrumentType: "option" })], {}, "REJECTED", "CORRELATION_GROUP_LIMIT_EXCEEDED"],
    ["NIFTY + BANKNIFTY within the group limit", ex("BANKNIFTY", 7000), [ex("NIFTY", 12000)], {}, "APPROVED_FOR_REVIEW", null],
    ["unrelated underlyings do not share a group", ex("INFY", 9000), [ex("TCS", 12000)], {}, "APPROVED_FOR_REVIEW", null],
    ["same-underlying concentration", ex("RELIANCE", 6000), [ex("RELIANCE", 10000)], {}, "REJECTED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED"],
    ["equity + futures + options on one underlying are related exposure", ex("RELIANCE", 6000, { instrumentType: "option", expiry: "2031-12-30" }), [ex("RELIANCE", 5000, { instrumentType: "equity" }), ex("RELIANCE", 5000, { instrumentType: "future", expiry: "2031-12-30" })], {}, "REJECTED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED"],
    ["same underlying + same expiry (tighter group)", ex("NIFTY", 5000, { instrumentType: "option", expiry: "2031-12-30" }), [ex("NIFTY", 6000, { instrumentType: "option", expiry: "2031-12-30" })], {}, "REJECTED", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED"],
    ["same underlying, different expiry is not the tighter group", ex("NIFTY", 5000, { instrumentType: "option", expiry: "2032-01-27" }), [ex("NIFTY", 6000, { instrumentType: "option", expiry: "2031-12-30" })], {}, "APPROVED_FOR_REVIEW", null],
    ["opposite directions do not net (gross exposure)", ex("RELIANCE", 8000, { side: "SELL" }), [ex("RELIANCE", 8000, { side: "BUY" })], {}, "REJECTED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED"],
    ["maximum active decisions", ex("F", 100), ["A", "B", "C", "D", "E"].map((u) => ex(u, 100)), {}, "REJECTED", "MAX_ACTIVE_DECISIONS_EXCEEDED"],
    ["four active is still room for a fifth", ex("F", 100), ["A", "B", "C", "D"].map((u) => ex(u, 100)), {}, "APPROVED_FOR_REVIEW", null],
    ["maximum decisions per correlation group", ex("BANKNIFTY", 100), [ex("NIFTY", 100), ex("NIFTY", 100), ex("BANKNIFTY", 100)], { TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "3" }, "REJECTED", "CORRELATION_GROUP_LIMIT_EXCEEDED"],
    ["maximum decisions per underlying", ex("RELIANCE", 100), [ex("RELIANCE", 100), ex("RELIANCE", 100)], {}, "REJECTED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED"],
    ["maximum decisions per underlying+expiry", ex("NIFTY", 100, { expiry: "2031-12-30" }), [ex("NIFTY", 100, { expiry: "2031-12-30" }), ex("NIFTY", 100, { expiry: "2031-12-30" })], { TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "5", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "5" }, "REJECTED", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED"],
    ["open-position exposure (future source) counts like a decision", ex("RELIANCE", 8000), [ex("RELIANCE", 8000, { source: "open_position" })], {}, "REJECTED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED"],
    ["a configured custom correlation group applies", ex("TCS", 11000), [ex("INFY", 11000)], { TWINS_PORTFOLIO_CORRELATION_GROUPS: "IT=TCS,INFY" }, "REJECTED", "CORRELATION_GROUP_LIMIT_EXCEEDED"],
    ["with no groups configured NIFTY and BANKNIFTY are independent", ex("BANKNIFTY", 9000), [ex("NIFTY", 12000)], { TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" }, "APPROVED_FOR_REVIEW", null],
  ];
  it.each(rows().map((r) => [r[0], r] as const))("%s", (_name, [, candidate, active, env, outcome, reason]) => {
    const r = run(candidate, active, cfg(env));
    expect({ outcome: r.outcome, reason: r.reasonCode }).toEqual({ outcome, reason });
    if (outcome === "REJECTED") expect(r.failures.length).toBeGreaterThan(0);
    expect(r.snapshot).toMatchObject({ outcome, limits: expect.any(Object), current: expect.any(Object), proposed: expect.any(Object), resulting: expect.any(Object) });
  });
  it("reports every failing limit and picks the primary reason by fixed precedence (portfolio > market > group > underlying > expiry > count)", () => {
    const r = run(ex("NIFTY", 12000, { expiry: "2031-12-30" }), [ex("NIFTY", 12000, { expiry: "2031-12-30" }), ex("BANKNIFTY", 9000)]);
    expect(r.reasonCode).toBe("PORTFOLIO_RISK_LIMIT_EXCEEDED"); // 33,000 > 30,000
    expect(new Set(r.failures.map((f) => f.reason))).toEqual(new Set(["PORTFOLIO_RISK_LIMIT_EXCEEDED", "MARKET_RISK_LIMIT_EXCEEDED", "CORRELATION_GROUP_LIMIT_EXCEEDED", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED"]));
    expect(PORTFOLIO_REASONS).toHaveLength(6);
  });
  it("exposes current, proposed and resulting exposure and the evaluated limits", () => {
    const r = run(ex("NIFTY", 4000, { expiry: "2031-12-30" }), [ex("BANKNIFTY", 6000)]);
    expect(r.current["group"]).toMatchObject({ amount: 6000, pct: 0.6, count: 1 });
    expect(r.resulting["group"]).toMatchObject({ amount: 10000, pct: 1, count: 2 });
    expect(r.resulting["underlying"]).toMatchObject({ amount: 4000, count: 1 });
    expect(r.limits).toMatchObject({ totalRiskAmount: 30000, groupRiskAmount: 20000, underlyingRiskAmount: 15000, maxActive: 5, maxActivePerGroup: 3, maxActivePerUnderlying: 2 });
    expect(r.candidate).toMatchObject({ correlationGroup: "INDIA_INDEX", direction: "LONG", maxLossPercent: 0.4, expiryKey: "NIFTY|2031-12-30" });
  });
});

describe("invalid input is never evaluated or approved", () => {
  it.each([
    ["missing sizing (no planned loss)", ex("RELIANCE", 0), CAPITAL, "portfolio_sizing_missing"],
    ["negative planned loss", ex("RELIANCE", -5), CAPITAL, "portfolio_sizing_missing"],
    ["zero capital", ex("RELIANCE", 100), 0, "portfolio_capital_invalid"],
    ["missing capital", ex("RELIANCE", 100), null, "portfolio_capital_invalid"],
    ["missing market", ex("RELIANCE", 100, { market: null }), CAPITAL, "portfolio_market_missing"],
    ["missing underlying", ex(" ", 100), CAPITAL, "portfolio_underlying_missing"],
    ["unknown direction", ex("RELIANCE", 100, { side: "HOLD" }), CAPITAL, "portfolio_direction_invalid"],
  ] as Array<[string, ExposureInput, number | null, string]>)("%s -> INVALID_INPUT %s", (_n, candidate, capital, code) => {
    expect(run(candidate, [], DEFAULT_PORTFOLIO_CONFIG, capital)).toMatchObject({ outcome: "INVALID_INPUT", reasonCode: code });
  });
  it("a null candidate and a malformed active exposure are refused", () => {
    expect(run(null).outcome).toBe("INVALID_INPUT");
    expect(run(ex("A", 100), [ex("B", Number.NaN)])).toMatchObject({ outcome: "INVALID_INPUT", reasonCode: "portfolio_active_exposure_invalid" });
  });
  it("direction normalisation", () => {
    expect(["BUY", "long", "SELL", "Short", "x", null].map(directionOf)).toEqual(["LONG", "LONG", "SHORT", "SHORT", "UNKNOWN", "UNKNOWN"]);
  });
});

describe("configuration", () => {
  it("environment overrides apply and are reported as env-sourced", () => {
    const c = cfg({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "2.5", TWINS_PORTFOLIO_MAX_ACTIVE: "8", TWINS_PORTFOLIO_CORRELATION_GROUPS: "IT=TCS,INFY;BANKS=HDFCBANK,ICICIBANK" });
    expect(c).toMatchObject({ maxTotalRiskPct: 2.5, maxActive: 8, correlationGroups: { IT: ["TCS", "INFY"], BANKS: ["HDFCBANK", "ICICIBANK"] } });
    expect(c.source).toMatchObject({ maxTotalRiskPct: "env", maxActive: "env", maxGroupRiskPct: "default", correlationGroups: "env" });
  });
  it("a malformed or unsafe override makes the loader throw (no silent fallback)", () => {
    for (const env of [
      { TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "0" }, { TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "101" }, { TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "abc" }, { TWINS_PORTFOLIO_MAX_ACTIVE: "0" }, { TWINS_PORTFOLIO_MAX_ACTIVE: "2.5" },
      { TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "-1" }, { TWINS_PORTFOLIO_CORRELATION_GROUPS: "bad name=A" }, { TWINS_PORTFOLIO_CORRELATION_GROUPS: "A_GRP=X;B_GRP=X" }, { TWINS_PORTFOLIO_CORRELATION_GROUPS: "A_GRP=" },
    ]) expect(() => loadPortfolioConfig(env), JSON.stringify(env)).toThrow();
    expect(parseCorrelationGroups("NONE")).toEqual({});
  });
});

describe("properties (5,000 seeded cases)", () => {
  it("approval implies every resulting figure is within its limit; more existing exposure never turns a rejection into an approval", () => {
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const unders = ["NIFTY", "BANKNIFTY", "RELIANCE", "TCS", "INFY"];
    let approved = 0, rejected = 0;
    for (let i = 0; i < 5000; i++) {
      const mk = (): ExposureInput => ex(unders[Math.floor(rnd() * 5)] ?? "TCS", Math.round(rnd() * 12000), { expiry: rnd() < 0.5 ? "2031-12-30" : null, side: rnd() < 0.5 ? "BUY" : "SELL" });
      const active = Array.from({ length: Math.floor(rnd() * 5) }, mk);
      const candidate = { ...mk(), maxLossAmount: 1 + Math.round(rnd() * 12000) };
      const r = run(candidate, active);
      const again = run(candidate, active);
      expect(again).toEqual(r);
      if (r.outcome === "APPROVED_FOR_REVIEW") {
        approved++;
        const l = r.limits;
        expect((r.resulting["total"] as { amount: number }).amount).toBeLessThanOrEqual((l["totalRiskAmount"] as number) + 1e-6);
        expect((r.resulting["group"] as { amount: number }).amount).toBeLessThanOrEqual((l["groupRiskAmount"] as number) + 1e-6);
        expect((r.resulting["underlying"] as { amount: number }).amount).toBeLessThanOrEqual((l["underlyingRiskAmount"] as number) + 1e-6);
        expect((r.resulting["total"] as { count: number }).count).toBeLessThanOrEqual(5);
        expect((r.resulting["underlying"] as { count: number }).count).toBeLessThanOrEqual(2);
      } else {
        rejected++;
        expect(run(candidate, [...active, mk()]).outcome).not.toBe("APPROVED_FOR_REVIEW");
      }
    }
    expect(approved).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(300);
  });
});

describe("runtime state is checked before anything is read or written (fail closed)", () => {
  it("kill switch, intake off, an unreadable state and an unconfigured process all refuse without touching the database", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const set of [(s: ReturnType<typeof inMemoryStateSource>) => s.set({ KILL_SWITCH_ACTIVE: true }), (s: ReturnType<typeof inMemoryStateSource>) => s.set({ INTAKE_ENABLED: false }), (s: ReturnType<typeof inMemoryStateSource>) => s.failWith(new Error("down"))]) {
      const source = inMemoryStateSource();
      set(source);
      configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
      await expect(evaluatePortfolioRisk(untouchable, id, { capital: CAPITAL })).rejects.toMatchObject({ code: "safety_refused" });
    }
    resetRuntimeState();
    await expect(evaluatePortfolioRisk(untouchable, id)).rejects.toMatchObject({ code: "safety_refused" });
  });
});

describe("architecture: portfolio evaluation places no orders, calls no broker and writes nothing but risk decisions", () => {
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((x) => (statSync(join(ROOT, dir, x)).isDirectory() ? files(`${dir}/${x}`) : x.endsWith(".ts") ? [`${dir}/${x}`] : []));
  it("the engine and the config are pure (only node:crypto and each other; no clock, randomness or network)", () => {
    for (const f of ["packages/risk/src/portfolio/engine.ts", "packages/risk/src/portfolio/config.ts"]) {
      const code = strip(read(f));
      expect([...code.matchAll(/from\s+"([^"]+)"/g)].every((m) => m[1] === "node:crypto" || m[1] === "./config"), f).toBe(true);
      expect(code, f).not.toMatch(/Date\.now|new Date\(|Math\.random|fetch\(|process\.env\.[A-Z]/);
    }
  });
  it("no portfolio code references orders, fills, positions, brokers, Telegram or approval cards; the only write path is supersedeRiskDecision", () => {
    for (const f of files("packages/risk/src/portfolio")) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|decisions|claimReviewCards)\b|zerodha|kite|broker|telegram|sendMessage|approval card/i);
    const rec = strip(read("packages/risk/src/portfolio/record.ts"));
    expect(rec).not.toMatch(/\.insert\(|(db|tx)\.update\(|\.delete\(/);
    expect(rec).toContain("supersedeRiskDecision(");
    expect(read("packages/database/drizzle/0016_risk_decision_portfolio_review.sql")).toMatch(/risk_decisions_portfolio_review_check[\s\S]*portfolio[\s\S]*NOT VALID/);
  });
});
