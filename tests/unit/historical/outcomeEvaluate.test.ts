import { describe, expect, it } from "vitest";
import { buildDataset, evaluateOutcome, type OutcomeResult, type Series } from "../../../packages/historical/src/outcomes/index";
import { config, dailyBars, datasetOf, day, equitySeries, optionSeries, optionSignal, signal, T0, underlyingSeries, type Ohlc } from "../../support/outcomeFixtures";

const seriesOf = (raw: Record<string, unknown>): Series => buildDataset(datasetOf([raw]), "a".repeat(64)).series[0] as Series;
const equity = (spec: Parameters<typeof dailyBars>[0], over: Record<string, unknown> = {}): Series => seriesOf(equitySeries("ACME", dailyBars(spec), over));
const run = (sig = signal(), s: Series | null = equity({ days: 30, base: 100 }), cfg = config()): OutcomeResult => evaluateOutcome(sig, cfg, { series: s, underlyingAvailable: false });

describe("entry, stop-loss and targets on equity bars", () => {
  it("entry reached, then T1 / T2 / T3 before the stop-loss, labelled with the HIGHEST target hit", () => {
    const t1 = run(signal(), equity({ days: 30, base: 100, at: { 3: [100, 100, 100, 100], 5: [100, 106, 100, 105] } }));
    expect(t1).toMatchObject({ finalOutcome: "WIN_T1", entry: { status: "ENTRY_REACHED", firstTouchAt: day(1) }, stopLoss: { status: "SL_NOT_HIT" } });
    const t2 = run(signal(), equity({ days: 30, base: 100, at: { 4: [100, 106, 100, 105], 6: [105, 111, 104, 110] } }));
    expect(t2.finalOutcome).toBe("WIN_T2");
    expect(t2.targets.map((t) => [t.status, t.firstTouchAt])).toEqual([["TARGET_HIT", day(4)], ["TARGET_HIT", day(6)], ["TARGET_NOT_HIT", null]]);
    const t3 = run(signal(), equity({ days: 30, base: 100, at: { 4: [100, 116, 100, 115] } }));
    expect(t3.finalOutcome).toBe("WIN_T3");
    expect(t3.targets.every((t) => t.hitBeforeSl === true)).toBe(true);
  });
  it("the stop-loss before any target is LOSS_SL, even if a target is touched later", () => {
    const r = run(signal(), equity({ days: 30, base: 100, at: { 4: [100, 100, 94, 95], 6: [100, 120, 100, 118] } }));
    expect(r).toMatchObject({ finalOutcome: "LOSS_SL", stopLoss: { status: "SL_HIT", firstTouchAt: day(4) } });
    expect(r.targets.every((t) => t.status === "TARGET_NOT_HIT")).toBe(true);
  });
  it("a target hit before the stop-loss wins even if the stop is touched afterwards (evaluation stops at the stop)", () => {
    const r = run(signal(), equity({ days: 30, base: 100, at: { 4: [100, 106, 100, 105], 6: [105, 105, 90, 92] } }));
    expect(r.finalOutcome).toBe("WIN_T1");
  });
  it("entry never touched inside the horizon is NO_ENTRY; with an explicit validity end it is EXPIRED_NO_ENTRY", () => {
    const away = equity({ days: 30, base: 120 });
    expect(run(signal(), away)).toMatchObject({ finalOutcome: "NO_ENTRY", entry: { status: "ENTRY_NOT_REACHED", reachableBeforeValidityEnd: false }, dataQuality: "GOOD" });
    const expired = run(optionSignal({ expiryDate: "2030-01-10", entry: { type: "at", price: 100 } }), seriesOf(optionSeries("NIFTY", 24500, "CE", "2030-01-10", dailyBars({ days: 12, base: 50 }))));
    expect(expired).toMatchObject({ finalOutcome: "EXPIRED_NO_ENTRY", primaryReason: "ENTRY_NOT_REACHED_BEFORE_VALIDITY_END" });
    expect((expired.window as { validityKind: string }).validityKind).toBe("contract_expiry");
  });
  it("entry reached but neither stop nor target before the end is EXPIRED_AFTER_ENTRY", () => {
    expect(run(signal(), equity({ days: 30, base: 100 }))).toMatchObject({ finalOutcome: "EXPIRED_AFTER_ENTRY", primaryReason: "HORIZON_REACHED_AFTER_ENTRY" });
  });
  it("above / below / range entries and short (SELL) signals use the right side of the bar", () => {
    const rising = equity({ days: 30, base: 100, at: { 2: [100, 103, 100, 103], 3: [103, 104, 103, 104], 4: [104, 106, 104, 106] } });
    expect(run(signal({ entry: { type: "above", price: 103 }, stopLoss: 98 }), rising)).toMatchObject({ entry: { firstTouchAt: day(2) } });
    expect(run(signal({ entry: { type: "range", low: 99, high: 101 } }), rising).entry.firstTouchAt).toBe(day(1));
    const falling = equity({ days: 30, base: 100, at: { 3: [100, 100, 94, 94], 5: [94, 94, 89, 89] } });
    const short = run(signal({ side: "sell", entry: { type: "at", price: 100 }, stopLoss: 105, targets: [95, 90, 85] }), falling);
    expect(short.finalOutcome).toBe("WIN_T2");
  });
  it("only bars AFTER the signal are used: a bar at the signal time (even one that would stop the trade out) is ignored", () => {
    const s = seriesOf(equitySeries("ACME", [{ t: day(0), o: 100, h: 100, l: 90, c: 90 }, ...dailyBars({ days: 30, base: 100 })]));
    expect(run(signal(), s).finalOutcome).toBe("EXPIRED_AFTER_ENTRY");
  });
});

describe("invalid and unverifiable signals (priority 1)", () => {
  it.each([
    ["a stop-loss above a long entry", signal({ stopLoss: 105 }), "STOP_LOSS_ON_WRONG_SIDE"],
    ["a target below a long entry", signal({ targets: [95] }), "TARGET_ON_WRONG_SIDE"],
    ["no stop-loss", signal({ stopLoss: null }), "MISSING_STOP_LOSS"],
    ["no targets", signal({ targets: [] }), "MISSING_TARGETS"],
    ["no side", signal({ side: null }), "MISSING_SIDE"],
    ["an unspecified entry", signal({ entry: { type: "unspecified" } }), "MISSING_ENTRY"],
    ["a reversed range", signal({ entry: { type: "range", low: 105, high: 100 } }), "ENTRY_RANGE_INVALID"],
    ["unordered targets", signal({ targets: [110, 105] }), "TARGETS_NOT_ORDERED"],
    ["an option without an expiry date", optionSignal({ expiryDate: null }), "CONTRACT_EXPIRY_NOT_STATED"],
    ["an option whose levels are not premium", optionSignal({ levelBasis: "underlying" }), "OPTION_LEVEL_BASIS_NOT_PREMIUM"],
  ])("%s is INVALID_SIGNAL (%s) and no data is examined", (_n, sig, reason) => {
    const r = run(sig);
    expect(r).toMatchObject({ finalOutcome: "INVALID_SIGNAL", primaryReason: reason, dataQuality: "NOT_APPLICABLE" });
    expect(r.reasons).toContain(reason);
  });
  it("a market entry whose actual open contradicts the stop-loss is INVALID_SIGNAL", () => {
    expect(run(signal({ entry: { type: "market" }, stopLoss: 95 }), equity({ days: 30, base: 90 })).primaryReason).toBe("ACTUAL_ENTRY_CONTRADICTS_STOP_LOSS");
  });
  it("a vague 'near' entry and an unresolved SELL option are UNVERIFIABLE, never guessed", () => {
    expect(run(signal({ entry: { type: "near", price: 100 } }))).toMatchObject({ finalOutcome: "UNVERIFIABLE", primaryReason: "ENTRY_TRIGGER_VAGUE" });
    expect(run(signal({ entry: { type: "near", price: 100 } }), undefined, config({ nearTolerancePct: 1 })).finalOutcome).toBe("EXPIRED_AFTER_ENTRY");
    const sell = optionSignal({ side: "sell", intent: "unresolved" });
    expect(run(sell).primaryReason).toBe("SELL_INTENT_UNRESOLVED");
  });
  it("an option contract that expired before the signal is INVALID_SIGNAL", () => {
    expect(run(optionSignal({ expiryDate: "2029-12-20" }), seriesOf(optionSeries("NIFTY", 24500, "CE", "2029-12-20", dailyBars({ days: 3, base: 100 })))).primaryReason).toBe("EXPIRY_BEFORE_SIGNAL");
  });
});

describe("data integrity", () => {
  it("no series at all is UNVERIFIABLE (NO_MARKET_DATA)", () => {
    expect(run(signal(), null)).toMatchObject({ finalOutcome: "UNVERIFIABLE", primaryReason: "NO_MARKET_DATA", dataQuality: "INSUFFICIENT" });
  });
  it("future-dated bars (not complete by the evaluation instant) are rejected: nothing else left means UNVERIFIABLE", () => {
    const r = run(signal(), equity({ days: 30, base: 100 }), config({ evaluatedAt: new Date(day(0)) }));
    expect(r).toMatchObject({ finalOutcome: "UNVERIFIABLE", primaryReason: "ONLY_FUTURE_DATA" });
    const partial = run(signal(), equity({ days: 30, base: 100, at: { 20: [100, 106, 100, 105] } }), config({ evaluatedAt: new Date(day(10)) }));
    expect(partial.primaryReason).toBe("INSUFFICIENT_COVERAGE"); // the future bars (and the T1 inside them) never count
    expect((partial.window as { futureBarsDropped: number }).futureBarsDropped).toBeGreaterThan(0);
  });
  it("a gap before the entry, or between entry and the end, is UNVERIFIABLE (DATA_GAP) - a missing day is never read as 'not hit'", () => {
    expect(run(signal(), equity({ days: 30, base: 120, skip: [3, 4, 5, 6, 7, 8] })).primaryReason).toBe("DATA_GAP");
    expect(run(signal(), equity({ days: 30, base: 100, skip: [10, 11, 12, 13, 14, 15] })).primaryReason).toBe("DATA_GAP");
    // an ordinary weekend-sized break the exporter declares allowed is not a gap
    expect(run(signal(), equity({ days: 30, base: 100, skip: [10, 11] })).finalOutcome).toBe("EXPIRED_AFTER_ENTRY");
  });
  it("a series that ends before the validity end cannot prove 'no entry' / 'expired'", () => {
    expect(run(signal(), equity({ days: 12, base: 120 })).primaryReason).toBe("INSUFFICIENT_COVERAGE");
    expect(run(signal(), equity({ days: 12, base: 100 })).primaryReason).toBe("INSUFFICIENT_COVERAGE");
  });
  it("a stop and a target in one bar (or entry and stop in the entry bar) are ambiguous: UNVERIFIABLE by default, stop-first only when asked for", () => {
    const both = equity({ days: 30, base: 100, at: { 4: [100, 106, 94, 100] } });
    expect(run(signal(), both).primaryReason).toBe("INTRABAR_ORDER_AMBIGUOUS");
    expect(run(signal(), both, config({ intrabarPolicy: "conservative" })).finalOutcome).toBe("LOSS_SL");
    const entryBar = equity({ days: 30, base: 100, at: { 1: [100, 100, 94, 96] } });
    expect(run(signal(), entryBar).primaryReason).toBe("INTRABAR_ORDER_AMBIGUOUS");
  });
  it("the data window, series hash and resolution are recorded as evidence", () => {
    const r = run(signal(), equity({ days: 30, base: 100, at: { 4: [100, 106, 100, 105] } }));
    expect(r.window).toMatchObject({ signalTimeExclusive: T0.toISOString(), validityKind: "horizon_cap", horizonDays: 30, intervalSeconds: 86_400, gapCount: 0, intrabarPolicy: "unverifiable" });
    expect(r.evidence).toMatchObject({ resolutionSeconds: 86_400, series: { kind: "equity_price", symbol: "ACME", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(r.evidence["targetBars"]).toEqual([{ index: 1, ts: day(4), open: 100, high: 106, low: 100, close: 105 }, null, null]);
  });
  it("evaluation is deterministic: the same inputs give the identical result", () => {
    const s = equity({ days: 30, base: 100, at: { 4: [100, 111, 100, 110] } });
    expect(JSON.stringify(run(signal(), s))).toBe(JSON.stringify(run(signal(), s)));
  });
});

describe("options are evaluated on PREMIUM bars, never the underlying", () => {
  const prem = (at: Record<number, Ohlc> = {}, o: { strike?: number; type?: "CE" | "PE" } = {}): Series => seriesOf(optionSeries("NIFTY", o.strike ?? 24500, o.type ?? "CE", "2030-01-25", dailyBars({ days: 26, base: 100, at })));
  it("a CE premium reaching T1 before the stop is a WIN_T1; the same levels on a PE premium series work identically (both are buys of the premium)", () => {
    const at: Record<number, Ohlc> = { 3: [100, 121, 100, 120] };
    expect(run(optionSignal(), prem(at)).finalOutcome).toBe("WIN_T1");
    expect(run(optionSignal({ optionType: "PE" }), prem(at, { type: "PE" })).finalOutcome).toBe("WIN_T1");
  });
  it("a premium falling to the stop is LOSS_SL for both CE and PE", () => {
    const at: Record<number, Ohlc> = { 3: [100, 100, 79, 80] };
    expect(run(optionSignal(), prem(at)).finalOutcome).toBe("LOSS_SL");
    expect(run(optionSignal({ optionType: "PE" }), prem(at, { type: "PE" })).finalOutcome).toBe("LOSS_SL");
  });
  it("an option signal with only UNDERLYING data is UNVERIFIABLE (OPTION_PREMIUM_DATA_MISSING) - the premium is never inferred", () => {
    const r = evaluateOutcome(optionSignal(), config(), { series: null, underlyingAvailable: true });
    expect(r).toMatchObject({ finalOutcome: "UNVERIFIABLE", primaryReason: "OPTION_PREMIUM_DATA_MISSING" });
    const und = seriesOf(underlyingSeries("NIFTY", dailyBars({ days: 26, base: 24500, at: { 3: [24500, 25500, 24500, 25400] } })));
    expect(und.key.kind).toBe("underlying_price");
  });
  it("the contract expiry bounds the validity: expiry is the end, and a premium that never triggers the entry before it is EXPIRED_NO_ENTRY", () => {
    const r = run(optionSignal({ expiryDate: "2030-01-10" }), seriesOf(optionSeries("NIFTY", 24500, "CE", "2030-01-10", dailyBars({ days: 12, base: 150 }))));
    expect(r.finalOutcome).toBe("EXPIRED_NO_ENTRY");
  });
});
