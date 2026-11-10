import { describe, expect, it } from "vitest";
import { analyzeMarketRegime, toRegimeRows, type RegimeInput, type TimedBar, type Timeframe } from "../../../packages/agents/src/regime/index";
import { buildResearchPackage, candidateToAgentInputs, createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, orchestrate, type ResearchCandidate } from "../../../packages/agents/src/index";

/** SYNTHETIC. Temporal correctness of the research layer: a package is a pure function of its inputs and the supplied clock, never of the wall clock or of anything that happened later. */
const NOW = new Date("2026-11-09T04:30:00Z"), cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
const cand = (o: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ id: "aaaaaaaa-1111-4111-8111-111111111111", source: "TELEGRAM", underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE", expiry: "2026-11-27", side: "BUY", entryKind: "at", entryLow: 120, entryHigh: null, stopLoss: 90, targets: [150, 180], dataSource: "FIXTURE", createdAt: new Date("2026-11-09T04:25:00Z"), ...o });
const pkgAt = async (c: ResearchCandidate, version: number, now: Date) => {
  const out = await orchestrate(createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).resolve(cfg), cfg, candidateToAgentInputs(c) as never, { riskDecisionId: c.id, decisionVersion: 1 }, { now: () => now, sleep: async () => undefined });
  return buildResearchPackage(c, version, out);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("replay and supersession", () => {
  it("historical replay: the same candidate and the same clock give the same package hash, whatever the wall clock does", async () => {
    const a = await pkgAt(cand(), 1, NOW); await wait(25); const b = await pkgAt(cand(), 1, NOW);
    expect(b.packageSha256).toBe(a.packageSha256); expect(b.synthesisInputSha256).toBe(a.synthesisInputSha256);
  });
  it("a later version is a different record: it carries its own version and hash, and the earlier one is untouched", async () => {
    const v1 = await pkgAt(cand(), 1, NOW), before = JSON.stringify(v1), v2 = await pkgAt(cand({ stopLoss: 95 }), 2, new Date(NOW.getTime() + 3_600_000));
    expect(v2.version).toBe(2); expect(v2.packageSha256).not.toBe(v1.packageSha256); expect(JSON.stringify(v1)).toBe(before);
  });
  it("the package records its as-of (the supplied clock) and no other timestamp, so it cannot drift on re-read", async () => {
    const p = await pkgAt(cand(), 1, NOW); expect(p.asOf).toBe(NOW.toISOString());
    const stamps = JSON.stringify(p).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z/g) ?? []; expect(new Set(stamps)).toEqual(new Set([NOW.toISOString()]));
  });
  it("research at a different instant is a different record: the as-of is part of the hash", async () => { expect((await pkgAt(cand(), 1, new Date(NOW.getTime() + 60_000))).packageSha256).not.toBe((await pkgAt(cand(), 1, NOW)).packageSha256); });
  it("a candidate expressed with later-dated levels does not change an earlier package (versions are keyed by candidate, not mutated)", async () => {
    const first = await pkgAt(cand(), 1, NOW); await pkgAt(cand({ targets: [200] }), 2, NOW);
    expect((await pkgAt(cand(), 1, NOW)).packageSha256).toBe(first.packageSha256);
  });
});
describe("regime as-of rules", () => {
  const STEP: Record<Timeframe, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
  const bars = (tf: Timeframe, agoSec: number, n = 60): TimedBar[] => { let p = 24000; return Array.from({ length: n }, (_, i) => { const open = p, close = p * 1.0015; p = close; return { open, close, high: close * 1.0004, low: open * 0.9996, at: new Date(NOW.getTime() - agoSec * 1000 - (n - 1 - i) * STEP[tf]) }; }); };
  const input = (agoSec: number): RegimeInput => ({ underlying: "NIFTY", timeframes: (["5m", "15m", "1h"] as const).map((tf) => ({ timeframe: tf, bars: bars(tf, agoSec) })), now: NOW, dataSource: "FIXTURE" });
  it("asOf is never later than the evaluation instant, and a future-dated bar gives no regime at all", () => {
    const ok = analyzeMarketRegime(input(60)); expect(ok.asOf).not.toBeNull(); expect(Date.parse(ok.asOf as string)).toBeLessThanOrEqual(NOW.getTime());
    const future = analyzeMarketRegime(input(-600)); expect(future.asOf).toBeNull(); expect(future.direction).toBe("UNKNOWN");
  });
  it("stored regime rows never carry an as-of after the evaluation instant, and a regime with no usable timeframe writes no row", () => {
    const rows = toRegimeRows(analyzeMarketRegime(input(60)), "market-regime-v1"); expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.asOf.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(toRegimeRows(analyzeMarketRegime(input(-600)), "market-regime-v1")).toEqual([]);
  });
  it("later data cannot change an earlier regime: the same bars at the same clock give the same object", () => {
    expect(JSON.stringify(analyzeMarketRegime(input(60)))).toBe(JSON.stringify(analyzeMarketRegime(input(60))));
    expect(analyzeMarketRegime(input(60)).grantsApproval).toBe(false);
  });
});
