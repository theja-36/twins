import { describe, expect, it } from "vitest";
import { DEFAULT_OPPORTUNITY_CONFIG, detectSetups, gateScan, loadOpportunityConfig, opportunityConfigSha256, runOpportunityScan, screenRewardRisk, buildUniverse, REWARD_RISK_SCREEN_VERSION, type ScanCalendar, type SetupSignal } from "../../../packages/opportunity/src/index";
import type { OhlcSeries } from "../../../packages/agents/src/index";
import { NOW, breakoutUp, cfg, provider, series } from "./fixtures";

/** SYNTHETIC. M16-08 (reward:risk against structure), M16-06 (calendar gate), config reproducibility and independence. */
const policy = { minRewardRisk: 1.5, lookbackBars: 60, swingK: 2 };
const sig = (o: Partial<SetupSignal> = {}): Pick<SetupSignal, "side" | "entry" | "stop" | "targets" | "riskPerUnit"> => ({ side: "BUY", entry: 100, stop: 98, targets: [102, 104, 106], riskPerUnit: 2, ...o });
/** A series with one clear swing high at `level` (bar 30) and otherwise a gentle rise to ~100. */
const withSwingHigh = (level: number): OhlcSeries => {
  const closes = Array.from({ length: 60 }, (_, i) => 90 + i * 0.16); closes[30] = level - 0.3;
  const s = series("AAA", closes, { spread: 0.05 }); const bars = s.bars.map((b, i) => (i === 30 ? { ...b, high: level, close: level - 0.3 } : { ...b, high: Math.min(b.high, level - 1) })); return { ...s, bars };
};
const flatSeries = (): OhlcSeries => series("AAA", Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.05 : -0.05)), { spread: 0.02 });

describe("reward:risk against structure (M16-08)", () => {
  it("a clear path to the reference target (the second target) passes with its own multiple", () => {
    const r = screenRewardRisk(sig(), flatSeries(), policy);
    expect(r).toMatchObject({ version: REWARD_RISK_SCREEN_VERSION, passed: true, reason: "OK", targetRewardRisk: 2, structuralRewardRisk: 2, barrier: null });
  });
  it("an opposing swing high closer than the minimum reward:risk screens a long out, and names the level", () => {
    const r = screenRewardRisk(sig(), withSwingHigh(101.9), policy); // 1.9 above the entry = 0.95R of room
    expect(r).toMatchObject({ passed: false, reason: "BARRIER_TOO_CLOSE" }); expect(r.barrier).toMatchObject({ level: 101.9, distanceR: 0.95 });
  });
  it("a swing high far enough away (beyond 1.5R) does not block", () => {
    const r = screenRewardRisk(sig(), withSwingHigh(103.5), policy);
    expect(r.passed).toBe(true); expect(r.barrier).toMatchObject({ level: 103.5, distanceR: 1.75 });
  });
  it("a swing high BEYOND the reference target is not a barrier", () => { expect(screenRewardRisk(sig(), withSwingHigh(105), policy)).toMatchObject({ passed: true, barrier: null }); });
  it("shorts mirror: the nearest opposing swing LOW below the entry blocks", () => {
    const s = flatSeries(), bars = s.bars.map((b, i) => (i === 30 ? { ...b, low: 98.1, close: 98.4 } : { ...b, low: Math.max(b.low, 99) }));
    expect(screenRewardRisk(sig({ side: "SELL", entry: 100, stop: 102, targets: [98, 96, 94] }), { ...s, bars }, policy)).toMatchObject({ passed: false, reason: "BARRIER_TOO_CLOSE" });
  });
  it("a reference target that is too small a multiple fails on its own", () => {
    expect(screenRewardRisk(sig({ targets: [101, 101.5, 103] }), flatSeries(), policy)).toMatchObject({ passed: false, reason: "TARGET_REWARD_RISK_TOO_LOW", targetRewardRisk: 0.75 });
  });
  it("no target, a target on the wrong side, or a zero risk are refused with their own reason, never passed", () => {
    expect(screenRewardRisk(sig({ targets: [] }), flatSeries(), policy).reason).toBe("NO_TARGET");
    expect(screenRewardRisk(sig({ targets: [99, 98] }), flatSeries(), policy).reason).toBe("NO_TARGET");
    expect(screenRewardRisk(sig({ stop: 100 }), flatSeries(), policy).reason).toBe("INVALID_RISK");
  });
  it("is switched off by a minimum of 0 (and says DISABLED), and is deterministic", () => {
    expect(screenRewardRisk(sig(), withSwingHigh(101.9), { ...policy, minRewardRisk: 0 })).toMatchObject({ passed: true, reason: "DISABLED" });
    expect(JSON.stringify(screenRewardRisk(sig(), withSwingHigh(101.9), policy))).toBe(JSON.stringify(screenRewardRisk(sig(), withSwingHigh(101.9), policy)));
  });
});
describe("the screen inside a scan", () => {
  it("a clean breakout still produces a candidate, with the screen result and the provenance recorded in its evidence", async () => {
    const u = await buildUniverse(cfg());
    const out = await runOpportunityScan({ universe: u, ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, config: cfg(), now: NOW, slotKey: "slot-1" });
    expect(out.status).toBe("COMPLETED"); expect(out.drafts.length).toBeGreaterThan(0);
    const ev = out.drafts[0]!.evidence as Array<Record<string, unknown>>;
    expect(ev.find((e) => e["kind"] === "reward_risk_screen")).toMatchObject({ passed: true, version: REWARD_RISK_SCREEN_VERSION });
    expect(ev.find((e) => e["kind"] === "provenance")).toMatchObject({ engineVersion: "opportunity-scan-v1", configSha256: opportunityConfigSha256(cfg()), calendar: "CALENDAR_UNAVAILABLE" });
  });
  it("a minimum reward:risk above what the setup offers screens its candidates out and records why, once each", async () => {
    const c = cfg({ minRewardRisk: 9 }), out = await runOpportunityScan({ universe: await buildUniverse(c), ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, config: c, now: NOW, slotKey: "slot-2" });
    expect(out.drafts).toEqual([]); expect(out.skipped.filter((s) => s.reason === "REWARD_RISK_BELOW_MIN").length).toBeGreaterThan(0); expect(out.skipped.find((s) => s.reason === "REWARD_RISK_BELOW_MIN")!.detail).toMatch(/TARGET_REWARD_RISK_TOO_LOW/);
  });
  it("switching the screen off (0) restores every candidate", async () => {
    const on = await runOpportunityScan({ universe: await buildUniverse(cfg()), ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, config: cfg(), now: NOW, slotKey: "s" });
    const off = await runOpportunityScan({ universe: await buildUniverse(cfg({ minRewardRisk: 0 })), ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, config: cfg({ minRewardRisk: 0 }), now: NOW, slotKey: "s" });
    expect(off.drafts.length).toBeGreaterThanOrEqual(on.drafts.length);
  });
});
describe("calendar gate (M16-06)", () => {
  const cal = (state: { market: "OPEN" | "CLOSED" | "UNKNOWN"; minutesToHighImpactEvent: number | null } | "throw"): ScanCalendar => ({ name: "memory-calendar", async stateAt() { if (state === "throw") throw new Error("SECRET calendar failure"); return state; } });
  const gate = (c: ScanCalendar | null) => gateScan(NOW, c, { eventBlockMinutes: 30 });
  it("open and no imminent event: proceed; a closed market and an imminent high-impact event are explicit", async () => {
    expect(await gate(cal({ market: "OPEN", minutesToHighImpactEvent: null }))).toEqual({ status: "PROCEED" });
    expect(await gate(cal({ market: "OPEN", minutesToHighImpactEvent: 120 }))).toEqual({ status: "PROCEED" });
    expect(await gate(cal({ market: "CLOSED", minutesToHighImpactEvent: null }))).toEqual({ status: "MARKET_CLOSED" });
    expect(await gate(cal({ market: "OPEN", minutesToHighImpactEvent: 30 }))).toMatchObject({ status: "EVENT_WINDOW" });
    expect(await gate(cal({ market: "OPEN", minutesToHighImpactEvent: 0 }))).toMatchObject({ status: "EVENT_WINDOW" });
  });
  it("no calendar, an unknown market state, or a failing source is UNAVAILABLE: missing evidence, never open and never closed; the failure message is not kept", async () => {
    for (const c of [null, cal({ market: "UNKNOWN", minutesToHighImpactEvent: null }), cal("throw")]) { const g = await gate(c); expect(g.status).toBe("CALENDAR_UNAVAILABLE"); expect(JSON.stringify(g)).not.toContain("SECRET"); }
    expect(await gate(cal({ market: "OPEN", minutesToHighImpactEvent: -5 }))).toEqual({ status: "PROCEED" }); // an event already past does not block
  });
  it("a closed market or an event window makes the scan an explicit COMPLETED no-op that records every instrument; it is not a failure and not a silent empty success", async () => {
    const u = await buildUniverse(cfg({ universe: ["AAA", "BBB"] }));
    const closed = await runOpportunityScan({ universe: u, ohlc: provider({ AAA: breakoutUp("AAA"), BBB: breakoutUp("BBB") }), regime: null, calendar: cal({ market: "CLOSED", minutesToHighImpactEvent: null }), config: cfg({ universe: ["AAA", "BBB"] }), now: NOW, slotKey: "c" });
    expect(closed).toMatchObject({ status: "COMPLETED", errorKind: null, scanned: 0, drafts: [] }); expect(closed.skipped.map((s) => `${s.underlying}:${s.reason}`)).toEqual(["AAA:MARKET_CLOSED", "BBB:MARKET_CLOSED"]);
    const event = await runOpportunityScan({ universe: u, ohlc: provider({ AAA: breakoutUp("AAA"), BBB: breakoutUp("BBB") }), regime: null, calendar: cal({ market: "OPEN", minutesToHighImpactEvent: 10 }), config: cfg({ universe: ["AAA", "BBB"] }), now: NOW, slotKey: "e" });
    expect(event.skipped.every((s) => s.reason === "EVENT_WINDOW")).toBe(true);
  });
  it("an open calendar scans normally and records PROCEED as the calendar status of every candidate", async () => {
    const out = await runOpportunityScan({ universe: await buildUniverse(cfg()), ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, calendar: cal({ market: "OPEN", minutesToHighImpactEvent: null }), config: cfg(), now: NOW, slotKey: "o" });
    expect(out.drafts.length).toBeGreaterThan(0); for (const d of out.drafts) expect((d.evidence as Array<Record<string, unknown>>).find((e) => e["kind"] === "provenance")).toMatchObject({ calendar: "PROCEED" });
  });
  it("the calendar gate does not hide a missing provider or an empty universe (those still FAIL)", async () => {
    const c = cal({ market: "CLOSED", minutesToHighImpactEvent: null });
    expect(await runOpportunityScan({ universe: [], ohlc: provider({}), regime: null, calendar: c, config: cfg({ universe: [] }), now: NOW, slotKey: "x" })).toMatchObject({ status: "FAILED", errorKind: "NO_UNIVERSE" });
    expect(await runOpportunityScan({ universe: await buildUniverse(cfg()), ohlc: null, regime: null, calendar: c, config: cfg(), now: NOW, slotKey: "y" })).toMatchObject({ status: "FAILED", errorKind: "NO_PROVIDER" });
  });
});
describe("configuration additions and reproducibility", () => {
  it("defaults, strict parsing and bounds", () => {
    expect(DEFAULT_OPPORTUNITY_CONFIG).toMatchObject({ minRewardRisk: 1.5, structureLookbackBars: 60, eventBlockMinutes: 30 });
    expect(loadOpportunityConfig({ TWINS_OPPORTUNITY_MIN_REWARD_RISK: "2.5", TWINS_OPPORTUNITY_STRUCTURE_LOOKBACK: "100", TWINS_OPPORTUNITY_EVENT_BLOCK_MINUTES: "45" })).toMatchObject({ minRewardRisk: 2.5, structureLookbackBars: 100, eventBlockMinutes: 45 });
    expect(loadOpportunityConfig({ TWINS_OPPORTUNITY_MIN_REWARD_RISK: "0" }).minRewardRisk).toBe(0);
    for (const bad of [{ TWINS_OPPORTUNITY_MIN_REWARD_RISK: "11" }, { TWINS_OPPORTUNITY_MIN_REWARD_RISK: "abc" }, { TWINS_OPPORTUNITY_MIN_REWARD_RISK: "-1" }, { TWINS_OPPORTUNITY_STRUCTURE_LOOKBACK: "5" }, { TWINS_OPPORTUNITY_EVENT_BLOCK_MINUTES: "2000" }]) expect(() => loadOpportunityConfig(bad), JSON.stringify(bad)).toThrow();
  });
  it("the config hash is stable, order-insensitive for lists, and changes with any setting that decides candidates (but not with batch sizes)", () => {
    const a = opportunityConfigSha256(cfg({ universe: ["AAA", "BBB"] }));
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(opportunityConfigSha256(cfg({ universe: ["BBB", "AAA"] }))).toBe(a);
    for (const change of [{ minRewardRisk: 2 }, { minRankScore: 55 }, { universe: ["AAA"] }, { structureLookbackBars: 80 }, { eventBlockMinutes: 5 }, { candidateTtlMinutes: 30 }]) expect(opportunityConfigSha256(cfg({ universe: ["AAA", "BBB"], ...change })), JSON.stringify(change)).not.toBe(a);
    expect(opportunityConfigSha256(cfg({ universe: ["AAA", "BBB"], researchBatchSize: 9, researchLeaseMinutes: 99 }))).toBe(a);
  });
});
describe("independence and safety of a discovered candidate", () => {
  it("an independent candidate needs no Telegram input at all and grants nothing: parsed fields only, source-agnostic shape, no order, approval or size", async () => {
    const out = await runOpportunityScan({ universe: await buildUniverse(cfg()), ohlc: provider({ AAA: breakoutUp("AAA") }), regime: null, config: cfg(), now: NOW, slotKey: "i" });
    const d = out.drafts[0]!; const json = JSON.stringify(d);
    expect(json).not.toMatch(/telegram|claim|message_id|messageText/i);
    expect(Object.keys(d)).not.toEqual(expect.arrayContaining(["quantity", "lots", "orderId", "approved", "size"]));
    const rank = (d.evidence as Array<Record<string, unknown>>).find((e) => e["kind"] === "rank")!; expect(rank).toMatchObject({ grantsApproval: false, confidence: null, calibrated: false });
  });
  it("detectSetups on the fixture is unchanged by the new screens (the screen is a separate stage)", () => { expect(detectSetups(breakoutUp("AAA"), "AAA").length).toBeGreaterThan(0); });
});
