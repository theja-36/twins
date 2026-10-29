import type { Bar, Series } from "./types";

/**
 * The outcome evaluator (Stage 4 / Task 2): PURE and deterministic (no I/O, no clock - the evaluation instant is an input). It labels one normalized historical signal against one
 * pre-exported series, using ONLY bars that start strictly after the signal time and are complete by the evaluation instant. It never guesses: whatever the evidence cannot establish is
 * UNVERIFIABLE with a machine-readable reason. Option signals are evaluated on option PREMIUM bars only - a premium is never inferred from the underlying.
 *
 * Rules (docs/twins/HISTORICAL_OUTCOME_EVALUATION.md):
 *  - priority: 1 invalid signal / unverifiable data, 2 no entry (NO_ENTRY / EXPIRED_NO_ENTRY), 3 SL before any target (LOSS_SL), 4 the highest target hit before SL (WIN_T1..T3), 5 expired after entry.
 *  - a touch is inclusive (low <= level <= high); the first-touch time is the START of the bar (the bar's resolution is recorded).
 *  - same-bar ambiguity (entry and SL / target in the entry bar, SL and a target in one bar) is UNVERIFIABLE by default (`intrabarPolicy: unverifiable`); `conservative` is an explicit option.
 *  - any gap between the signal and the decisive bar, a gap behind a "not hit" conclusion, or a series that ends before the validity end where the label needs it, is UNVERIFIABLE.
 */
export const OUTCOME_ALGORITHM_VERSION = "outcome-eval-v1";
export const FINAL_OUTCOMES = ["WIN_T1", "WIN_T2", "WIN_T3", "LOSS_SL", "NO_ENTRY", "EXPIRED_NO_ENTRY", "EXPIRED_AFTER_ENTRY", "INVALID_SIGNAL", "UNVERIFIABLE"] as const;
export type FinalOutcome = (typeof FINAL_OUTCOMES)[number];
export type EntryStatus = "ENTRY_REACHED" | "ENTRY_NOT_REACHED" | "ENTRY_INVALID" | "UNVERIFIABLE";
export type SlStatus = "SL_HIT" | "SL_NOT_HIT" | "SL_INVALID" | "UNVERIFIABLE";
export type TargetStatus = "TARGET_HIT" | "TARGET_NOT_HIT" | "TARGET_INVALID" | "UNVERIFIABLE";
export type DataQuality = "GOOD" | "DEGRADED" | "INSUFFICIENT" | "NOT_APPLICABLE";
export type IntrabarPolicy = "unverifiable" | "conservative";
export type ValidityKind = "contract_expiry" | "timeframe_intraday" | "timeframe_duration" | "horizon_cap";

export interface EvalSignal {
  side: string | null;
  instrumentType: string | null;
  underlying: string | null;
  market: string | null;
  entry: { type?: string; price?: number; low?: number; high?: number } | null;
  stopLoss: number | null;
  targets: number[];
  optionType: string | null;
  strike: number | null;
  /** YYYY-MM-DD, only when the message stated a complete valid date. */
  expiryDate: string | null;
  levelBasis: string | null;
  intent: string | null;
  timeValidity: string | null;
  /** When the signal became known: the message time, or the edit time of a revision. */
  signalTime: Date;
}
export interface EvalConfig {
  horizonDays: number;
  intrabarPolicy: IntrabarPolicy;
  /** UTC offset (minutes) for markets this code does not know; null = unknown. */
  tzOffsetMinutes: number | null;
  /** "near X" is evaluated as X +- this percentage; null = a "near" entry is UNVERIFIABLE. */
  nearTolerancePct: number | null;
  /** The instant treated as "now": a bar not complete by then is future-dated and dropped. */
  evaluatedAt: Date;
}
export const DEFAULT_EVAL_CONFIG = { horizonDays: 30, intrabarPolicy: "unverifiable" as IntrabarPolicy, tzOffsetMinutes: null, nearTolerancePct: null };

export interface SeriesInput { series: Series | null; underlyingAvailable: boolean }
export interface TargetEvaluation { index: number; price: number | null; status: TargetStatus; firstTouchAt: string | null; hitBeforeSl: boolean | null }
export interface OutcomeResult {
  finalOutcome: FinalOutcome;
  primaryReason: string | null;
  reasons: string[];
  entry: { status: EntryStatus; firstTouchAt: string | null; reachableBeforeValidityEnd: boolean | null; trigger: unknown };
  stopLoss: { status: SlStatus; price: number | null; firstTouchAt: string | null };
  targets: TargetEvaluation[];
  dataQuality: DataQuality;
  window: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

const DAY = 86_400_000;
const TZ_OF_MARKET: Record<string, number> = { NSE: 330, BSE: 330, NFO: 330, BFO: 330 };
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function localMidnightAfter(t: Date, tzMin: number, plusDays: number): Date {
  const local = t.getTime() + tzMin * 60_000;
  return new Date((Math.floor(local / DAY) + 1 + plusDays) * DAY - tzMin * 60_000);
}

function parseTimeframe(tf: string | null): { kind: "none" } | { kind: "intraday" } | { kind: "duration"; ms: number } {
  if (!tf) return { kind: "none" };
  const t = tf.toLowerCase().trim();
  if (t === "intraday") return { kind: "intraday" };
  const m = /^(\d+)\s*(min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks)$/.exec(t);
  if (!m) return { kind: "none" }; // swing / positional / btst / long-term: no precise end is stated -> the horizon cap applies
  const n = Number(m[1]);
  const u = m[2] as string;
  const unit = u.startsWith("m") ? 60_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("d") ? DAY : 7 * DAY;
  return n > 0 ? { kind: "duration", ms: n * unit } : { kind: "none" };
}

const iso = (d: Date): string => d.toISOString();
const barView = (b: Bar) => ({ ts: iso(b.ts), open: b.open, high: b.high, low: b.low, close: b.close });

export function evaluateOutcome(sig: EvalSignal, cfg: EvalConfig, data: SeriesInput): OutcomeResult {
  const R = (finalOutcome: FinalOutcome, primary: string | null, reasons: string[], over: Partial<OutcomeResult> = {}): OutcomeResult => ({
    finalOutcome, primaryReason: primary, reasons: [...new Set(reasons.length || primary === null ? reasons : [primary])], dataQuality: "NOT_APPLICABLE", window: {}, evidence: {},
    entry: { status: "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger: sig.entry }, stopLoss: { status: "UNVERIFIABLE", price: sig.stopLoss, firstTouchAt: null },
    targets: sig.targets.slice(0, 3).map((p, i) => ({ index: i + 1, price: p, status: "UNVERIFIABLE" as TargetStatus, firstTouchAt: null, hitBeforeSl: null })), ...over,
  });

  // ── 1. the signal itself ──
  const isOption = sig.instrumentType === "option";
  const long = sig.side === "buy";
  const short = sig.side === "sell";
  const bad: string[] = [];
  if (!long && !short) bad.push("MISSING_SIDE");
  const e = sig.entry;
  if (!e || e.type === undefined || e.type === "unspecified") bad.push("MISSING_ENTRY");
  if (sig.stopLoss === null) bad.push("MISSING_STOP_LOSS");
  if (sig.targets.length === 0) bad.push("MISSING_TARGETS");
  if (isOption) {
    if (sig.strike === null) bad.push("MISSING_STRIKE");
    if (sig.optionType !== "CE" && sig.optionType !== "PE") bad.push("MISSING_OPTION_TYPE");
    if (sig.expiryDate === null) bad.push("CONTRACT_EXPIRY_NOT_STATED");
    if (sig.levelBasis !== "premium") bad.push("OPTION_LEVEL_BASIS_NOT_PREMIUM");
  } else if (sig.instrumentType !== "equity") bad.push("UNSUPPORTED_INSTRUMENT");
  if (bad.length > 0) return R("INVALID_SIGNAL", bad[0] as string, bad, { entry: { status: bad.includes("MISSING_ENTRY") ? "ENTRY_INVALID" : "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger: sig.entry } });

  // an option SELL may open a short or close a long: the text does not say, so the level geometry cannot be judged either way
  if (isOption && (short || sig.intent === "unresolved")) return R("UNVERIFIABLE", "SELL_INTENT_UNRESOLVED", ["SELL_INTENT_UNRESOLVED"], { dataQuality: "INSUFFICIENT" });

  const entry = e as NonNullable<EvalSignal["entry"]>;
  const stop = sig.stopLoss as number;
  const targets = sig.targets.slice(0, 3);
  const entryType = entry.type as string;
  let lo: number | null = null, hi: number | null = null; // the entry reference range (point entries: lo === hi)
  const entryBad: string[] = [];
  if (entryType === "range") {
    if (!fin(entry.low) || !fin(entry.high) || entry.low <= 0 || entry.low > entry.high) entryBad.push("ENTRY_RANGE_INVALID");
    else { lo = entry.low; hi = entry.high; }
  } else if (entryType === "market") { lo = null; hi = null; }
  else if (["at", "above", "below", "near"].includes(entryType)) {
    if (!fin(entry.price) || entry.price <= 0) entryBad.push("ENTRY_PRICE_INVALID");
    else { lo = hi = entry.price; }
  } else entryBad.push("ENTRY_TYPE_UNSUPPORTED");
  const slBad = !fin(stop) || stop <= 0;
  const tBad = targets.map((t) => !fin(t) || t <= 0);
  const mismatch: string[] = [];
  if (!slBad && lo !== null && hi !== null) {
    if (long ? !(stop < lo) : !(stop > hi)) mismatch.push("STOP_LOSS_ON_WRONG_SIDE");
    targets.forEach((t, i) => { if (!tBad[i] && (long ? !(t > hi!) : !(t < lo!))) { tBad[i] = true; mismatch.push("TARGET_ON_WRONG_SIDE"); } });
  }
  if (!slBad && lo === null) targets.forEach((t, i) => { if (!tBad[i] && (long ? !(t > stop) : !(t < stop))) { tBad[i] = true; mismatch.push("TARGET_ON_WRONG_SIDE"); } });
  for (let i = 1; i < targets.length; i++) if (!tBad[i] && !tBad[i - 1] && (long ? !((targets[i] as number) > (targets[i - 1] as number)) : !((targets[i] as number) < (targets[i - 1] as number)))) { tBad[i] = true; mismatch.push("TARGETS_NOT_ORDERED"); }
  const slInvalid = slBad || mismatch.includes("STOP_LOSS_ON_WRONG_SIDE");
  const invalidReasons = [...entryBad, ...(slBad ? ["STOP_LOSS_INVALID"] : []), ...mismatch, ...(tBad.some((b, i) => b && !mismatch.length && fin(targets[i]) === false) ? ["TARGET_INVALID"] : [])];
  if (entryBad.length || slInvalid || tBad.some(Boolean)) {
    const reasons = invalidReasons.length ? invalidReasons : ["TARGET_INVALID"];
    return R("INVALID_SIGNAL", reasons[0] as string, reasons, {
      entry: { status: entryBad.length ? "ENTRY_INVALID" : "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger: sig.entry },
      stopLoss: { status: slInvalid ? "SL_INVALID" : "UNVERIFIABLE", price: stop, firstTouchAt: null },
      targets: targets.map((p, i) => ({ index: i + 1, price: p, status: (tBad[i] ? "TARGET_INVALID" : "UNVERIFIABLE") as TargetStatus, firstTouchAt: null, hitBeforeSl: null })),
    });
  }

  // ── 2. what the evidence can and cannot establish before looking at any bar ──
  const unver = (primary: string, reasons: string[] = [primary], extra: Partial<OutcomeResult> = {}): OutcomeResult => R("UNVERIFIABLE", primary, reasons, { dataQuality: "INSUFFICIENT", ...extra });
  if (entryType === "near" && cfg.nearTolerancePct === null) return unver("ENTRY_TRIGGER_VAGUE");

  const tz = TZ_OF_MARKET[(sig.market ?? "").toUpperCase()] ?? cfg.tzOffsetMinutes;
  const tf = parseTimeframe(sig.timeValidity);
  const horizonEnd = new Date(sig.signalTime.getTime() + cfg.horizonDays * DAY);
  let validityEnd = horizonEnd;
  let validityKind: ValidityKind = "horizon_cap";
  const consider = (end: Date, kind: ValidityKind): void => { if (end.getTime() <= validityEnd.getTime()) { validityEnd = end; validityKind = kind; } };
  if (isOption) {
    if (tz === null) return unver("MARKET_TIMEZONE_UNKNOWN");
    const [y, m, d] = (sig.expiryDate as string).split("-").map(Number) as [number, number, number];
    const expiryEnd = new Date(Date.UTC(y, m - 1, d + 1) - tz * 60_000);
    if (expiryEnd.getTime() <= sig.signalTime.getTime()) return R("INVALID_SIGNAL", "EXPIRY_BEFORE_SIGNAL", ["EXPIRY_BEFORE_SIGNAL"]);
    consider(expiryEnd, "contract_expiry");
  }
  if (tf.kind === "intraday") {
    if (tz === null) return unver("MARKET_TIMEZONE_UNKNOWN");
    consider(localMidnightAfter(sig.signalTime, tz, 0), "timeframe_intraday");
  } else if (tf.kind === "duration") consider(new Date(sig.signalTime.getTime() + tf.ms), "timeframe_duration");
  const explicitEnd = validityKind !== "horizon_cap";

  if (!data.series) return unver(isOption && data.underlyingAvailable ? "OPTION_PREMIUM_DATA_MISSING" : "NO_MARKET_DATA", [isOption && data.underlyingAvailable ? "OPTION_PREMIUM_DATA_MISSING" : "NO_MARKET_DATA"], { window: { signalTime: iso(sig.signalTime), validityEnd: iso(validityEnd), validityKind } });

  // ── 3. the data window: only bars that START after the signal and are COMPLETE by the evaluation instant and by the validity end ──
  const s = data.series;
  const stepMs = s.intervalSeconds * 1000;
  let futureDropped = 0, straddleDropped = 0;
  const bars: Bar[] = [];
  for (const b of s.bars) {
    if (b.ts.getTime() <= sig.signalTime.getTime() || b.ts.getTime() >= validityEnd.getTime()) continue;
    const end = b.ts.getTime() + stepMs;
    if (end > cfg.evaluatedAt.getTime()) { futureDropped += 1; continue; }
    if (end > validityEnd.getTime()) { straddleDropped += 1; continue; }
    bars.push(b);
  }
  const allowedMs = s.allowedGapSeconds * 1000;
  const gapBefore: boolean[] = bars.map((b, i) => (i === 0 ? b.ts.getTime() - sig.signalTime.getTime() > allowedMs : b.ts.getTime() - (bars[i - 1] as Bar).ts.getTime() > allowedMs));
  let largestGap = 0;
  bars.forEach((b, i) => { const d = i === 0 ? b.ts.getTime() - sig.signalTime.getTime() : b.ts.getTime() - (bars[i - 1] as Bar).ts.getTime(); if (gapBefore[i] && d > largestGap) largestGap = d; });
  const gapCount = gapBefore.filter(Boolean).length;
  const baseWindow = (usedTo: Bar | undefined): Record<string, unknown> => ({
    signalTimeExclusive: iso(sig.signalTime), validityEnd: iso(validityEnd), validityKind, horizonDays: cfg.horizonDays, evaluatedAt: iso(cfg.evaluatedAt), intervalSeconds: s.intervalSeconds, allowedGapSeconds: s.allowedGapSeconds,
    barsInWindow: bars.length, firstBar: bars[0] ? iso(bars[0].ts) : null, lastBarScanned: usedTo ? iso(usedTo.ts) : null, gapCount, largestGapSeconds: Math.round(largestGap / 1000), futureBarsDropped: futureDropped, straddlingBarsDropped: straddleDropped,
    intrabarPolicy: cfg.intrabarPolicy, timeframe: sig.timeValidity,
  });
  const seriesRef = { kind: s.key.kind, symbol: s.key.symbol, market: s.key.market, strike: s.key.strike, optionType: s.key.optionType, expiry: s.key.expiry, sha256: s.sha256 };
  const quality = (): DataQuality => (gapCount > 0 || futureDropped > 0 || straddleDropped > 0 ? "DEGRADED" : "GOOD");
  const cannot = (code: string, at?: Bar, extra: Partial<OutcomeResult> = {}): OutcomeResult => unver(code, [code], { window: baseWindow(at), evidence: { series: seriesRef }, ...extra });
  if (bars.length === 0) return cannot(futureDropped > 0 ? "ONLY_FUTURE_DATA" : "NO_MARKET_DATA_IN_WINDOW");

  // ── 4. entry ──
  const touchesEntry = (b: Bar): boolean => {
    const p = entry.price as number;
    switch (entryType) {
      case "at": return b.low <= p && p <= b.high;
      case "above": return b.high >= p;
      case "below": return b.low <= p;
      case "near": { const t = (cfg.nearTolerancePct as number) / 100; return b.low <= p * (1 + t) && b.high >= p * (1 - t); }
      case "range": return b.low <= (hi as number) && b.high >= (lo as number);
      default: return false;
    }
  };
  let ei = -1;
  if (entryType === "market") ei = 0;
  else for (let i = 0; i < bars.length; i++) if (touchesEntry(bars[i] as Bar)) { ei = i; break; }
  const lastBar = bars[bars.length - 1] as Bar;
  const coverageOk = validityEnd.getTime() - (lastBar.ts.getTime() + stepMs) <= allowedMs;
  const trigger = { type: entryType, price: entry.price ?? null, low: lo, high: hi };

  if (ei === -1) {
    if (gapBefore.some(Boolean)) return cannot("DATA_GAP", lastBar, { entry: { status: "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger } });
    if (!coverageOk) return cannot("INSUFFICIENT_COVERAGE", lastBar, { entry: { status: "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger } });
    return R(explicitEnd ? "EXPIRED_NO_ENTRY" : "NO_ENTRY", explicitEnd ? "ENTRY_NOT_REACHED_BEFORE_VALIDITY_END" : "ENTRY_NOT_REACHED_WITHIN_HORIZON", [explicitEnd ? "ENTRY_NOT_REACHED_BEFORE_VALIDITY_END" : "ENTRY_NOT_REACHED_WITHIN_HORIZON"], {
      entry: { status: "ENTRY_NOT_REACHED", firstTouchAt: null, reachableBeforeValidityEnd: false, trigger }, dataQuality: quality(), window: baseWindow(lastBar), evidence: { series: seriesRef },
      stopLoss: { status: "SL_NOT_HIT", price: stop, firstTouchAt: null }, targets: targets.map((p, i) => ({ index: i + 1, price: p, status: "TARGET_NOT_HIT" as TargetStatus, firstTouchAt: null, hitBeforeSl: null })),
    });
  }
  const entryBar = bars[ei] as Bar;
  const entryTouchAt = iso(entryBar.ts);
  if (gapBefore.slice(0, ei + 1).some(Boolean)) return cannot("DATA_GAP", entryBar, { entry: { status: "UNVERIFIABLE", firstTouchAt: null, reachableBeforeValidityEnd: null, trigger } });
  const entryOut = { status: "ENTRY_REACHED" as EntryStatus, firstTouchAt: entryTouchAt, reachableBeforeValidityEnd: true, trigger };
  if (entryType === "market") {
    const px = entryBar.open;
    if (long ? !(stop < px) : !(stop > px)) return R("INVALID_SIGNAL", "ACTUAL_ENTRY_CONTRADICTS_STOP_LOSS", ["ACTUAL_ENTRY_CONTRADICTS_STOP_LOSS"], { entry: entryOut, stopLoss: { status: "SL_INVALID", price: stop, firstTouchAt: null }, window: baseWindow(entryBar), evidence: { series: seriesRef, entryBar: barView(entryBar) } });
    if (targets.some((t) => (long ? !(t > px) : !(t < px)))) return R("INVALID_SIGNAL", "ACTUAL_ENTRY_CONTRADICTS_TARGET", ["ACTUAL_ENTRY_CONTRADICTS_TARGET"], { entry: entryOut, window: baseWindow(entryBar), evidence: { series: seriesRef, entryBar: barView(entryBar) } });
  }

  // ── 5. after the entry: stop-loss and targets in time order ──
  const slTouched = (b: Bar): boolean => (long ? b.low <= stop : b.high >= stop);
  const tgtTouched = (b: Bar, t: number): boolean => (long ? b.high >= t : b.low <= t);
  const hits: Array<{ i: number; bar: Bar } | null> = targets.map(() => null);
  let slBar: Bar | null = null;
  let stopped: "sl" | "targets" | "end" = "end";
  let scannedTo: Bar = entryBar;
  for (let j = ei; j < bars.length; j++) {
    const b = bars[j] as Bar;
    scannedTo = b;
    if (j > ei && gapBefore[j]) return cannot("DATA_GAP", b, { entry: entryOut });
    const sl = slTouched(b);
    const fresh = targets.map((t, k) => (hits[k] === null && tgtTouched(b, t) ? k : -1)).filter((k) => k >= 0);
    const touchEntryBar = j === ei && entryType !== "market";
    if (touchEntryBar) {
      if (sl || fresh.length) {
        if (cfg.intrabarPolicy === "unverifiable") return cannot("INTRABAR_ORDER_AMBIGUOUS", b, { entry: entryOut });
        if (sl) { slBar = b; stopped = "sl"; break; } // conservative: the stop is assumed hit after the entry; targets of the entry bar are not counted
      }
      continue;
    }
    if (sl && fresh.length) {
      if (cfg.intrabarPolicy === "unverifiable") return cannot("INTRABAR_ORDER_AMBIGUOUS", b, { entry: entryOut });
      slBar = b; stopped = "sl"; break; // conservative: the stop first
    }
    if (sl) { slBar = b; stopped = "sl"; break; }
    for (const k of fresh) hits[k] = { i: j, bar: b };
    if (hits.every((h) => h !== null)) { stopped = "targets"; break; }
  }
  if (stopped === "end") {
    const endOfScan = scannedTo.ts.getTime() + stepMs;
    if (validityEnd.getTime() - endOfScan > allowedMs) return cannot("INSUFFICIENT_COVERAGE", scannedTo, { entry: entryOut });
  }
  const highest = hits.reduce((acc, h, k) => (h ? k + 1 : acc), 0);
  const targetEvals: TargetEvaluation[] = targets.map((p, k) => {
    const h = hits[k];
    return { index: k + 1, price: p, status: h ? "TARGET_HIT" : "TARGET_NOT_HIT", firstTouchAt: h ? iso(h.bar.ts) : null, hitBeforeSl: h ? true : null };
  });
  const slOut = { status: (slBar ? "SL_HIT" : "SL_NOT_HIT") as SlStatus, price: stop, firstTouchAt: slBar ? iso(slBar.ts) : null };
  const evidence = {
    series: seriesRef, resolutionSeconds: s.intervalSeconds, note: "first-touch times are bar start times",
    entryBar: barView(entryBar), stopLossBar: slBar ? barView(slBar) : null, targetBars: hits.map((h, k) => (h ? { index: k + 1, ...barView(h.bar) } : null)),
  };
  const common = { entry: entryOut, stopLoss: slOut, targets: targetEvals, dataQuality: quality(), window: baseWindow(scannedTo), evidence };
  if (highest > 0) return R(`WIN_T${highest}` as FinalOutcome, `TARGET_${highest}_HIT_BEFORE_STOP_LOSS`, [`TARGET_${highest}_HIT_BEFORE_STOP_LOSS`, ...(sig.targets.length > 3 ? ["TARGETS_BEYOND_THIRD_NOT_EVALUATED"] : [])], common);
  if (slBar) return R("LOSS_SL", "STOP_LOSS_HIT_BEFORE_ANY_TARGET", ["STOP_LOSS_HIT_BEFORE_ANY_TARGET"], common);
  return R("EXPIRED_AFTER_ENTRY", validityKind === "horizon_cap" ? "HORIZON_REACHED_AFTER_ENTRY" : "VALIDITY_ENDED_AFTER_ENTRY", [validityKind === "horizon_cap" ? "HORIZON_REACHED_AFTER_ENTRY" : "VALIDITY_ENDED_AFTER_ENTRY"], common);
}
