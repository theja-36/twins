import { createHash } from "node:crypto";
import { PORTFOLIO_CONFIG_VERSION, type PortfolioConfig } from "./config";

/**
 * Pure portfolio open-risk engine (Stage 3 / Task 3): no I/O, no clock. Evaluates ONE candidate (a sized risk decision) against the active exposure:
 * PENDING and APPROVED_FOR_REVIEW risk decisions plus any open-position exposure from a later stage. Rejected/expired/superseded decisions are not
 * active and never reach this function. Exposure is GROSS: opposing directions do not net (a long and a short on the same underlying both add risk).
 */
export const PORTFOLIO_ENGINE_VERSION = "portfolio-v1";

export const PORTFOLIO_REASONS = [
  "PORTFOLIO_RISK_LIMIT_EXCEEDED", "MARKET_RISK_LIMIT_EXCEEDED", "CORRELATION_GROUP_LIMIT_EXCEEDED",
  "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED", "MAX_ACTIVE_DECISIONS_EXCEEDED",
] as const;
export type PortfolioReason = (typeof PORTFOLIO_REASONS)[number];
export type PortfolioOutcome = "APPROVED_FOR_REVIEW" | "REJECTED" | "INVALID_INPUT";

export interface ExposureInput {
  id: string;
  source: "risk_decision" | "open_position";
  /** Planned (or open) maximum loss in currency. */
  maxLossAmount: number;
  market: string | null;
  instrumentType: string;
  /** The underlying symbol (equity, futures and options on the same underlying are related exposure). */
  underlying: string;
  /** BUY | SELL | LONG | SHORT (any case). */
  side: string | null;
  expiry: string | null;
}

export interface Exposure extends ExposureInput {
  maxLossPercent: number;
  direction: "LONG" | "SHORT" | "UNKNOWN";
  correlationGroup: string;
  /** underlying|expiry; null when there is no expiry. */
  expiryKey: string | null;
}

export interface Bucket { amount: number; pct: number; count: number }
export interface LimitFailure { reason: PortfolioReason; scope: "total" | "market" | "group" | "underlying" | "expiry"; key: string; kind: "risk" | "count" | "risk_amount"; limit: number; resulting: number }

export interface PortfolioResult {
  outcome: PortfolioOutcome;
  /** APPROVED_FOR_REVIEW: null. REJECTED: the first failing reason in fixed precedence. INVALID_INPUT: an input code. */
  reasonCode: PortfolioReason | string | null;
  explanation: string;
  failures: LimitFailure[];
  candidate: Exposure | null;
  current: Record<string, Bucket>;
  proposed: Bucket;
  resulting: Record<string, Bucket>;
  limits: Record<string, number | null>;
  activeCount: number;
  inputHash: string;
  snapshot: Record<string, unknown>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (v: number, dp = 6): number => Math.round(v * 10 ** dp) / 10 ** dp;
const EPS = 1e-6;

export function directionOf(side: string | null): "LONG" | "SHORT" | "UNKNOWN" {
  const s = (side ?? "").toUpperCase();
  return s === "BUY" || s === "LONG" ? "LONG" : s === "SELL" || s === "SHORT" ? "SHORT" : "UNKNOWN";
}

/** The correlation group of an underlying: its configured group, else the underlying itself. */
export function correlationGroupOf(underlying: string, config: PortfolioConfig): string {
  const u = underlying.toUpperCase();
  for (const [name, members] of Object.entries(config.correlationGroups)) if (members.includes(u)) return name;
  return `UNDERLYING:${u}`;
}

export function toExposure(input: ExposureInput, capital: number, config: PortfolioConfig): Exposure {
  const underlying = input.underlying.trim().toUpperCase();
  const expiry = input.expiry ?? null;
  return {
    ...input, underlying, market: input.market === null ? null : input.market.trim().toUpperCase(), maxLossPercent: round((input.maxLossAmount * 100) / capital),
    direction: directionOf(input.side), correlationGroup: correlationGroupOf(underlying, config), expiryKey: expiry ? `${underlying}|${expiry}` : null,
  };
}

const limitsOf = (c: PortfolioConfig, capital: number): Record<string, number | null> => ({
  totalRiskAmount: round((capital * c.maxTotalRiskPct) / 100, 4), totalRiskAmountCap: c.maxTotalRiskAmount, marketRiskAmount: round((capital * c.maxMarketRiskPct) / 100, 4),
  groupRiskAmount: round((capital * c.maxGroupRiskPct) / 100, 4), underlyingRiskAmount: round((capital * c.maxUnderlyingRiskPct) / 100, 4), expiryRiskAmount: round((capital * c.maxExpiryRiskPct) / 100, 4),
  maxActive: c.maxActive, maxActivePerGroup: c.maxActivePerGroup, maxActivePerUnderlying: c.maxActivePerUnderlying, maxActivePerExpiry: c.maxActivePerExpiry,
});

export function hashPortfolioInput(capital: number | null, candidate: ExposureInput | null, active: ExposureInput[], config: PortfolioConfig): string {
  const { source: _s, ...cfg } = config;
  void _s;
  const act = [...active].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ engine: PORTFOLIO_ENGINE_VERSION, configVersion: PORTFOLIO_CONFIG_VERSION, config: cfg, capital, candidate: candidate ? { ...candidate, id: undefined } : null, active: act })).digest("hex"); // the candidate's own row id changes with every version, its exposure does not
}

const bucketOf = (items: Exposure[], capital: number): Bucket => {
  const amount = items.reduce((s, e) => s + e.maxLossAmount, 0);
  return { amount: round(amount, 4), pct: round((amount * 100) / capital), count: items.length };
};

export function evaluatePortfolio(args: { capital: number | null; candidate: ExposureInput | null; active: ExposureInput[]; config: PortfolioConfig }): PortfolioResult {
  const { config } = args;
  const inputHash = hashPortfolioInput(args.capital, args.candidate, args.active, config);
  const empty: Bucket = { amount: 0, pct: 0, count: 0 };
  const done = (outcome: PortfolioOutcome, reasonCode: string | null, explanation: string, o: Partial<PortfolioResult> = {}): PortfolioResult => {
    const r: PortfolioResult = { outcome, reasonCode, explanation, failures: [], candidate: null, current: {}, proposed: empty, resulting: {}, limits: {}, activeCount: args.active.length, inputHash, snapshot: {}, ...o };
    r.snapshot = {
      engineVersion: PORTFOLIO_ENGINE_VERSION, configVersion: PORTFOLIO_CONFIG_VERSION, outcome, reasonCode, explanation, failures: r.failures, candidate: r.candidate, current: r.current, proposed: r.proposed, resulting: r.resulting,
      limits: r.limits, activeCount: r.activeCount, activeExposures: args.active.map((a) => ({ id: a.id, source: a.source, maxLossAmount: a.maxLossAmount, underlying: a.underlying, market: a.market, expiry: a.expiry })), inputHash,
    };
    return r;
  };
  const invalid = (code: string, text: string) => done("INVALID_INPUT", code, text);

  const capital = args.capital;
  if (!finite(capital) || capital <= 0) return invalid("portfolio_capital_invalid", "Available capital is missing or not positive; the portfolio is not evaluated.");
  const c = args.candidate;
  if (!c || !finite(c.maxLossAmount) || c.maxLossAmount <= 0) return invalid("portfolio_sizing_missing", "The candidate has no planned maximum loss (it is not sized); the portfolio is not evaluated.");
  if (!c.underlying?.trim()) return invalid("portfolio_underlying_missing", "The candidate has no underlying symbol.");
  if (!c.market?.trim()) return invalid("portfolio_market_missing", "The candidate has no market.");
  if (directionOf(c.side) === "UNKNOWN") return invalid("portfolio_direction_invalid", "The candidate direction is not BUY/SELL/LONG/SHORT.");
  for (const a of args.active) if (!finite(a.maxLossAmount) || a.maxLossAmount < 0 || !a.underlying?.trim()) return invalid("portfolio_active_exposure_invalid", `Active exposure ${a.id} is malformed; the portfolio is not evaluated.`);

  const cand = toExposure(c, capital, config);
  const act = args.active.map((a) => toExposure(a, capital, config));
  const limits = limitsOf(config, capital);
  const mk = cand.market ?? "UNKNOWN";
  const sel = {
    total: act,
    market: act.filter((e) => (e.market ?? "UNKNOWN") === mk),
    group: act.filter((e) => e.correlationGroup === cand.correlationGroup),
    underlying: act.filter((e) => e.underlying === cand.underlying),
    expiry: cand.expiryKey ? act.filter((e) => e.expiryKey === cand.expiryKey) : [],
  };
  const keys = { total: "PORTFOLIO", market: mk, group: cand.correlationGroup, underlying: cand.underlying, expiry: cand.expiryKey ?? "" };
  const current: Record<string, Bucket> = { total: bucketOf(sel.total, capital), market: bucketOf(sel.market, capital), group: bucketOf(sel.group, capital), underlying: bucketOf(sel.underlying, capital), expiry: bucketOf(sel.expiry, capital) };
  const proposed: Bucket = { amount: round(cand.maxLossAmount, 4), pct: cand.maxLossPercent, count: 1 };
  const resulting: Record<string, Bucket> = {};
  for (const k of Object.keys(current) as Array<keyof typeof current>) {
    const cur = current[k] as Bucket;
    resulting[k] = { amount: round(cur.amount + proposed.amount, 4), pct: round(((cur.amount + proposed.amount) * 100) / capital), count: cur.count + 1 };
  }
  // an expiry bucket exists only for a candidate with an expiry
  if (!cand.expiryKey) { current["expiry"] = empty; resulting["expiry"] = empty; }

  const failures: LimitFailure[] = [];
  const risk = (scope: LimitFailure["scope"], reason: PortfolioReason, limit: number, kind: LimitFailure["kind"] = "risk") => {
    const r = (resulting[scope] as Bucket).amount;
    if (r > limit + EPS) failures.push({ reason, scope, key: keys[scope], kind, limit, resulting: r });
  };
  const cnt = (scope: LimitFailure["scope"], reason: PortfolioReason, limit: number) => {
    const r = (resulting[scope] as Bucket).count;
    if (r > limit) failures.push({ reason, scope, key: keys[scope], kind: "count", limit, resulting: r });
  };
  risk("total", "PORTFOLIO_RISK_LIMIT_EXCEEDED", limits["totalRiskAmount"] as number);
  if (config.maxTotalRiskAmount !== null) risk("total", "PORTFOLIO_RISK_LIMIT_EXCEEDED", config.maxTotalRiskAmount, "risk_amount");
  risk("market", "MARKET_RISK_LIMIT_EXCEEDED", limits["marketRiskAmount"] as number);
  risk("group", "CORRELATION_GROUP_LIMIT_EXCEEDED", limits["groupRiskAmount"] as number);
  cnt("group", "CORRELATION_GROUP_LIMIT_EXCEEDED", config.maxActivePerGroup);
  risk("underlying", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED", limits["underlyingRiskAmount"] as number);
  cnt("underlying", "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED", config.maxActivePerUnderlying);
  if (cand.expiryKey) {
    risk("expiry", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED", limits["expiryRiskAmount"] as number);
    cnt("expiry", "CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED", config.maxActivePerExpiry);
  }
  cnt("total", "MAX_ACTIVE_DECISIONS_EXCEEDED", config.maxActive);

  const base = { candidate: cand, current, proposed, resulting, limits, failures };
  if (failures.length === 0) return done("APPROVED_FOR_REVIEW", null, `Within every portfolio limit: total planned risk would be ${(resulting["total"] as Bucket).pct}% of capital over ${(resulting["total"] as Bucket).count} active decision(s).`, base);
  const first = [...failures].sort((a, b) => PORTFOLIO_REASONS.indexOf(a.reason) - PORTFOLIO_REASONS.indexOf(b.reason))[0] as LimitFailure;
  return done("REJECTED", first.reason, `Rejected: ${failures.map((f) => `${f.reason} (${f.scope} ${f.key}: ${f.kind} ${f.resulting} > ${f.limit})`).join("; ")}.`, base);
}
