import { describe, expect, it } from "vitest";
import { buildUniverse, dedupeKeyOf, detectSetups, loadOpportunityConfig, rankSetup, resample, runOpportunityScan, trendOf, type SetupSignal } from "../../../packages/opportunity/src/index";
import { NOW, breakdownDown, breakoutUp, cfg, flat, provider, regime, regimeProvider, series } from "./fixtures";

const universe = (...u: string[]) => u.map((underlying) => ({ underlying, eligible: true }));
const scan = (o: { ohlc?: ReturnType<typeof provider> | null; regime?: ReturnType<typeof regimeProvider> | null; universe?: ReturnType<typeof universe>; config?: ReturnType<typeof cfg> } = {}) =>
  runOpportunityScan({ universe: o.universe ?? universe("AAA"), ohlc: o.ohlc === undefined ? provider({ AAA: breakoutUp("AAA") }) : o.ohlc, regime: o.regime === undefined ? null : o.regime, config: o.config ?? cfg(), now: NOW, slotKey: "2031-01-05T09:45Z", newId: () => "00000000-0000-4000-8000-000000000000" });

describe("configuration", () => {
  it("is disabled with an empty universe by default and fails closed on bad values", () => {
    const c = loadOpportunityConfig({});
    expect(c).toMatchObject({ enabled: false, universe: [], dataSource: "FIXTURE" });
    expect(loadOpportunityConfig({ TWINS_OPPORTUNITY_ENABLED: "true", TWINS_OPPORTUNITY_UNIVERSE: "nifty, banknifty" }).universe).toEqual(["NIFTY", "BANKNIFTY"]);
    for (const env of [{ TWINS_OPPORTUNITY_ENABLED: "yes" }, { TWINS_OPPORTUNITY_UNIVERSE: "A B" }, { TWINS_OPPORTUNITY_UNIVERSE: "A,A" }, { TWINS_OPPORTUNITY_DATA_SOURCE: "PAPER" }, { TWINS_OPPORTUNITY_MIN_RANK: "101" }, { TWINS_OPPORTUNITY_TTL_MINUTES: "x" }, { TWINS_OPPORTUNITY_CONFLUENCE_SECONDS: "5" }]) {
      expect(() => loadOpportunityConfig(env), JSON.stringify(env)).toThrow();
    }
  });
});

describe("setup detection (pure)", () => {
  it("finds a breakout with a protective stop, ordered targets and an invalidation level", () => {
    const sigs = detectSetups(breakoutUp("AAA"), "AAA");
    const b = sigs.find((s) => s.setup === "BREAKOUT_LONG") as SetupSignal;
    expect(b).toBeDefined();
    expect(b.side).toBe("BUY");
    expect(b.stop).toBeLessThan(b.entry);
    expect(b.targets[0]).toBeGreaterThan(b.entry);
    expect(b.targets).toEqual([...b.targets].sort((x, y) => x - y));
    expect(b.invalidation).toMatchObject({ price: b.stop, breachWhen: "BELOW" });
    expect(b.volumeConfirmed).toBe(true);
  });
  it("finds a breakdown short with mirrored geometry", () => {
    const b = detectSetups(breakdownDown("AAA"), "AAA").find((s) => s.setup === "BREAKDOWN_SHORT") as SetupSignal;
    expect(b.side).toBe("SELL");
    expect(b.stop).toBeGreaterThan(b.entry);
    expect(b.invalidation.breachWhen).toBe("ABOVE");
  });
  it("finds nothing on flat, short or malformed data", () => {
    expect(detectSetups(flat("AAA"), "AAA")).toEqual([]);
    expect(detectSetups(series("AAA", [100, 101, 102]), "AAA")).toEqual([]);
    const bad = breakoutUp("AAA"); (bad.bars[100] as { high: number }).high = -1;
    expect(detectSetups(bad, "AAA")).toEqual([]);
  });
  it("finds a bullish reversal: a hammer at a recent swing low with stretched RSI", () => {
    const closes = [...Array.from({ length: 200 }, (_, i) => 150 - 0.15 * i), 119.6, 119.0, 118.5, 118.9, 119.2, 119.3, 119.0, 118.7];
    const s = series("AAA", closes);
    const last = s.bars[s.bars.length - 1]!; // hammer: tiny body, long lower wick
    last.open = 118.65; last.close = 118.7; last.high = 118.72; last.low = 117.7;
    const r = detectSetups(s, "AAA").find((x) => x.setup === "REVERSAL_LONG");
    expect(r).toBeDefined();
    expect(r!.stop).toBeLessThan(r!.entry);
    expect(r!.reasons).toContain("AT_RECENT_SWING_LOW");
  });
  it("momentum long needs a trend stack, a mid-band RSI and a decisive 5-bar move", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + 0.05 * i + (i % 4 === 0 ? -0.6 : 0.2)); // up with pullbacks keeps RSI below 75
    for (let k = 0; k < 6; k++) closes.push((closes[closes.length - 1] as number) + 0.9);
    const m = detectSetups(series("AAA", closes, { spread: 0.1 }), "AAA").find((x) => x.setup === "MOMENTUM_LONG");
    if (m) { expect(m.side).toBe("BUY"); expect(m.stop).toBeLessThan(m.entry); }
    expect(detectSetups(flat("AAA"), "AAA").some((x) => x.setup.startsWith("MOMENTUM"))).toBe(false);
  });
  it("resamples only into COMPLETE buckets and never extrapolates", () => {
    const s = breakoutUp("AAA"), h = resample(s, 3600)!;
    expect(h.intervalSeconds).toBe(3600);
    for (const b of h.bars) expect(Date.parse(b.t) % 3_600_000).toBe(0);
    expect(h.bars.length).toBeLessThanOrEqual(Math.floor(240 / 4));
    expect(resample(s, 1000)).toBeNull();
    expect(resample(s, 900)).toBeNull();
  });
  it("reads the higher-timeframe trend, UNKNOWN when history is short", () => {
    expect(trendOf(resample(breakoutUp("AAA"), 3600))).toBe("BULLISH");
    expect(trendOf(resample(breakdownDown("AAA"), 3600))).toBe("BEARISH");
    expect(trendOf(resample(series("AAA", [1, 2, 3, 4, 5, 6, 7, 8]), 3600))).toBe("UNKNOWN");
    expect(trendOf(null)).toBe("UNKNOWN");
  });
});

describe("ranking is explainable and never invents support", () => {
  const sig = detectSetups(breakoutUp("AAA"), "AAA").find((s) => s.setup === "BREAKOUT_LONG") as SetupSignal;
  it("missing evidence scores zero and is listed; confidence is null and nothing grants approval", () => {
    const d = rankSetup(sig, { htfTrend: "UNKNOWN", regime: null, regimeUsable: false });
    expect(d.missing).toEqual(expect.arrayContaining(["HTF_TREND_UNAVAILABLE", "REGIME_UNAVAILABLE"]));
    expect(d.factors.map((f) => f.code)).toEqual(["SETUP_VALID", "VOLUME_CONFIRMED"]);
    expect(d.confidence).toBeNull(); expect(d.calibrated).toBe(false); expect(d.grantsApproval).toBe(false);
  });
  it("agreeing context adds, opposing context subtracts, and the score stays within 0..100", () => {
    const good = rankSetup(sig, { htfTrend: "BULLISH", regime: regime(), regimeUsable: true });
    const bad = rankSetup(sig, { htfTrend: "BEARISH", regime: regime({ direction: "BEARISH", volatilityRegime: "EXTREME", eventRisk: "HIGH" }), regimeUsable: true });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.score).toBeGreaterThanOrEqual(0); expect(good.score).toBeLessThanOrEqual(100);
    expect(good.factors.find((f) => f.code === "FIXTURE_REGIME")).toBeDefined();
  });
  it("an unusable (unknown or stale) regime is treated as missing, not as neutral support", () => {
    const d = rankSetup(sig, { htfTrend: "BULLISH", regime: regime({ regime: "UNKNOWN" }), regimeUsable: false });
    expect(d.missing).toContain("REGIME_UNUSABLE");
    expect(d.factors.some((f) => f.code.startsWith("REGIME_"))).toBe(false);
  });
});

describe("scan", () => {
  it("produces a ranked INDEPENDENT-shaped draft with provenance, an invalidation level and an unvalidated stop", async () => {
    const o = await scan({ regime: regimeProvider(regime()) });
    expect(o).toMatchObject({ status: "COMPLETED", errorKind: null, scanned: 1, providerName: "memory-ohlc" });
    const d = o.drafts.find((x) => x.setup === "BREAKOUT")!;
    expect(d).toMatchObject({ underlying: "AAA", side: "BUY", entryKind: "at", dataSource: "FIXTURE", invalidation: { breachWhen: "BELOW" } });
    expect(d.stopLoss).toBeLessThan(d.entryLow);
    expect(d.expiresAt.getTime() - d.createdAt.getTime()).toBe(240 * 60_000);
    const ev = d.evidence as Array<{ kind: string; [k: string]: unknown }>;
    expect(ev.find((e) => e.kind === "stop_loss")).toMatchObject({ validated: false });
    expect(ev.find((e) => e.kind === "provenance")).toMatchObject({ provider: "memory-ohlc", calibrated: false, confidence: null, scanSlot: "2031-01-05T09:45Z", regimeRef: expect.stringContaining("market_regime:market-regime-v1:AAA") });
    expect(ev.find((e) => e.kind === "rank")).toMatchObject({ confidence: null, grantsApproval: false });
    expect(JSON.stringify(d)).not.toMatch(/order|approve_trade|telegram/i);
  });
  it("is deterministic and the same bar always yields the same dedupe key", async () => {
    const a = await scan(), b = await scan();
    expect(a.drafts.map((x) => x.dedupeKey)).toEqual(b.drafts.map((x) => x.dedupeKey));
    const s = detectSetups(breakoutUp("AAA"), "AAA")[0] as SetupSignal;
    expect(dedupeKeyOf("AAA", s)).toBe(dedupeKeyOf("AAA", { ...s }));
    expect(dedupeKeyOf("AAA", s)).not.toBe(dedupeKeyOf("BBB", s));
    expect(dedupeKeyOf("AAA", s)).not.toBe(dedupeKeyOf("AAA", { ...s, signalBarAt: "2031-01-05T09:45:00.000Z" }));
  });
  it("with no regime it still scans but records the regime as missing (never as support)", async () => {
    const o = await scan({ regime: null });
    const rank = (o.drafts[0]!.evidence as Array<{ kind: string; missing?: string[] }>).find((e) => e.kind === "rank")!;
    expect(rank.missing).toContain("REGIME_UNAVAILABLE");
  });
  it("a high-volatility or risk-off regime suppresses candidates for that instrument and says why", async () => {
    for (const r of [regime({ regime: "HIGH_VOLATILITY" }), regime({ riskOff: true, regime: "RISK_OFF" })]) {
      const o = await scan({ regime: regimeProvider(r) });
      expect(o.drafts).toEqual([]);
      expect(o.skipped).toEqual([expect.objectContaining({ underlying: "AAA", reason: "REGIME_BLOCKED" })]);
    }
  });
  it("a failing regime provider degrades to missing evidence, not to a failed scan", async () => {
    const o = await scan({ regime: regimeProvider("throw") });
    expect(o.status).toBe("COMPLETED"); expect(o.drafts.length).toBeGreaterThan(0);
  });
  it("fails honestly (never an empty success) with no universe, no provider or no usable data", async () => {
    expect(await scan({ universe: [] })).toMatchObject({ status: "FAILED", errorKind: "NO_UNIVERSE" });
    expect(await scan({ ohlc: null })).toMatchObject({ status: "FAILED", errorKind: "NO_PROVIDER" });
    const all = await scan({ ohlc: provider({ AAA: null }) });
    expect(all).toMatchObject({ status: "FAILED", errorKind: "NO_USABLE_DATA" });
    expect(all.skipped).toEqual([{ underlying: "AAA", reason: "NO_DATA" }]);
  });
  it("records every skipped instrument with its reason: missing, stale, malformed, mismatched, short, provider error, ineligible", async () => {
    const stale = series("STALE", Array.from({ length: 240 }, (_, i) => 100 + i * 0.01), { end: new Date(NOW.getTime() - 3 * 3600_000) });
    const future = series("FUT", Array.from({ length: 240 }, (_, i) => 100 + i * 0.01), { end: new Date(NOW.getTime() + 3600_000) });
    const bad = breakoutUp("BAD"); (bad.bars[3] as { high: number }).high = 1; (bad.bars[3] as { low: number }).low = 2;
    const o = await runOpportunityScan({
      universe: [...universe("OK", "NONE", "STALE", "FUT", "BAD", "MISMATCH", "SHORT", "ERR"), { underlying: "INEL", eligible: false, reason: "not verified by the instrument reference" }],
      ohlc: provider({ OK: breakoutUp("OK"), NONE: null, STALE: stale, FUT: future, BAD: bad, MISMATCH: breakoutUp("OTHER"), SHORT: series("SHORT", [1, 2, 3]), ERR: "throw" }),
      regime: null, config: cfg(), now: NOW, slotKey: "s",
    });
    const reason = (u: string) => o.skipped.find((s) => s.underlying === u)?.reason;
    expect(o.status).toBe("COMPLETED");
    expect(o.drafts.every((d) => d.underlying === "OK")).toBe(true);
    expect(["NONE", "STALE", "FUT", "BAD", "MISMATCH", "SHORT", "ERR", "INEL"].map(reason)).toEqual(["NO_DATA", "STALE", "FROM_FUTURE", "MALFORMED", "SYMBOL_MISMATCH", "INSUFFICIENT_HISTORY", "PROVIDER_ERROR", "INELIGIBLE"]);
    expect(JSON.stringify(o.skipped)).not.toContain("SECRET");
  });
  it("applies the minimum rank and the per-scan cap, and records what it dropped", async () => {
    const high = await scan({ config: cfg({ minRankScore: 100 }) });
    expect(high.drafts).toEqual([]); expect(high.skipped.some((s) => s.reason === "BELOW_MIN_RANK")).toBe(true);
    const two = await runOpportunityScan({ universe: universe("AAA", "BBB", "CCC"), ohlc: provider({ AAA: breakoutUp("AAA"), BBB: breakoutUp("BBB"), CCC: breakoutUp("CCC") }), regime: null, config: cfg({ maxCandidatesPerScan: 2 }), now: NOW, slotKey: "s" });
    expect(two.drafts).toHaveLength(2);
    expect(two.skipped.filter((s) => s.reason === "OVER_SCAN_CAP").length).toBeGreaterThan(0);
  });
  it("a breakdown becomes a SELL draft with the stop above entry", async () => {
    const o = await scan({ ohlc: provider({ AAA: breakdownDown("AAA") }) });
    const d = o.drafts.find((x) => x.side === "SELL")!;
    expect(d.stopLoss).toBeGreaterThan(d.entryLow);
  });
  it("eligibility defaults to eligible only with no verifier; a failing verifier makes the instrument ineligible", async () => {
    expect(await buildUniverse({ universe: ["A", "B"] })).toEqual([{ underlying: "A", eligible: true }, { underlying: "B", eligible: true }]);
    const u = await buildUniverse({ universe: ["A", "B", "C"] }, (x) => { if (x === "C") throw new Error("x"); return x === "A"; });
    expect(u.map((e) => e.eligible)).toEqual([true, false, false]);
  });
});
