import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePositionSize, confidenceTier, DEFAULT_SIZING_CONFIG, HARD_MAX_RISK_PCT, loadSizingConfig, sizeRiskDecision, SIZING_STATUSES, trustTier, type SizingConfig, type SizingInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, resetRuntimeState } from "../../../packages/runtime-state/src/index";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;
afterEach(() => configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }));

const cfg = DEFAULT_SIZING_CONFIG;
const equity = (over: Partial<SizingInput> = {}): SizingInput => ({
  capital: 1_000_000, instrumentType: "equity", market: "NSE", side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", stopLossResult: "VALID", targets: [110, 120, 130],
  lotSize: null, confidenceScore: 90, sourceTrustTier: "HIGH", ...over,
});
const size = (over: Partial<SizingInput> = {}, config: SizingConfig = cfg) => computePositionSize(equity(over), config);

describe("defaults (conservative sizing defaults, not final portfolio limits)", () => {
  it("1% per trade; HIGH 100%, MEDIUM 50%, LOW 25%; confidence 75/50", () => {
    expect(cfg.maxRiskPct).toBe(1);
    expect(cfg.tierPct).toEqual({ HIGH: 100, MEDIUM: 50, LOW: 25 });
    expect(cfg.confidenceMin).toEqual({ HIGH: 75, MEDIUM: 50 });
    expect(cfg.availableCapital).toBeNull(); // nothing is sized until capital is configured
  });
});

describe("equity: size from the planned maximum loss", () => {
  it("high confidence + high trust may use the full per-trade cap: 1% of 1,000,000 = 10,000; 5 per share -> 2000 shares", () => {
    const r = size();
    expect(r).toMatchObject({ status: "SIZED", quantity: 2000, maxLossAmount: 10000, maxLossPercent: 1, riskPerUnit: 5, notional: 200000, riskRewardRatio: 2, appliedTier: "HIGH", perTradeCap: 10000, tierBudget: 10000 });
  });
  it("medium uses 50% and low uses 25% of the cap", () => {
    expect(size({ confidenceScore: 60 })).toMatchObject({ status: "SIZED", quantity: 1000, maxLossAmount: 5000, appliedTier: "MEDIUM" });
    expect(size({ confidenceScore: 20 })).toMatchObject({ status: "SIZED", quantity: 500, maxLossAmount: 2500, appliedTier: "LOW" });
    expect(size({ sourceTrustTier: "MODERATE" })).toMatchObject({ quantity: 1000, appliedTier: "MEDIUM" });
    expect(size({ sourceTrustTier: "LOW" })).toMatchObject({ quantity: 500, appliedTier: "LOW" });
  });
  it("the LOWER of confidence and trust applies", () => {
    expect(size({ confidenceScore: 99, sourceTrustTier: "LOW" }).appliedTier).toBe("LOW");
    expect(size({ confidenceScore: 10, sourceTrustTier: "HIGH" }).appliedTier).toBe("LOW");
  });
  it("quantity is rounded DOWN to whole units and the loss never exceeds the cap (3 per share: 3333 shares, loss 9999)", () => {
    const r = size({ entryPrice: 100, stopLoss: 97 });
    expect(r).toMatchObject({ quantity: 3333, maxLossAmount: 9999 });
    expect(r.maxLossAmount).toBeLessThanOrEqual(10000);
  });
  it("a short position (SELL) has its stop above the entry and sizes the same way", () => {
    expect(size({ side: "SELL", entryPrice: 100, stopLoss: 105, targets: [90] })).toMatchObject({ status: "SIZED", quantity: 2000, riskRewardRatio: 2 });
  });
});

describe("futures: price distance x contract multiplier x lots", () => {
  it("1000 -> 950, multiplier 10: 500 per lot, cap 10,000 -> 20 lots", () => {
    expect(size({ instrumentType: "future", entryPrice: 1000, stopLoss: 950, lotSize: 10 })).toMatchObject({ status: "SIZED", quantity: 20, riskPerUnit: 500, maxLossAmount: 10000, notional: 200000 });
  });
  it("the position is limited by available capital (never by rounding up the risk)", () => {
    const r = size({ capital: 10_000_000, instrumentType: "future", entryPrice: 24000, stopLoss: 23900, lotSize: 50 }); // cap 100,000 / 5,000 per lot = 20 lots; capital pays for 8
    expect(r).toMatchObject({ status: "SIZED", quantity: 8, reasonCode: "sized_capital_limited", maxLossAmount: 40000 });
  });
  it("a missing multiplier is INVALID_INPUT", () => {
    expect(size({ instrumentType: "future", lotSize: null })).toMatchObject({ status: "INVALID_INPUT", reasonCode: "lot_size_invalid", quantity: 0 });
  });
});

describe("options: premium x lot size x lots", () => {
  it("premium 120, stop 90, lot 25: 750 per lot, cap 5,000 -> 6 lots, loss 4,500, notional 18,000", () => {
    expect(size({ capital: 500_000, instrumentType: "option", entryPrice: 120, stopLoss: 90, lotSize: 25, targets: [150, 180] })).toMatchObject({ status: "SIZED", quantity: 6, riskPerUnit: 750, maxLossAmount: 4500, notional: 18000, riskRewardRatio: 1 });
  });
  it("one lot already above the risk cap is never rounded up: RISK_LIMIT_EXCEEDED", () => {
    const r = size({ capital: 500_000, instrumentType: "option", entryPrice: 200, stopLoss: 100, lotSize: 75 }); // 7,500 per lot > cap 5,000
    expect(r).toMatchObject({ status: "RISK_LIMIT_EXCEEDED", reasonCode: "min_lot_exceeds_risk_cap", quantity: 0, maxLossAmount: 0 });
  });
  it("one lot within the cap but above the tier budget is also refused (MEDIUM budget 2,500 < 3,000 per lot)", () => {
    const r = size({ capital: 500_000, instrumentType: "option", entryPrice: 130, stopLoss: 90, lotSize: 75, confidenceScore: 60 }); // 3,000 per lot
    expect(r).toMatchObject({ status: "RISK_LIMIT_EXCEEDED", reasonCode: "min_lot_exceeds_tier_budget", quantity: 0 });
  });
  it("a missing lot size is INVALID_INPUT; the lot must be a whole number", () => {
    expect(size({ instrumentType: "option", entryPrice: 120, stopLoss: 90, lotSize: null }).status).toBe("INVALID_INPUT");
    expect(size({ instrumentType: "option", entryPrice: 120, stopLoss: 90, lotSize: 12.5 }).status).toBe("INVALID_INPUT");
  });
});

describe("capital", () => {
  it("zero or negative capital -> INSUFFICIENT_CAPITAL; non-finite or missing -> INVALID_INPUT", () => {
    expect(size({ capital: 0 })).toMatchObject({ status: "INSUFFICIENT_CAPITAL", reasonCode: "capital_not_positive", quantity: 0 });
    expect(size({ capital: -5000 }).status).toBe("INSUFFICIENT_CAPITAL");
    expect(size({ capital: Number.NaN }).status).toBe("INVALID_INPUT");
    expect(size({ capital: null }).status).toBe("INVALID_INPUT");
  });
  it("capital below the cost of one unit -> INSUFFICIENT_CAPITAL", () => {
    expect(size({ capital: 50_000, entryPrice: 100_000, stopLoss: 99_999.99 })).toMatchObject({ status: "INSUFFICIENT_CAPITAL", reasonCode: "capital_below_one_unit" });
  });
  it("capital below the minimum viable risk (one unit risks more than the cap) -> RISK_LIMIT_EXCEEDED", () => {
    expect(size({ capital: 400, entryPrice: 100, stopLoss: 95 })).toMatchObject({ status: "RISK_LIMIT_EXCEEDED", reasonCode: "min_lot_exceeds_risk_cap" }); // cap 4 < 5
  });
});

describe("stop-loss, entry and direction: nothing is sized on a missing, invalid or unevaluated input", () => {
  it.each([
    ["missing stop", { stopLoss: null }, "stop_loss_missing"],
    ["zero stop", { stopLoss: 0 }, "stop_loss_missing"],
    ["unevaluated evidence", { stopLossResult: null }, "stop_loss_unevaluated"],
    ["INVALID evidence", { stopLossResult: "INVALID" }, "stop_loss_not_valid"],
    ["MISSING evidence", { stopLossResult: "MISSING" }, "stop_loss_not_valid"],
    ["AMBIGUOUS evidence", { stopLossResult: "AMBIGUOUS" }, "stop_loss_not_valid"],
    ["stop above a long entry", { stopLoss: 101 }, "stop_loss_wrong_side"],
    ["stop below a short entry", { side: "SELL", stopLoss: 95 }, "stop_loss_wrong_side"],
    ["stop equal to entry", { stopLoss: 100 }, "stop_loss_wrong_side"],
    ["missing entry", { entryPrice: null }, "entry_invalid"],
    ["zero premium", { entryPrice: 0 }, "entry_invalid"],
    ["negative entry", { entryPrice: -1 }, "entry_invalid"],
    ["non-finite entry", { entryPrice: Number.POSITIVE_INFINITY }, "entry_invalid"],
    ["missing side", { side: null }, "side_invalid"],
    ["unsupported instrument", { instrumentType: "fx" }, "instrument_type_unsupported"],
    ["confidence out of range", { confidenceScore: 101 }, "confidence_out_of_range"],
  ] as Array<[string, Partial<SizingInput>, string]>)("%s -> INVALID_INPUT %s", (_n, over, reason) => {
    expect(size(over)).toMatchObject({ status: "INVALID_INPUT", reasonCode: reason, quantity: 0, notional: 0, maxLossAmount: 0 });
  });
});

describe("confidence and source-trust tiers", () => {
  it("confidence: >= 75 HIGH, >= 50 MEDIUM, above 0 LOW, 0/null UNKNOWN", () => {
    expect([100, 75, 74.99, 50, 49.99, 0.01, 0, null].map((c) => confidenceTier(c, cfg))).toEqual(["HIGH", "HIGH", "MEDIUM", "MEDIUM", "LOW", "LOW", "UNKNOWN", "UNKNOWN"]);
  });
  it("trust: HIGH, MODERATE/MEDIUM, LOW; anything else (including UNKNOWN and absent) is UNKNOWN", () => {
    expect(["HIGH", "moderate", "MEDIUM", "LOW", "UNKNOWN", "weird", null].map(trustTier)).toEqual(["HIGH", "MEDIUM", "MEDIUM", "LOW", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  });
  it("unknown confidence or unknown trust is 0%: REJECTED and not sized", () => {
    for (const over of [{ confidenceScore: null }, { confidenceScore: 0 }, { sourceTrustTier: "UNKNOWN" }, { sourceTrustTier: null }] as Array<Partial<SizingInput>>) {
      expect(size(over)).toMatchObject({ status: "REJECTED", quantity: 0, maxLossAmount: 0, notional: 0 });
    }
    expect(size({ confidenceScore: null }).reasonCode).toBe("confidence_unknown");
    expect(size({ sourceTrustTier: "UNKNOWN" }).reasonCode).toBe("source_trust_unknown");
  });
});

describe("per-trade cap, absolute cap and configuration", () => {
  it("an absolute cap below the percentage cap wins", () => {
    const c = loadSizingConfig({ TWINS_SIZING_MAX_RISK_AMOUNT: "2000" });
    expect(size({}, c)).toMatchObject({ perTradeCap: 2000, quantity: 400, maxLossAmount: 2000 });
  });
  it("environment overrides apply and are reported as env-sourced", () => {
    const c = loadSizingConfig({ TWINS_SIZING_MAX_RISK_PCT: "0.5", TWINS_SIZING_TIER_PCT_MEDIUM: "40", TWINS_SIZING_AVAILABLE_CAPITAL: "250000", TWINS_SIZING_CONFIDENCE_HIGH_MIN: "80" });
    expect(c).toMatchObject({ maxRiskPct: 0.5, tierPct: { HIGH: 100, MEDIUM: 40, LOW: 25 }, availableCapital: 250000, confidenceMin: { HIGH: 80, MEDIUM: 50 } });
    expect(c.source).toMatchObject({ maxRiskPct: "env", tierMedium: "env", tierHigh: "default" });
  });
  it("a malformed or unsafe override makes the loader throw (no silent fallback)", () => {
    for (const env of [
      { TWINS_SIZING_MAX_RISK_PCT: "abc" }, { TWINS_SIZING_MAX_RISK_PCT: "0" }, { TWINS_SIZING_MAX_RISK_PCT: "-1" }, { TWINS_SIZING_MAX_RISK_PCT: String(HARD_MAX_RISK_PCT + 1) },
      { TWINS_SIZING_TIER_PCT_HIGH: "101" }, { TWINS_SIZING_TIER_PCT_HIGH: "30" }, // HIGH below MEDIUM
      { TWINS_SIZING_CONFIDENCE_HIGH_MIN: "40" }, { TWINS_SIZING_AVAILABLE_CAPITAL: "1e5" },
    ]) expect(() => loadSizingConfig(env), JSON.stringify(env)).toThrow();
  });
  it("the per-trade loss never exceeds the cap, whatever the inputs (property test over 5,000 seeded cases)", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const kinds = ["equity", "future", "option"];
    const tiers = ["HIGH", "MODERATE", "LOW", "UNKNOWN"];
    let sized = 0;
    for (let i = 0; i < 5000; i++) {
      const entry = Math.round((0.05 + rnd() * 5000) * 100) / 100;
      const buy = rnd() < 0.5;
      const dist = Math.round(rnd() * entry * 0.6 * 100) / 100;
      const input = equity({ capital: Math.round(rnd() * 5_000_000), instrumentType: kinds[Math.floor(rnd() * 3)] ?? "equity", side: buy ? "BUY" : "SELL", entryPrice: entry, stopLoss: Math.round((buy ? entry - dist : entry + dist) * 100) / 100, lotSize: 1 + Math.floor(rnd() * 200), confidenceScore: Math.round(rnd() * 100), sourceTrustTier: tiers[Math.floor(rnd() * 4)] ?? "HIGH" });
      const r = computePositionSize(input, cfg);
      expect(SIZING_STATUSES).toContain(r.status);
      expect(computePositionSize(input, cfg)).toEqual(r); // pure and deterministic
      if (r.status !== "SIZED") { expect([r.quantity, r.notional, r.maxLossAmount, r.maxLossPercent]).toEqual([0, 0, 0, 0]); continue; }
      sized++;
      expect(Number.isInteger(r.quantity) && r.quantity >= 1).toBe(true);
      expect(r.maxLossAmount).toBeLessThanOrEqual((r.perTradeCap ?? 0) + 1e-9);
      expect(r.maxLossAmount).toBeLessThanOrEqual((r.tierBudget ?? 0) + 1e-9);
      expect(r.notional).toBeLessThanOrEqual((input.capital ?? 0) + 1e-3);
      expect(r.maxLossAmount).toBeGreaterThanOrEqual(r.quantity * (r.riskPerUnit ?? 0) - 1e-3);
      expect((r.perTradeCap ?? 0)).toBeLessThanOrEqual(((input.capital ?? 0) * HARD_MAX_RISK_PCT) / 100 + 1e-9);
    }
    expect(sized).toBeGreaterThan(200); // the property was exercised on sized outcomes, not only refusals
  });
  it("a tier can only reduce the size: HIGH >= MEDIUM >= LOW", () => {
    const q = (conf: number) => size({ confidenceScore: conf }).quantity;
    expect(q(90)).toBeGreaterThanOrEqual(q(60));
    expect(q(60)).toBeGreaterThanOrEqual(q(20));
  });
});

describe("risk-reward and the snapshot", () => {
  it("reward/risk of the first target; null without a target or when the target is on the loss side", () => {
    expect(size({ targets: [115] }).riskRewardRatio).toBe(3);
    expect(size({ targets: [] }).riskRewardRatio).toBeNull();
    expect(size({ targets: [90] }).riskRewardRatio).toBeNull();
  });
  it("every result carries the complete input/output snapshot, configuration and a stable input hash", () => {
    const r = size();
    expect(r.snapshot).toMatchObject({ engineVersion: "sizing-v1", config: { maxRiskPct: 1 }, input: { capital: 1_000_000, entryPrice: 100, stopLoss: 95, stopLossResult: "VALID" }, output: { status: "SIZED", quantity: 2000 }, inputHash: r.inputHash });
    expect(size().inputHash).toBe(r.inputHash);
    expect(size({ capital: 1_000_001 }).inputHash).not.toBe(r.inputHash);
    expect(size({}, loadSizingConfig({ TWINS_SIZING_MAX_RISK_PCT: "0.9" })).inputHash).not.toBe(r.inputHash);
    expect(size({ context: { riskDecisionId: "x" } }).inputHash).toBe(r.inputHash); // context is echoed, not part of the numeric inputs
  });
});

describe("runtime state is checked before anything is read or written (fail closed)", () => {
  it("kill switch, intake off and an unreadable state refuse without touching the database", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const set of [(s: ReturnType<typeof inMemoryStateSource>) => s.set({ KILL_SWITCH_ACTIVE: true }), (s: ReturnType<typeof inMemoryStateSource>) => s.set({ INTAKE_ENABLED: false }), (s: ReturnType<typeof inMemoryStateSource>) => s.failWith(new Error("down"))]) {
      const source = inMemoryStateSource();
      set(source);
      configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
      await expect(sizeRiskDecision(untouchable, id, { capital: 1_000_000 })).rejects.toMatchObject({ code: "safety_refused" });
    }
    resetRuntimeState();
    await expect(sizeRiskDecision(untouchable, id, { capital: 1_000_000 })).rejects.toMatchObject({ code: "safety_refused" });
  });
  it("no configured capital means nothing is sized (capital_not_configured), also before the database", async () => {
    configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 });
    await expect(sizeRiskDecision(untouchable, "11111111-1111-4111-8111-111111111111", { config: cfg })).rejects.toMatchObject({ code: "capital_not_configured" });
  });
});

describe("architecture: sizing places no orders, calls no broker and writes nothing but risk decisions", () => {
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => (statSync(join(ROOT, dir, n)).isDirectory() ? files(`${dir}/${n}`) : n.endsWith(".ts") ? [`${dir}/${n}`] : []));
  const sizingFiles = files("packages/risk/src/sizing");
  it("the engine and the config import nothing but node:crypto and each other (pure: no database, network, clock or randomness)", () => {
    for (const f of ["packages/risk/src/sizing/engine.ts", "packages/risk/src/sizing/config.ts"]) {
      const code = strip(read(f));
      const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.every((i) => i === "node:crypto" || i === "./config"), f).toBe(true);
      expect(code, f).not.toMatch(/Date\.now|new Date\(|Math\.random|fetch\(|process\.env\.[A-Z]/); // config reads env only through its injectable argument
    }
  });
  it("no sizing code references orders, fills, positions, brokers, Telegram or approval cards", () => {
    for (const f of sizingFiles) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|decisions|claimReviewCards)\b|zerodha|kite|broker|telegram|sendMessage|approval/i);
  });
  it("the only database write path is supersedeRiskDecision (the audited, chained writer)", () => {
    const code = strip(read("packages/risk/src/sizing/record.ts"));
    expect(code).not.toMatch(/\.insert\(|(db|tx)\.update\(|\.delete\(|db\.execute\(/);
    expect(code).toContain("supersedeRiskDecision(");
    expect(read("packages/database/drizzle/0015_risk_decision_sizing.sql")).toMatch(/risk_decisions_sized_review_check[\s\S]*SIZED[\s\S]*NOT VALID/);
  });
});
