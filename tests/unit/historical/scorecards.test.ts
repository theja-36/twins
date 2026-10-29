import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assignTier, computeMetrics, computeWindows, DEFAULT_TIER_CONFIG, resolveTierConfig, type Metrics, type ScoredSignal } from "../../../packages/historical/src/scorecards/index";

const T0 = Date.parse("2024-01-01T00:00:00Z");
const DAY = 86_400_000;
const HITS: Record<string, [boolean, boolean, boolean]> = { WIN_T1: [true, false, false], WIN_T2: [true, true, false], WIN_T3: [true, true, true] };
/** SYNTHETIC outcome fixtures: one signal per day from 2024-01-01, in the order given. */
const sigs = (outcomes: string[], over: Partial<ScoredSignal> | ((i: number) => Partial<ScoredSignal>) = {}): ScoredSignal[] =>
  outcomes.map((o, i) => ({
    key: `ch|${i}`, at: new Date(T0 + i * DAY), isSignal: true, outcome: o, targetHits: HITS[o] ?? [false, false, false], dataQuality: "GOOD", slPresent: true, slValid: true, revisions: 0, adverseSlRevision: false, evidenceConflict: false,
    ...(typeof over === "function" ? over(i) : over),
  }));
const rep = (o: string, n: number): string[] => Array.from({ length: n }, () => o);
const cfg = { costPerTradeR: 0 };
const M = (o: string[], c = cfg): Metrics => computeMetrics(sigs(o), c);

describe("metric calculations (fixed R model)", () => {
  it("counts, rates and gross expectancy: WIN_T1 +1R, T2 +2R, T3 +3R, LOSS -1R, no entry / expired 0R", () => {
    const m = M(["WIN_T1", "WIN_T2", "WIN_T3", "LOSS_SL", "LOSS_SL", "NO_ENTRY", "EXPIRED_NO_ENTRY", "EXPIRED_AFTER_ENTRY", "UNVERIFIABLE", "INVALID_SIGNAL"]);
    expect(m).toMatchObject({ normalizedSignals: 10, totalEvaluated: 10, evaluable: 8, entered: 6, wins: 3, losses: 2, noEntry: 2, expiredAfterEntry: 1, unverifiable: 1, invalid: 1, totalR: 4 });
    expect(m).toMatchObject({ winRate: 0.3, lossRate: 0.2, noEntryRate: 0.2, expiredAfterEntryRate: 0.1, unverifiableRate: 0.1, invalidRate: 0.1, winRateEntered: 0.5, slHitRate: 0.333333 });
    expect(m.grossExpectancyR).toBe(0.5); // 4R over 8 evaluable outcomes
    expect(m.entryReachabilityRate).toBe(0.75);
  });
  it("net expectancy subtracts the configured per-trade cost from every ENTERED trade only", () => {
    const o = ["WIN_T1", "LOSS_SL", "NO_ENTRY", "NO_ENTRY"];
    expect(M(o).netExpectancyR).toBe(0);
    expect(M(o, { costPerTradeR: 0.1 }).netExpectancyR).toBe(-0.05); // (0 - 0.1 x 2 entered) / 4
  });
  it("profit factor = winner R / loser R, undefined (null) without losses, 0 without wins", () => {
    expect(M(["WIN_T2", "WIN_T1", "LOSS_SL"]).profitFactor).toBe(3);
    expect(M(["WIN_T2", "NO_ENTRY"]).profitFactor).toBeNull();
    expect(M(["LOSS_SL", "LOSS_SL"]).profitFactor).toBe(0);
  });
  it("average winner / loser R", () => {
    const m = M(["WIN_T1", "WIN_T3", "LOSS_SL", "LOSS_SL"]);
    expect([m.averageWinnerR, m.averageLoserR]).toEqual([2, -1]);
    expect(M(["NO_ENTRY"])).toMatchObject({ averageWinnerR: null, averageLoserR: null });
  });
  it("maximum consecutive losses ignores no-entry signals and is reset by any other entered trade", () => {
    expect(M(["LOSS_SL", "LOSS_SL", "NO_ENTRY", "LOSS_SL", "WIN_T1", "LOSS_SL"]).maxConsecutiveLosses).toBe(3);
    expect(M(["LOSS_SL", "EXPIRED_AFTER_ENTRY", "LOSS_SL"]).maxConsecutiveLosses).toBe(1);
  });
  it("maximum drawdown in R is the largest peak-to-trough fall of the cumulative R in time order", () => {
    expect(M(["WIN_T3", "LOSS_SL", "LOSS_SL", "WIN_T1", "LOSS_SL"]).maxDrawdownR).toBe(2); // 3 -> 2 -> 1 (dd 2), 2, 1
    expect(M(["LOSS_SL", "LOSS_SL", "WIN_T1"]).maxDrawdownR).toBe(2);
    expect(M(["WIN_T1", "WIN_T1"]).maxDrawdownR).toBe(0);
    // time order, not input order
    const shuffled = sigs(["WIN_T3", "LOSS_SL", "LOSS_SL"]).reverse();
    expect(computeMetrics(shuffled, cfg).maxDrawdownR).toBe(2);
  });
  it("T1 / T2 / T3 hit rates and the stop-loss hit rate are over entered trades", () => {
    const m = M(["WIN_T3", "WIN_T2", "WIN_T1", "LOSS_SL", "NO_ENTRY"]);
    expect([m.t1HitRate, m.t2HitRate, m.t3HitRate, m.slHitRate]).toEqual([0.75, 0.5, 0.25, 0.25]);
  });
  it("an empty or unevaluated source has null rates, never NaN", () => {
    const m = computeMetrics([], cfg);
    expect(m).toMatchObject({ evaluable: 0, winRate: null, grossExpectancyR: null, netExpectancyR: null, profitFactor: null, dataQualityScore: null, evaluationCoverageScore: null });
    expect(JSON.stringify(m)).not.toMatch(/NaN|Infinity/);
  });
});

describe("behavioural quality metrics (neutral, evidence only)", () => {
  it("SL discipline, revision frequency, edited share, conflict rate and hindsight score", () => {
    const m = computeMetrics(sigs(rep("WIN_T1", 10), (i) => ({ slPresent: i !== 0, slValid: i !== 1, revisions: i < 4 ? 2 : 0, adverseSlRevision: i === 2, evidenceConflict: i === 3 })), cfg);
    expect(m.slDisciplineRate).toBe(0.7); // missing (0), invalid (1), adversely revised (2)
    expect(m).toMatchObject({ revisionFrequency: 0.8, editedMessageRate: 0.4, adverseSlRevisionCount: 1, evidenceConflictCount: 1, revisionConflictRate: 0.2, hindsightSuspicionScore: 0.1 });
    expect(m.deleteRate).toBeNull(); // deletions are not in the import contract
    expect(m.lateSignalRate).toBeNull(); // not measurable from the evidence
  });
  it("data-quality score weights GOOD 1, DEGRADED 0.5, INSUFFICIENT 0 (not-applicable labels are skipped); coverage = evaluated / signals", () => {
    const s = sigs(["WIN_T1", "WIN_T1", "WIN_T1", "WIN_T1", "INVALID_SIGNAL"]);
    s[1]!.dataQuality = "DEGRADED"; s[2]!.dataQuality = "INSUFFICIENT"; s[4]!.dataQuality = "NOT_APPLICABLE";
    s.push({ ...s[0]!, key: "ch|x", outcome: null, dataQuality: null });
    const m = computeMetrics(s, cfg);
    expect(m.dataQualityScore).toBe(0.625); // (1 + .5 + 0 + 1) / 4
    expect(m.evaluationCoverageScore).toBe(0.833333);
  });
  it("non-signal messages count as imported messages only", () => {
    const s = sigs(["WIN_T1"]);
    s.push({ ...s[0]!, key: "ch|noise", isSignal: false, outcome: null });
    expect(computeMetrics(s, cfg)).toMatchObject({ importedMessages: 2, normalizedSignals: 1, totalEvaluated: 1 });
  });
});

describe("time-window scorecards", () => {
  const asOf = new Date(T0 + 99 * DAY);
  const s = sigs(rep("WIN_T1", 100)); // days 0..99
  it("all-time, trailing 30 / 90 / 180 / 365 days and one card per calendar month, each with window bounds, sample size and caveats", () => {
    const w = computeWindows(s, asOf, cfg);
    const by = Object.fromEntries(w.filter((x) => x.windowType !== "CALENDAR_MONTH").map((x) => [x.windowType, x]));
    expect(Object.keys(by)).toEqual(["ALL_TIME", "LAST_30D", "LAST_90D", "LAST_180D", "LAST_365D"]);
    expect(by["ALL_TIME"]?.sampleSize).toBe(100);
    expect(by["LAST_30D"]?.sampleSize).toBe(30); // days 70..99: strictly after asOf - 30d
    expect(by["LAST_90D"]?.sampleSize).toBe(90);
    expect(by["LAST_365D"]?.sampleSize).toBe(100);
    expect(by["LAST_30D"]?.windowEnd).toEqual(asOf);
        const months = w.filter((x) => x.windowType === "CALENDAR_MONTH");
    expect(months.map((m) => m.windowStart.toISOString().slice(0, 7))).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(months.map((m) => m.sampleSize)).toEqual([31, 29, 31, 9]);
    expect(months[3]?.caveats.map((c) => c.code)).toContain("SMALL_SAMPLE");
    expect(months[3]?.windowEnd).toEqual(asOf); // the running month ends at the as-of instant
  });
  it("ignores messages after the as-of instant", () => {
    const w = computeWindows(s, new Date(T0 + 9 * DAY), cfg);
    expect(w[0]?.sampleSize).toBe(10);
  });
  it("is deterministic and carries no market-regime windows", () => {
    expect(JSON.stringify(computeWindows(s, asOf, cfg))).toBe(JSON.stringify(computeWindows([...s].reverse(), asOf, cfg)));
    expect(computeWindows(s, asOf, cfg).map((x) => x.windowType).join()).not.toMatch(/REGIME|TREND|RANGE|VOLATIL/);
  });
});

describe("trust tiers", () => {
  const good = (n: number, over: Partial<ScoredSignal> | ((i: number) => Partial<ScoredSignal>) = {}): Metrics =>
    computeMetrics(sigs([...rep("WIN_T2", Math.ceil(n * 0.6)), ...rep("LOSS_SL", n - Math.ceil(n * 0.6))], over), { costPerTradeR: DEFAULT_TIER_CONFIG.costPerTradeR });
  const tier = (m: Metrics, over = {}) => assignTier(m, resolveTierConfig(over));
  const rules = (m: Metrics, over = {}) => tier(m, over).rules.map((r) => r.rule);

  it("fewer evaluable outcomes than the minimum is UNKNOWN, whatever the results", () => {
    expect(tier(good(29)).tier).toBe("UNKNOWN");
    expect(tier(computeMetrics(sigs(rep("WIN_T3", 29)), cfg)).tier).toBe("UNKNOWN");
    expect(tier(computeMetrics([], cfg))).toMatchObject({ tier: "UNKNOWN", label: "INSUFFICIENT_EVIDENCE" });
    expect(rules(good(29))).toEqual(["INSUFFICIENT_EVALUABLE_OUTCOMES"]);
  });
  it("A needs 50 evaluable outcomes, positive net expectancy, win rate >= 45%, unverifiable < 20% and low conflict; 30-49 outcomes is B", () => {
    expect(tier(good(60))).toMatchObject({ tier: "A", label: "HIGH_TRUST" });
    expect(tier(good(40))).toMatchObject({ tier: "B", label: "MODERATE_TRUST" });
    expect(rules(good(40))).toContain("A_MIN_EVALUABLE");
  });
  it("negative net expectancy is D and can never be A", () => {
    const m = computeMetrics(sigs([...rep("WIN_T1", 10), ...rep("LOSS_SL", 40)]), { costPerTradeR: 0.05 });
    expect(m.netExpectancyR).toBeLessThan(0);
    expect(tier(m)).toMatchObject({ tier: "D", label: "UNTRUSTED" });
    expect(rules(m)).toContain("NEGATIVE_NET_EXPECTANCY");
    const thin = computeMetrics(sigs([...rep("WIN_T1", 26), ...rep("LOSS_SL", 24)]), { costPerTradeR: 0.1 }); // gross +2R, net negative after costs
    expect(thin.grossExpectancyR).toBeGreaterThan(0);
    expect(tier(thin).tier).toBe("D");
  });
  it("a source with more than 40% unverifiable outcomes is never A, even with a permissive configuration (hard guardrail)", () => {
    const s = [...sigs(rep("WIN_T3", 60)), ...sigs(rep("UNVERIFIABLE", 45)).map((x, i) => ({ ...x, key: `u|${i}` }))];
    const m = computeMetrics(s, cfg);
    expect(m.unverifiableRate).toBeGreaterThan(0.4);
    const permissive = { a: { maxUnverifiableRate: 1 }, b: { maxUnverifiableRate: 1 } };
    expect(tier(m, permissive).tier).not.toBe("A");
    expect(rules(m, permissive)).toContain("GUARDRAIL_A_REQUIREMENTS");
  });
  it("20-35% unverifiable blocks A and B (C), under 20% allows A", () => {
    const withUnv = (u: number) => computeMetrics([...sigs([...rep("WIN_T2", 36), ...rep("LOSS_SL", 24)]), ...sigs(rep("UNVERIFIABLE", u)).map((x, i) => ({ ...x, key: `u|${i}` }))], { costPerTradeR: 0.05 });
    expect(tier(withUnv(10)).tier).toBe("A"); // 14%
    expect(tier(withUnv(20)).tier).toBe("B"); // 25%
    expect(tier(withUnv(40)).tier).toBe("C"); // 40%
  });
  it("severe unverifiable share, severe data-quality issues or a major evidence conflict is D", () => {
    expect(tier(computeMetrics([...sigs(rep("WIN_T3", 40)), ...sigs(rep("UNVERIFIABLE", 80)).map((x, i) => ({ ...x, key: `u|${i}` }))], cfg)).tier).toBe("D");
    expect(tier(good(60, { dataQuality: "INSUFFICIENT" })).tier).toBe("D");
    expect(rules(good(60, (i) => ({ evidenceConflict: i % 3 === 0 })))).toContain("MAJOR_EVIDENCE_CONFLICT");
  });
  it("revision / conflict activity downgrades: low conflict A, above the A limit B, above the downgrade limit one step lower", () => {
    expect(tier(good(60, (i) => ({ adverseSlRevision: i < 3 }))).tier).toBe("A"); // 5%
    expect(tier(good(60, (i) => ({ adverseSlRevision: i < 6 }))).tier).toBe("B"); // 10%
    const r = good(60, (i) => ({ adverseSlRevision: i < 12 })); // 20%
    expect(tier(r).tier).toBe("C");
    expect(rules(r)).toContain("REVISION_ACTIVITY_DOWNGRADE");
  });
  it("is deterministic: the same snapshot and configuration always give the same tier and explanation", () => {
    const m = good(60);
    expect(JSON.stringify(tier(m))).toBe(JSON.stringify(tier(JSON.parse(JSON.stringify(m)))));
    expect(JSON.stringify(tier(m))).toBe(JSON.stringify(tier(m)));
  });
  it("thresholds are configurable and validated", () => {
    expect(tier(good(40), { a: { minEvaluable: 40 } }).tier).toBe("A");
    expect(tier(good(12), { unknownBelow: 10 }).tier).toBe("C");
    expect(tier(good(8), { unknownBelow: 10 }).tier).toBe("UNKNOWN");
    expect(() => resolveTierConfig({ a: { minWinRateEntered: 1.5 } })).toThrow();
    expect(() => resolveTierConfig({ unknownBelow: 0 })).toThrow();
    expect(() => resolveTierConfig({ costPerTradeR: -1 })).toThrow();
  });
});

describe("architecture: scorecards are research-only", () => {
  const ROOT = join(__dirname, "../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));
  const files = [...walk("packages/historical/src/scorecards"), "scripts/ops/historical-scorecard.ts"];
  it("never imports risk, broker, execution, approval or Telegram code, never touches the network, never reads message text", () => {
    for (const f of files) {
      const t = strip(readFileSync(join(ROOT, f), "utf8"));
      expect(t, f).not.toMatch(/@twins\/(risk|execution|broker|approval|adapter)|packages\/(risk|execution|broker)|adapters\/|approval-bot|api\.telegram|\bfetch\(|node:https?|node:net\b|zerodha|kite/i);
      expect(t, f).not.toMatch(/rawText|raw_text/);
      if (f.startsWith("packages/")) expect(t, f).not.toMatch(/console\./); // (the CLI entrypoint prints its own counts-only output)
    }
  });
  it("writes only the five scorecard tables and never updates or deletes", () => {
    for (const f of files) {
      const t = strip(readFileSync(join(ROOT, f), "utf8"));
      for (const m of t.matchAll(/\b(?:db|tx)\.(insert|update|delete)\(\s*(?:schema\.)?(\w+)/g)) expect(m[2], f).toMatch(/^(R|historicalSourceRegistry|historicalScorecardRuns|historicalScorecardMetrics|historicalTrustTiers|historicalScorecardEvents)$/);
      expect(t, f).not.toMatch(/\b(?:db|tx)\.(update|delete)\(/);
    }
  });
  it("scorecard code is reached by the risk flow only through the Task 5 source-intelligence integration (which only READS tiers)", () => {
    // Stage 4 / Task 5 connects source intelligence to the risk flow through exactly these files (the risk recorder, the read-only API routes, the worker via @twins/risk); nothing else imports it
    const allowed = new Set(["apps/api/src/intelligenceApi.ts", "packages/risk/src/intelligence/record.ts"]);
    for (const d of ["apps", "services", "adapters", "packages/risk/src"]) for (const f of walk(d)) if (!allowed.has(f)) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/scorecards|getLatestSourceTrustTier|@twins\/historical|packages\/historical/);
  });
});
