import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeConfidence, computePatternStats, deriveFeatures, DEFAULT_CONFIDENCE_CONFIG, DEFAULT_PATTERN_CONFIG, patternKeys, resolveConfidenceConfig, resolvePatternConfig, tierOf, wilsonInterval,
  type FeatureInput, type PatternMetrics, type PatternView, type SignalForConfidence, type Tier,
} from "../../../packages/historical/src/index";
import type { ScoredSignal } from "../../../packages/historical/src/scorecards/metrics";

// 2024-03-04 is a Monday; 04:00Z = 09:30 IST
const AT = new Date("2024-03-04T04:00:00Z");
const base = (o: Partial<FeatureInput> = {}): FeatureInput => ({ market: "NSE", instrumentType: "equity", underlying: "acme", optionType: null, side: "buy", entry: { type: "at", price: 100 }, stopLoss: 95, targets: [105, 110, 115], expiryDate: null, timestamp: AT, ...o });

describe("feature derivation (deterministic, closed value sets)", () => {
  it("derives every feature for a plain equity signal", () => {
    expect(deriveFeatures(base())).toEqual({ market: "NSE", instrumentType: "EQUITY", underlying: "ACME", optionType: "NA", side: "BUY", timeOfDay: "OPENING", dayOfWeek: "MON", expiryProximity: "NA", entryType: "level", stopDistance: "5_10PCT", rewardRisk: "1_2", targetStructure: "T1_T2_T3" });
  });
  it.each([
    ["04:00Z = 09:30 IST", "2024-03-04T04:00:00Z", "OPENING"], ["03:30Z = 09:00 IST", "2024-03-04T03:30:00Z", "PRE_MARKET"], ["05:00Z = 10:30 IST", "2024-03-04T05:00:00Z", "MIDDAY"],
    ["08:30Z = 14:00 IST", "2024-03-04T08:30:00Z", "CLOSING"], ["10:00Z = 15:30 IST", "2024-03-04T10:00:00Z", "AFTER_HOURS"], ["18:30Z crosses local midnight", "2024-03-04T18:30:00Z", "PRE_MARKET"],
  ])("time-of-day bucket: %s", (_n, iso, bucket) => { expect(deriveFeatures(base({ timestamp: new Date(iso) })).timeOfDay).toBe(bucket); });
  it("day of week is taken in the market's local time", () => {
    expect(deriveFeatures(base({ timestamp: new Date("2024-03-04T20:00:00Z") })).dayOfWeek).toBe("TUE"); // 01:30 IST next day
    expect(deriveFeatures(base({ timestamp: new Date("2024-03-09T04:00:00Z") })).dayOfWeek).toBe("SAT");
  });
  it("an unknown market has no guessed timezone", () => {
    const f = deriveFeatures(base({ market: "NYSE" }));
    expect([f.timeOfDay, f.dayOfWeek]).toEqual(["UNKNOWN_TZ", "UNKNOWN_TZ"]);
    expect(deriveFeatures(base({ market: null })).market).toBe("UNKNOWN");
  });
  it.each([
    ["same day", "2024-03-04", "SAME_DAY"], ["tomorrow", "2024-03-05", "D1_2"], ["two days", "2024-03-06", "D1_2"], ["three days", "2024-03-07", "D3_7"], ["a week", "2024-03-11", "D3_7"],
    ["8 days", "2024-03-12", "D8_30"], ["30 days", "2024-04-03", "D8_30"], ["31 days", "2024-04-04", "GT_30"], ["in the past", "2024-03-01", "EXPIRED"],
  ])("expiry proximity (option): %s", (_n, expiry, bucket) => { expect(deriveFeatures(base({ instrumentType: "option", optionType: "CE", expiryDate: expiry })).expiryProximity).toBe(bucket); });
  it("expiry proximity: an option without a full date is UNSTATED, an equity is NA, and option type only applies to options", () => {
    expect(deriveFeatures(base({ instrumentType: "option", optionType: "PE", expiryDate: null }))).toMatchObject({ expiryProximity: "UNSTATED", optionType: "PE" });
    expect(deriveFeatures(base({ expiryDate: "2024-03-05" }))).toMatchObject({ expiryProximity: "NA", optionType: "NA" });
  });
  it.each([
    ["buy above", "buy", { type: "above", price: 100 }, "breakout"], ["sell below", "sell", { type: "below", price: 100 }, "breakout"], ["buy below", "buy", { type: "below", price: 100 }, "pullback"],
    ["sell above", "sell", { type: "above", price: 100 }, "pullback"], ["at", "buy", { type: "at", price: 100 }, "level"], ["range", "buy", { type: "range", low: 99, high: 101 }, "level"],
    ["market", "buy", { type: "market" }, "unspecified"], ["unspecified", "buy", { type: "unspecified" }, "unspecified"], ["above, no side", null, { type: "above", price: 100 }, "unspecified"],
  ])("entry type: %s", (_n, side, entry, bucket) => { expect(deriveFeatures(base({ side, entry })).entryType).toBe(bucket); });
  it.each([
    ["0.5%", 99.5, "LT_1PCT"], ["1.5%", 98.5, "1_2PCT"], ["3%", 97, "2_5PCT"], ["7%", 93, "5_10PCT"], ["12%", 88, "GTE_10PCT"], ["wrong side", 101, "INVALID"], ["missing", null, "UNKNOWN"],
  ])("stop distance (buy at 100): %s", (_n, stop, bucket) => { expect(deriveFeatures(base({ stopLoss: stop, targets: [] })).stopDistance).toBe(bucket); });
  it.each([
    ["0.5R", 102.5, "LT_1"], ["1.5R", 107.5, "1_2"], ["2.5R", 112.5, "2_3"], ["4R", 120, "GTE_3"], ["wrong side", 99, "INVALID"],
  ])("reward-to-risk (stop 95): %s", (_n, t1, bucket) => { expect(deriveFeatures(base({ targets: [t1] })).rewardRisk).toBe(bucket); });
  it("short signals mirror the geometry, ranges use the midpoint, a market entry has no reference price", () => {
    expect(deriveFeatures(base({ side: "sell", stopLoss: 105, targets: [90] }))).toMatchObject({ stopDistance: "5_10PCT", rewardRisk: "2_3" });
    expect(deriveFeatures(base({ entry: { type: "range", low: 98, high: 102 } })).stopDistance).toBe("5_10PCT");
    expect(deriveFeatures(base({ entry: { type: "market" } }))).toMatchObject({ stopDistance: "UNKNOWN", rewardRisk: "UNKNOWN" });
  });
  it.each([[[], "NONE"], [[1], "T1"], [[1, 2], "T1_T2"], [[1, 2, 3], "T1_T2_T3"], [[1, 2, 3, 4], "T1_T2_T3"]])("target structure %j", (t, s) => { expect(deriveFeatures(base({ targets: t as number[] })).targetStructure).toBe(s); });
});

describe("pattern keys (levels 1-4)", () => {
  it("builds the four deterministic keys with the specified features", () => {
    const k = patternKeys(deriveFeatures(base()));
    expect(k.map((x) => x.keyText)).toEqual([
      "L1|market=NSE|instrumentType=EQUITY|side=BUY",
      "L2|market=NSE|instrumentType=EQUITY|side=BUY|underlying=ACME",
      "L3|market=NSE|instrumentType=EQUITY|side=BUY|underlying=ACME|timeOfDay=OPENING|expiryProximity=NA",
      "L4|market=NSE|instrumentType=EQUITY|side=BUY|underlying=ACME|timeOfDay=OPENING|expiryProximity=NA|stopDistance=5_10PCT|rewardRisk=1_2",
    ]);
    expect(k.map((x) => x.level)).toEqual([1, 2, 3, 4]);
    expect(k[3]?.features).toMatchObject({ stopDistance: "5_10PCT", rewardRisk: "1_2" });
  });
  it("is deterministic, and signals that differ in one level feature share only the shallower keys", () => {
    const a = patternKeys(deriveFeatures(base())), b = patternKeys(deriveFeatures(base({ stopLoss: 90 })));
    expect(JSON.stringify(a)).toBe(JSON.stringify(patternKeys(deriveFeatures(base()))));
    expect(a.slice(0, 3).map((x) => x.keyText)).toEqual(b.slice(0, 3).map((x) => x.keyText));
    expect(a[3]?.keyText).not.toBe(b[3]?.keyText);
    expect(patternKeys(deriveFeatures(base({ underlying: "other" })))[0]?.keyText).toBe(a[0]?.keyText);
    expect(patternKeys(deriveFeatures(base({ side: "sell", stopLoss: 105, targets: [90] })))[0]?.keyText).not.toBe(a[0]?.keyText);
  });
  it("uses no free text: only closed-vocabulary feature values appear in a key", () => {
    for (const k of patternKeys(deriveFeatures(base({ underlying: "x y\nz" })))) expect(k.keyText.split("\n")).toHaveLength(k.level >= 2 ? 2 : 1); // (an unusual underlying is the one open-vocabulary field; it is a parsed symbol, not message text)
  });
});

describe("Wilson score interval", () => {
  it.each([
    [0, 10, 1.96, 0, 0.277534], [10, 10, 1.96, 0.722466, 1], [5, 10, 1.96, 0.236593, 0.763407], [60, 100, 1.96, 0.502, 0.69], [1, 1, 1.96, 0.206543, 1],
  ])("%i of %i at z=%f", (k, n, z, lo, hi) => {
    const w = wilsonInterval(k, n, z);
    expect(w?.lower).toBeCloseTo(lo, 2);
    expect(w?.upper).toBeCloseTo(hi, 2);
  });
  it("stays inside [0,1], widens as n shrinks, and is undefined without trials", () => {
    expect(wilsonInterval(0, 0, 1.96)).toBeNull();
    expect(wilsonInterval(3, 2, 1.96)).toBeNull();
    const small = wilsonInterval(6, 10, 1.96) as { lower: number; upper: number }, big = wilsonInterval(600, 1000, 1.96) as { lower: number; upper: number };
    expect(small.upper - small.lower).toBeGreaterThan(big.upper - big.lower);
    for (const [k, n] of [[0, 1], [1, 1], [7, 9]] as const) { const w = wilsonInterval(k, n, 1.96) as { lower: number; upper: number }; expect(w.lower).toBeGreaterThanOrEqual(0); expect(w.upper).toBeLessThanOrEqual(1); }
  });
});

const T0 = Date.parse("2024-01-01T00:00:00Z");
const sigs = (outcomes: string[]): ScoredSignal[] => outcomes.map((o, i) => ({
  key: `c|${i}`, at: new Date(T0 + i * 86_400_000), isSignal: true, outcome: o, targetHits: o === "WIN_T2" ? [true, true, false] : o === "WIN_T1" ? [true, false, false] : [false, false, false], dataQuality: "GOOD", slPresent: true, slValid: true, revisions: 0, adverseSlRevision: false, evidenceConflict: false,
}));
const rep = (o: string, n: number): string[] => Array.from({ length: n }, () => o);

describe("pattern statistics and sample-size honesty", () => {
  it.each([
    ["29 evaluable outcomes", [...rep("WIN_T2", 15), ...rep("LOSS_SL", 14)], "INSUFFICIENT_EVIDENCE", "SAMPLE_BELOW_MINIMUM"],
    ["30 evaluable outcomes", [...rep("WIN_T2", 15), ...rep("LOSS_SL", 15)], "SUFFICIENT", null],
    ["unverifiable 41% (30 evaluable)", [...rep("WIN_T2", 15), ...rep("LOSS_SL", 15), ...rep("UNVERIFIABLE", 21)], "LOW_QUALITY_EVIDENCE", "HIGH_UNVERIFIABLE_SHARE"],
    ["unverifiable exactly 40%", [...rep("WIN_T2", 15), ...rep("LOSS_SL", 15), ...rep("UNVERIFIABLE", 20)], "SUFFICIENT", null],
    ["small and unverifiable: insufficient wins the label", [...rep("WIN_T2", 5), ...rep("UNVERIFIABLE", 20)], "INSUFFICIENT_EVIDENCE", "HIGH_UNVERIFIABLE_SHARE"],
  ])("%s", (_n, o, status, flag) => {
    const st = computePatternStats(sigs(o), DEFAULT_PATTERN_CONFIG);
    expect(st.status).toBe(status);
    if (flag) expect(st.flags).toContain(flag);
    expect(st.flags).toContain("HISTORICAL_ASSOCIATION_ONLY");
  });
  it("computes the required metrics, the Wilson interval, a conservative expectancy bound and first / last observed dates", () => {
    const st = computePatternStats(sigs([...rep("WIN_T2", 36), ...rep("LOSS_SL", 24)]), DEFAULT_PATTERN_CONFIG);
    expect(st.metrics).toMatchObject({ wins: 36, losses: 24, winRateEntered: 0.6, grossExpectancyR: 0.8, netExpectancyR: 0.75, maxConsecutiveLosses: 24, profitFactor: 3 });
    expect(st.metrics.winRateEnteredWilsonLower).toBeCloseTo(0.4737, 3);
    expect(st.metrics.winRateEnteredWilsonUpper).toBeGreaterThan(0.7);
    expect(st.metrics.winRateEnteredWilsonUpper).toBeLessThan(0.73);
    expect(st.metrics.netExpectancyLowerBoundR).toBeLessThan(st.metrics.netExpectancyR as number);
    expect(st.metrics.netExpectancyLowerBoundR).toBeGreaterThan(0.3);
    expect(st.firstObserved).toEqual(new Date(T0));
    expect(st.lastObserved).toEqual(new Date(T0 + 59 * 86_400_000));
  });
  it("expectancy and drawdown follow the fixed R model in time order", () => {
    const st = computePatternStats(sigs(["WIN_T3", "LOSS_SL", "LOSS_SL", "WIN_T1", "NO_ENTRY"]), { ...DEFAULT_PATTERN_CONFIG, costPerTradeR: 0 });
    expect(st.metrics).toMatchObject({ grossExpectancyR: 0.4, maxDrawdownR: 2, maxConsecutiveLosses: 2, evaluable: 5, noEntryRate: 0.2 });
  });
  it("an empty pattern has null bounds, never NaN", () => {
    const st = computePatternStats([], DEFAULT_PATTERN_CONFIG);
    expect(st.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(JSON.stringify(st.metrics)).not.toMatch(/NaN|Infinity/);
    expect(st.metrics.winRateEnteredWilsonLower).toBeNull();
  });
  it("validates configuration", () => {
    expect(() => resolvePatternConfig({ minSample: 0 })).toThrow();
    expect(() => resolvePatternConfig({ wilsonZ: 9 })).toThrow();
    expect(() => resolvePatternConfig({ embargoDays: -1 })).toThrow();
    expect(resolvePatternConfig({ minSample: 10 }).minSample).toBe(10);
  });
});

// ── confidence ──
const fixture = (n: number, wins: number, over: Partial<PatternMetrics> = {}): { metrics: PatternMetrics; n: number } => {
  const st = computePatternStats(sigs([...rep("WIN_T2", wins), ...rep("LOSS_SL", n - wins)]), DEFAULT_PATTERN_CONFIG);
  return { metrics: { ...st.metrics, ...over }, n: st.sampleSize };
};
const sig = (o: Partial<SignalForConfidence> = {}): SignalForConfidence => ({ ...base(), stopLossValid: true, dataQuality: "GOOD", ...o });
const keysOf = (s: SignalForConfidence) => patternKeys(deriveFeatures(s));
const view = (level: number, f: { metrics: PatternMetrics; n: number }, status: PatternView["status"] = "SUFFICIENT"): PatternView => ({ patternId: `p${level}`, snapshotId: `s${level}`, keyText: keysOf(sig())[level - 1]?.keyText as string, level, status, sampleSize: f.n, metrics: f.metrics });
const lib = (...v: PatternView[]) => (k: string): PatternView | undefined => v.find((x) => x.keyText === k);
const est = (v: PatternView[], trust: Tier = "A", s = sig(), ctx = { available: true }, cfg = DEFAULT_CONFIDENCE_CONFIG) => computeConfidence(s, trust, ctx, lib(...v), cfg);
const strong = fixture(200, 140); // 70% over 200: Wilson lower ~0.63

describe("confidence score and tier mapping", () => {
  it.each([[0, "UNKNOWN"], [1, "LOW"], [39, "LOW"], [40, "MEDIUM"], [64, "MEDIUM"], [65, "HIGH"], [100, "HIGH"]])("score %i -> %s", (score, tier) => { expect(tierOf(score, DEFAULT_CONFIDENCE_CONFIG)).toBe(tier); });
  it("a strong, well-sampled pattern with a trusted source and full context reaches HIGH, deterministically", () => {
    const e = est([view(4, fixture(300, 240))]);
    expect(e).toMatchObject({ tier: "HIGH", evidenceQuality: "SUFFICIENT", sampleSize: 300, primaryPatternKey: keysOf(sig())[3]?.keyText });
    expect(e.score).toBeGreaterThanOrEqual(65);
    expect(JSON.stringify(est([view(4, fixture(300, 240))]))).toBe(JSON.stringify(e));
    expect(e.limitations).toEqual(expect.arrayContaining(["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM", "EXACT_FEATURE_MATCH_ONLY"]));
    expect(e.explanation.map((x) => x.rule)).toEqual(expect.arrayContaining(["PRIMARY_PATTERN", "WIN_RATE_WILSON_LOWER_BOUND", "SCORE"]));
  });
  it("the score is 100 x Wilson lower bound x quality factors (checked against the formula)", () => {
    const f = fixture(100, 70);
    const lower = wilsonInterval(f.metrics.wins, f.metrics.entered, 1.96)?.lower as number;
    const e = est([view(1, f)], "A", sig({ dataQuality: "DEGRADED" }));
    expect(e.score).toBe(Math.round(100 * lower * 0.85));
  });
  it("uses the deepest pattern with evidence and records every matching pattern as a reference", () => {
    const e = est([view(1, strong), view(2, strong), view(3, fixture(12, 9), "INSUFFICIENT_EVIDENCE")]);
    expect(e.primaryPatternKey).toBe(keysOf(sig())[1]?.keyText);
    expect(e.patternRefs.map((r) => [r.level, r.status])).toEqual([[1, "SUFFICIENT"], [2, "SUFFICIENT"], [3, "INSUFFICIENT_EVIDENCE"]]);
    expect(e.limitations).toContain("DEEPER_LEVELS_INSUFFICIENT_OR_ABSENT");
  });
  it("never borrows from a different feature combination: no exact key => UNKNOWN", () => {
    const e = computeConfidence(sig(), "A", { available: true }, () => undefined, DEFAULT_CONFIDENCE_CONFIG);
    expect(e).toMatchObject({ score: 0, tier: "UNKNOWN", evidenceQuality: "NO_MATCH", primaryPatternKey: null });
    expect(e.explanation[0]?.rule).toBe("NO_MATCHING_PATTERN");
  });
  it("insufficient sample => UNKNOWN by default; CAP_LOW uses the pattern but caps it at LOW", () => {
    const small = fixture(20, 18);
    const e = est([view(1, small, "INSUFFICIENT_EVIDENCE")]);
    expect(e).toMatchObject({ score: 0, tier: "UNKNOWN", evidenceQuality: "INSUFFICIENT_EVIDENCE" });
    expect(e.explanation[0]?.rule).toBe("INSUFFICIENT_SAMPLE");
    const capped = est([view(1, small, "INSUFFICIENT_EVIDENCE")], "A", sig(), { available: true }, resolveConfidenceConfig({ insufficientSample: "CAP_LOW" }));
    expect(capped.tier).toBe("LOW");
    expect(capped.score).toBeLessThanOrEqual(39);
    expect(capped.evidenceQuality).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("caps", () => {
  const f = fixture(300, 240);
  it.each<[Tier, string]>([["A", "HIGH"], ["B", "HIGH"], ["C", "MEDIUM"], ["D", "LOW"], ["UNKNOWN", "LOW"]])("source trust %s caps confidence at %s", (trust, expected) => {
    const e = est([view(4, f)], trust);
    expect(e.tier).toBe(expected);
    if (expected === "MEDIUM") expect(e.score).toBeLessThanOrEqual(64);
    if (expected === "LOW") expect(e.score).toBeLessThanOrEqual(39);
    if (trust !== "A" && trust !== "B") expect(e.explanation.map((x) => x.rule)).toContain("SOURCE_TRUST_CAP");
  });
  it("an unverifiable share above the limit caps at LOW (and the pattern is LOW_QUALITY_EVIDENCE)", () => {
    const e = est([view(4, fixture(300, 240, { unverifiableRate: 0.45 }), "LOW_QUALITY_EVIDENCE")]);
    expect(e.tier).toBe("LOW");
    expect(e.evidenceQuality).toBe("LOW_QUALITY_EVIDENCE");
    expect(e.explanation.map((x) => x.rule)).toEqual(expect.arrayContaining(["UNVERIFIABLE_RATE_CAP", "LOW_QUALITY_EVIDENCE_CAP"]));
    expect(est([view(4, fixture(300, 240, { unverifiableRate: 0.4 }))]).explanation.map((x) => x.rule)).not.toContain("UNVERIFIABLE_RATE_CAP");
  });
  it("non-positive expectancy and an invalid stop-loss cap at LOW", () => {
    expect(est([view(4, fixture(300, 240, { netExpectancyR: -0.1 }))]).tier).toBe("LOW");
    const e = est([view(4, f)], "A", sig({ stopLossValid: false }));
    expect(e.tier).toBe("LOW");
    expect(e.explanation.map((x) => x.rule)).toEqual(expect.arrayContaining(["INVALID_STOP_LOSS_FACTOR", "INVALID_STOP_LOSS_CAP"]));
  });
  it("missing market context, degraded data and conflicting evidence each lower the score and are explained", () => {
    const clean = est([view(4, f)]);
    const noCtx = est([view(4, f)], "A", sig(), { available: false });
    expect(noCtx.score).toBeLessThan(clean.score);
    expect(noCtx.limitations).toContain("MARKET_CONTEXT_UNAVAILABLE");
    expect(est([view(4, f)], "A", sig({ dataQuality: "INSUFFICIENT" })).score).toBeLessThan(clean.score);
    const opposite = fixture(300, 80, { netExpectancyR: -0.4 }); // a shallower level that disagrees on the sign of expectancy
    const conflicted = est([view(2, opposite), view(4, f)]);
    expect(conflicted.score).toBeLessThan(clean.score);
    expect(conflicted.explanation.map((x) => x.rule)).toContain("CONFLICTING_EVIDENCE");
  });
  it("the caps and bands are configurable, and the configuration is validated", () => {
    const cfg = resolveConfidenceConfig({ trustCaps: { C: "LOW" }, mediumMin: 30, highMin: 50 });
    expect(est([view(4, f)], "C", sig(), { available: true }, cfg).tier).toBe("LOW");
    expect(tierOf(35, cfg)).toBe("MEDIUM");
    expect(() => resolveConfidenceConfig({ mediumMin: 70, highMin: 65 })).toThrow();
    expect(() => resolveConfidenceConfig({ factors: { conflict: 2 } })).toThrow();
    expect(() => resolveConfidenceConfig({ insufficientSample: "GUESS" as never })).toThrow();
  });
  it("is table-driven deterministic: every combination of trust x context x quality repeats exactly", () => {
    for (const trust of ["A", "B", "C", "D", "UNKNOWN"] as Tier[]) for (const available of [true, false]) for (const dq of ["GOOD", "DEGRADED", "INSUFFICIENT", "UNKNOWN"] as const) {
      const a = est([view(4, f)], trust, sig({ dataQuality: dq }), { available }), b = est([view(4, f)], trust, sig({ dataQuality: dq }), { available });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.score).toBeGreaterThanOrEqual(1);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });
});

describe("architecture: the pattern code is research-only and local", () => {
  const ROOT = join(__dirname, "../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));
  const files = [...walk("packages/historical/src/patterns"), "scripts/ops/historical-patterns.ts"];
  it("imports no risk / broker / execution / approval / Telegram code, no LLM client, no network, no clock or randomness in the model, and reads no message text", () => {
    for (const f of files) {
      const t = strip(readFileSync(join(ROOT, f), "utf8"));
      expect(t, f).not.toMatch(/@twins\/(risk|execution|broker|approval|adapter)|packages\/(risk|execution|broker)|adapters\/|approval-bot|api\.telegram|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|llm/i);
      expect(t, f).not.toMatch(/rawText|raw_text/);
      if (f.startsWith("packages/")) expect(t, f).not.toMatch(/console\./);
    }
    for (const f of ["features.ts", "stats.ts", "confidence.ts"]) expect(strip(readFileSync(join(ROOT, "packages/historical/src/patterns", f), "utf8")), f).not.toMatch(/Math\.random|Date\.now|new Date\(\)|randomUUID/);
  });
  it("writes only the five pattern / confidence tables and never updates or deletes", () => {
    for (const f of files) {
      const t = strip(readFileSync(join(ROOT, f), "utf8"));
      for (const m of t.matchAll(/\b(?:db|tx)\.(insert|update|delete)\(\s*(?:schema\.)?(\w+)/g)) expect(m[2], f).toMatch(/^(D|PR|PS|CR|CE|historicalPattern\w+|historicalConfidence\w+)$/);
      expect(t, f).not.toMatch(/\b(?:db|tx)\.(update|delete)\(/);
    }
  });
  it("reaches the live risk flow only through the Task 5 source-intelligence integration; the Task 4 service function itself is still not called by any runtime code", () => {
    // Stage 4 / Task 5 connects source intelligence to the risk flow through exactly these files (the risk recorder, the read-only API routes, the worker via @twins/risk); nothing else imports it
    const allowed = new Set(["apps/api/src/intelligenceApi.ts", "packages/risk/src/intelligence/record.ts"]);
    for (const d of ["apps", "services", "adapters", "packages/risk/src"]) for (const f of walk(d)) {
      const t = readFileSync(join(ROOT, f), "utf8");
      expect(t, f).not.toMatch(/estimateSignalConfidence|patterns\//);
      if (!allowed.has(f)) expect(t, f).not.toMatch(/@twins\/historical|packages\/historical/);
    }
  });
});
