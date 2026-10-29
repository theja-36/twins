import { createHash } from "node:crypto";
import { MARKET_CONFIG_VERSION, type InstrumentKind, type MarketRiskConfig } from "./config";
import { assessExpiry } from "./expiry";
import { sessionStatus, type HolidayCalendar } from "./sessions";

/**
 * Pure market-risk gate engine (Stage 3 / Task 5): no I/O, no clock (the evaluation time is an input). Evaluates ONE sized, portfolio-passed decision against
 * the market session, contract expiry, event blackout windows, market-data validity and freshness, liquidity, spread and the loss circuit breakers. EVERY gate
 * is evaluated and recorded (observed value, threshold, result); the primary reason is chosen by a fixed precedence. A gate never approves anything by itself.
 */
export const MARKET_ENGINE_VERSION = "market-v1";

export const MARKET_REASONS = [
  "CIRCUIT_BREAKER_ACTIVE", "MARKET_HOLIDAY", "MARKET_CLOSED", "EXPIRED_CONTRACT", "EXPIRY_TOO_SOON", "EXPIRY_DAY_RESTRICTION", "EVENT_BLACKOUT_ACTIVE",
  "INVALID_MARKET_DATA", "STALE_MARKET_DATA", "INSUFFICIENT_LIQUIDITY", "SPREAD_TOO_WIDE",
] as const;
export type MarketReason = (typeof MARKET_REASONS)[number];
export type MarketOutcome = "PASSED" | "REJECTED" | "CONDITIONAL";

/** The market-data seam (no live provider exists; tests inject synthetic ones). */
export interface MarketSnapshot {
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  /** Options and futures only. */
  openInterest: number | null;
  /** When the data was observed. */
  timestamp: Date | string | null;
}
export interface MarketDataQuery { symbol: string; market: string; instrumentType: string; expiry: string | null; strike: number | null; optionType: string | null }
export interface MarketDataProvider {
  readonly name: string;
  /** null / a rejection means "no usable data": the evaluation fails closed and writes nothing. */
  getSnapshot(query: MarketDataQuery): Promise<MarketSnapshot | null>;
}

export interface EventWindow {
  id: string;
  /** Market code, or ALL. */
  market: string;
  scope: "MARKET" | "SYMBOL";
  scopeValue: string | null;
  startsAt: Date;
  endsAt: Date;
  severity: "WARNING" | "CRITICAL";
  reasonCode: string;
}
/** The seam for future calendar / news providers (none is called in this task). */
export interface EventWindowSource {
  listWindows(query: { market: string; symbol: string; at: Date }): Promise<EventWindow[]>;
}
export const staticEventWindows = (windows: EventWindow[]): EventWindowSource => ({ listWindows: async () => windows });

export interface MarketGateInput {
  now: Date;
  market: string | null;
  instrumentType: string;
  symbol: string;
  expiry: string | null;
  entryPrice: number | null;
  snapshot: MarketSnapshot;
  windows: EventWindow[];
  circuitBreaker: { blocked: boolean; blockedBy: string[] };
}
export interface GateFailure { reason: MarketReason; gate: string; detail: string; observed?: unknown; threshold?: unknown }
export interface MarketGateResult {
  outcome: MarketOutcome;
  reasonCode: MarketReason | null;
  conditions: string[];
  failures: GateFailure[];
  gates: Record<string, { result: "PASS" | "FAIL" | "WARN" | "SKIPPED"; observed?: unknown; threshold?: unknown; detail?: string }>;
  explanation: string;
  inputHash: string;
  snapshot: Record<string, unknown>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
export function kindOf(raw: string | null | undefined): InstrumentKind | null {
  const v = (raw ?? "").toLowerCase();
  return v === "equity" || v === "stock" ? "equity" : v === "future" || v === "futures" ? "future" : v === "option" || v === "options" ? "option" : null;
}
export function windowActive(w: EventWindow, q: { market: string; symbol: string; at: Date }): boolean {
  if (!(w.startsAt.getTime() <= q.at.getTime() && q.at.getTime() < w.endsAt.getTime())) return false;
  if (w.market.toUpperCase() !== "ALL" && w.market.toUpperCase() !== q.market.toUpperCase()) return false;
  return w.scope === "MARKET" || (w.scopeValue ?? "").toUpperCase() === q.symbol.toUpperCase();
}

export function evaluateMarketGates(input: MarketGateInput, config: MarketRiskConfig, holidays: HolidayCalendar): MarketGateResult {
  const gates: MarketGateResult["gates"] = {};
  const failures: GateFailure[] = [];
  const conditions: string[] = [];
  const fail = (f: GateFailure) => failures.push(f);
  const kind = kindOf(input.instrumentType);
  const market = (input.market ?? "").trim().toUpperCase();

  // circuit breakers
  gates["circuitBreaker"] = input.circuitBreaker.blocked ? { result: "FAIL", observed: input.circuitBreaker.blockedBy } : { result: "PASS", observed: [] };
  if (input.circuitBreaker.blocked) fail({ reason: "CIRCUIT_BREAKER_ACTIVE", gate: "circuitBreaker", detail: `loss circuit breaker open: ${input.circuitBreaker.blockedBy.join(",")}`, observed: input.circuitBreaker.blockedBy });

  // session
  const session = sessionStatus(input.now, market, config, holidays);
  gates["session"] = { result: session.state === "OPEN" ? "PASS" : "FAIL", observed: { state: session.state, market, localDate: session.localDate, localTime: session.localTime }, threshold: { opens: session.opens, closes: session.closes, timezone: session.timezone } };
  if (session.state === "HOLIDAY") fail({ reason: "MARKET_HOLIDAY", gate: "session", detail: "the local date is a market holiday", observed: session.localDate });
  else if (session.state !== "OPEN") fail({ reason: "MARKET_CLOSED", gate: "session", detail: session.state === "NO_SESSION" ? "no trading session is defined for this market" : session.state === "WEEKEND" ? "weekend" : "outside trading hours", observed: session.localTime });

  // instrument kind and expiry
  if (!kind) {
    gates["instrument"] = { result: "FAIL", observed: input.instrumentType };
    fail({ reason: "INVALID_MARKET_DATA", gate: "instrument", detail: "unsupported instrument type", observed: input.instrumentType });
  }
  const expiry = assessExpiry({ kind: kind ?? "", expiry: input.expiry, at: input.now, market }, config);
  gates["expiry"] = expiry.status === "NOT_APPLICABLE" ? { result: "SKIPPED" } : { result: expiry.status === "OK" ? (expiry.expiryDay ? "WARN" : "PASS") : "FAIL", observed: { status: expiry.status, expiry: expiry.expiry, minutesToExpiry: expiry.minutesToExpiry, expiryDay: expiry.expiryDay }, threshold: { minimumMinutes: expiry.minimumMinutes } };
  if (expiry.status === "INVALID") fail({ reason: "INVALID_MARKET_DATA", gate: "expiry", detail: "the contract expiry is missing, malformed or has no session", observed: expiry.expiry });
  else if (expiry.status === "EXPIRED") fail({ reason: "EXPIRED_CONTRACT", gate: "expiry", detail: "the contract has expired", observed: expiry.expiryInstant });
  else if (expiry.status === "TOO_SOON") fail({ reason: "EXPIRY_TOO_SOON", gate: "expiry", detail: "too close to expiry for a new approval", observed: expiry.minutesToExpiry, threshold: expiry.minimumMinutes });
  if (expiry.expiryDay && expiry.status === "OK" && config.expiryDay.block) fail({ reason: "EXPIRY_DAY_RESTRICTION", gate: "expiry", detail: "new approvals are blocked on the expiry day", observed: expiry.expiry });

  // event blackout
  const active = input.windows.filter((w) => windowActive(w, { market, symbol: input.symbol, at: input.now }));
  const critical = active.filter((w) => w.severity === "CRITICAL");
  gates["blackout"] = critical.length ? { result: "FAIL", observed: active.map((w) => ({ id: w.id, severity: w.severity, reasonCode: w.reasonCode })) } : active.length ? { result: "WARN", observed: active.map((w) => ({ id: w.id, severity: w.severity, reasonCode: w.reasonCode })) } : { result: "PASS", observed: [] };
  if (critical.length) fail({ reason: "EVENT_BLACKOUT_ACTIVE", gate: "blackout", detail: `a CRITICAL event blackout is active (${critical.map((w) => w.reasonCode).join(",")})`, observed: critical.map((w) => w.id) });
  else if (active.length) conditions.push("EVENT_BLACKOUT_WARNING");

  // market data validity (nothing below is trusted if this fails)
  const s = input.snapshot;
  const problems: string[] = [];
  const th = kind ? config.thresholds[kind] : undefined;
  const needOi = !!th && th.minOpenInterest !== null;
  for (const [name, v] of [["last", s.last], ["bid", s.bid], ["ask", s.ask]] as const) if (!finite(v) || v <= 0) problems.push(`${name}_invalid`);
  for (const [name, v] of [["bidQty", s.bidQty], ["askQty", s.askQty], ["volume", s.volume]] as const) if (!finite(v) || v < 0) problems.push(`${name}_invalid`);
  if (needOi && (!finite(s.openInterest) || s.openInterest < 0)) problems.push("openInterest_invalid");
  if (finite(s.bid) && finite(s.ask) && s.bid > 0 && s.ask > 0 && s.bid > s.ask) problems.push("crossed_market");
  const ts = s.timestamp === null ? null : new Date(s.timestamp);
  if (!ts || Number.isNaN(ts.getTime())) problems.push("timestamp_invalid");
  else if (ts.getTime() > input.now.getTime() + 5_000) problems.push("timestamp_in_future");
  if (!finite(input.entryPrice) || input.entryPrice <= 0) problems.push("entry_price_invalid");
  else if (th && finite(s.last) && s.last > 0) {
    const dev = (Math.abs(input.entryPrice - s.last) / s.last) * 100;
    if (dev > th.maxEntryDeviationPct) problems.push("entry_price_out_of_range");
  }
  gates["marketData"] = problems.length ? { result: "FAIL", observed: problems } : { result: "PASS" };
  if (problems.length) fail({ reason: "INVALID_MARKET_DATA", gate: "marketData", detail: problems.join(","), observed: problems });
  const dataOk = problems.length === 0 && !!th && !!ts;

  // freshness
  const ageSeconds = ts && !Number.isNaN(ts.getTime()) ? Math.max(0, (input.now.getTime() - ts.getTime()) / 1000) : null;
  gates["staleness"] = ageSeconds === null ? { result: "SKIPPED" } : { result: ageSeconds > config.maxDataAgeSeconds ? "FAIL" : "PASS", observed: r6(ageSeconds), threshold: config.maxDataAgeSeconds };
  if (ageSeconds !== null && ageSeconds > config.maxDataAgeSeconds) fail({ reason: "STALE_MARKET_DATA", gate: "staleness", detail: "the market data is older than the allowed age", observed: r6(ageSeconds), threshold: config.maxDataAgeSeconds });

  // liquidity and spread (only on valid data); on the expiry day the stricter thresholds apply
  if (dataOk && th && kind) {
    const mult = expiry.expiryDay ? config.expiryDay.liquidityMultiplier : 1;
    const liq = (m: number) => [
      ["bidQty", s.bidQty as number, th.minBidQty * m], ["askQty", s.askQty as number, th.minAskQty * m], ["volume", s.volume as number, th.minVolume * m],
      ...(th.minOpenInterest !== null ? [["openInterest", s.openInterest as number, th.minOpenInterest * m] as const] : []),
    ] as ReadonlyArray<readonly [string, number, number]>;
    const lowNormal = liq(1).filter(([, v, min]) => v < min);
    const lowStrict = mult > 1 ? liq(mult).filter(([, v, min]) => v < min) : [];
    gates["liquidity"] = { result: lowNormal.length ? "FAIL" : lowStrict.length ? "FAIL" : "PASS", observed: { bidQty: s.bidQty, askQty: s.askQty, volume: s.volume, openInterest: s.openInterest }, threshold: { normal: Object.fromEntries(liq(1).map(([n, , m]) => [n, m])), applied: Object.fromEntries(liq(mult).map(([n, , m]) => [n, m])), expiryDayMultiplier: mult } };
    if (lowNormal.length) fail({ reason: "INSUFFICIENT_LIQUIDITY", gate: "liquidity", detail: `below the minimum: ${lowNormal.map(([n]) => n).join(",")}`, observed: lowNormal.map(([n, v]) => ({ [n]: v })), threshold: lowNormal.map(([n, , m]) => ({ [n]: m })) });
    else if (lowStrict.length) fail({ reason: "EXPIRY_DAY_RESTRICTION", gate: "liquidity", detail: `below the stricter expiry-day minimum: ${lowStrict.map(([n]) => n).join(",")}`, observed: lowStrict.map(([n, v]) => ({ [n]: v })), threshold: lowStrict.map(([n, , m]) => ({ [n]: m })) });
    const bid = s.bid as number, ask = s.ask as number;
    const spreadPct = r6(((ask - bid) / ((ask + bid) / 2)) * 100);
    const strictMax = th.maxSpreadPct * (expiry.expiryDay ? config.expiryDay.spreadMultiplier : 1);
    gates["spread"] = { result: spreadPct > strictMax ? "FAIL" : "PASS", observed: spreadPct, threshold: { normal: th.maxSpreadPct, applied: strictMax } };
    if (spreadPct > th.maxSpreadPct) fail({ reason: "SPREAD_TOO_WIDE", gate: "spread", detail: "the bid/ask spread is wider than allowed", observed: spreadPct, threshold: th.maxSpreadPct });
    else if (spreadPct > strictMax) fail({ reason: "EXPIRY_DAY_RESTRICTION", gate: "spread", detail: "the spread is wider than the stricter expiry-day maximum", observed: spreadPct, threshold: strictMax });
  } else {
    gates["liquidity"] = { result: "SKIPPED", detail: "market data invalid" };
    gates["spread"] = { result: "SKIPPED", detail: "market data invalid" };
  }

  const primary = [...failures].sort((a, b) => MARKET_REASONS.indexOf(a.reason) - MARKET_REASONS.indexOf(b.reason))[0];
  const outcome: MarketOutcome = failures.length ? "REJECTED" : conditions.length ? "CONDITIONAL" : "PASSED";
  const explanation = outcome === "PASSED" ? "Every market gate passed: session open, contract valid, no blackout, data fresh and valid, liquidity and spread within limits."
    : outcome === "CONDITIONAL" ? `Not approval-eligible yet: ${conditions.join(", ")} (a WARNING event window is active).`
      : `Rejected: ${failures.map((f) => `${f.reason} (${f.gate}: ${f.detail})`).join("; ")}.`;
  const { source: _s, ...cfg } = config;
  void _s;
  const derived = { session: session.state, expiry: expiry.status, expiryDay: expiry.expiryDay, windows: active.map((w) => w.id).sort(), stale: ageSeconds !== null && ageSeconds > config.maxDataAgeSeconds, outcome, reason: primary?.reason ?? null };
  const inputHash = createHash("sha256").update(JSON.stringify({ engine: MARKET_ENGINE_VERSION, config: cfg, market, instrumentType: input.instrumentType, symbol: input.symbol, expiry: input.expiry, entryPrice: input.entryPrice, snapshot: input.snapshot, circuitBreaker: input.circuitBreaker, derived })).digest("hex");
  return {
    outcome, reasonCode: primary?.reason ?? null, conditions, failures, gates, explanation, inputHash,
    snapshot: {
      engineVersion: MARKET_ENGINE_VERSION, configVersion: MARKET_CONFIG_VERSION, outcome, reasonCode: primary?.reason ?? null, conditions, failures, gates, explanation, inputHash,
      evaluatedAt: input.now.toISOString(), market, instrumentType: input.instrumentType, symbol: input.symbol, expiry: input.expiry, entryPrice: input.entryPrice,
      observed: { snapshot: input.snapshot, ageSeconds: ageSeconds === null ? null : r6(ageSeconds), session, expiry }, thresholds: { ...(th ?? {}), maxDataAgeSeconds: config.maxDataAgeSeconds, minMinutesToExpiry: config.minMinutesToExpiry, expiryDay: config.expiryDay },
      activeWindows: active.map((w) => ({ id: w.id, severity: w.severity, scope: w.scope, scopeValue: w.scopeValue, reasonCode: w.reasonCode, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
    },
  };
}
