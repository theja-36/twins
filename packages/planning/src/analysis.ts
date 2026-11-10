import { ZERO, dec, div, mul, str, sub, type Dec } from "./decimal";

/**
 * Stage 06 research-only analyses (M10-19 Kelly, M11-04 implied move). Pure, deterministic, exact decimals. Neither feeds sizing, risk or eligibility:
 * the outputs say `researchOnly: true` and `affectsSizing: false`, and a missing input yields a refusal, never a default.
 */
export const KELLY_ANALYSIS_VERSION = "kelly-research-v1";
export const IMPLIED_MOVE_VERSION = "implied-move-v1";

export type KellyResult =
  | { status: "OK"; version: string; researchOnly: true; affectsSizing: false; fullKellyFraction: string; halfKellyFraction: string; edgePositive: boolean; note: string }
  | { status: "REFUSED"; version: string; researchOnly: true; affectsSizing: false; reason: "WIN_RATE_INVALID" | "PAYOFF_INVALID" | "SAMPLE_TOO_SMALL"; detail: string };

/** Kelly fraction f* = p - (1-p)/b for win probability p and payoff ratio b (average win / average loss). Needs resolved real outcomes: refuses when the sample is below `minSample`. */
export function kellyAnalysis(i: { winRate: string | number; payoffRatio: string | number; sample: number; minSample?: number }): KellyResult {
  const base = { version: KELLY_ANALYSIS_VERSION, researchOnly: true as const, affectsSizing: false as const };
  const minSample = i.minSample ?? 30;
  if (!Number.isInteger(i.sample) || i.sample < minSample) return { status: "REFUSED", ...base, reason: "SAMPLE_TOO_SMALL", detail: `needs at least ${minSample} resolved outcomes` };
  let p: Dec, b: Dec;
  try { p = dec(i.winRate); } catch { return { status: "REFUSED", ...base, reason: "WIN_RATE_INVALID", detail: "win rate is not a number" }; }
  if (p <= ZERO || p >= dec(1)) return { status: "REFUSED", ...base, reason: "WIN_RATE_INVALID", detail: "win rate must be strictly between 0 and 1" };
  try { b = dec(i.payoffRatio); } catch { return { status: "REFUSED", ...base, reason: "PAYOFF_INVALID", detail: "payoff ratio is not a number" }; }
  if (b <= ZERO) return { status: "REFUSED", ...base, reason: "PAYOFF_INVALID", detail: "payoff ratio must be positive" };
  const f = sub(p, div(sub(dec(1), p), b));
  const pos = f > ZERO, full = pos ? f : ZERO;
  return { status: "OK", ...base, fullKellyFraction: str(full, 4), halfKellyFraction: str(div(full, dec(2)), 4), edgePositive: pos, note: "Research only: it never sets a position size; hard risk limits always apply." };
}

export type ImpliedMoveRefusal = "UNDERLYING_MISSING" | "STRADDLE_MISSING" | "STRADDLE_STALE" | "STRADDLE_CONTRADICTORY" | "NOT_AT_THE_MONEY";
export type ImpliedMoveResult =
  | { status: "OK"; version: string; researchOnly: true; affectsSizing: false; method: "ATM_STRADDLE"; impliedMove: string; impliedMovePct: string; upperBound: string; lowerBound: string; guaranteed: false; estimate: true; note: string }
  | { status: "REFUSED"; version: string; researchOnly: true; affectsSizing: false; reason: ImpliedMoveRefusal; detail: string };

export interface StraddleQuote { strike: string | number | null; expiry: string | null; premium: string | number | null }
/**
 * Expected move from a verified at-the-money straddle (call + put of the SAME strike and expiry, priced from a fresh quote). It is an estimate from market prices, never a guarantee, and nothing is invented:
 * a missing, stale, future-dated, non-positive, mismatched (strike or expiry) or implausible (premium above the underlying) input refuses, as does a strike further than `atmTolerancePct` from the underlying.
 */
export function impliedMove(i: { underlying: string | number | null; call: StraddleQuote | null; put: StraddleQuote | null; quoteAsOf: Date | null; now: Date; maxAgeSeconds: number; atmTolerancePct?: string | number }): ImpliedMoveResult {
  const base = { version: IMPLIED_MOVE_VERSION, researchOnly: true as const, affectsSizing: false as const };
  const no = (reason: ImpliedMoveRefusal, detail: string): ImpliedMoveResult => ({ status: "REFUSED", ...base, reason, detail });
  let u: Dec;
  try { if (i.underlying === null) throw new Error(); u = dec(i.underlying); } catch { return no("UNDERLYING_MISSING", "no valid underlying price"); }
  if (u <= ZERO) return no("UNDERLYING_MISSING", "underlying must be positive");
  if (!i.call || !i.put || i.call.strike === null || i.put.strike === null || !i.call.expiry || !i.put.expiry) return no("STRADDLE_MISSING", "an at-the-money call and put with strike and expiry are required");
  let c: Dec, p: Dec, ck: Dec, pk: Dec;
  try { if (i.call.premium === null || i.put.premium === null) throw new Error(); c = dec(i.call.premium); p = dec(i.put.premium); ck = dec(i.call.strike); pk = dec(i.put.strike); } catch { return no("STRADDLE_MISSING", "premiums and strikes must be valid numbers"); }
  if (c <= ZERO || p <= ZERO || ck <= ZERO) return no("STRADDLE_MISSING", "premiums and strikes must be positive");
  if (ck !== pk || i.call.expiry !== i.put.expiry) return no("STRADDLE_CONTRADICTORY", "the call and put must share one strike and one expiry");
  if (c >= u || p >= u) return no("STRADDLE_CONTRADICTORY", "a premium at or above the underlying price is implausible");
  if (!i.quoteAsOf || i.quoteAsOf.getTime() > i.now.getTime() || (i.now.getTime() - i.quoteAsOf.getTime()) / 1000 > i.maxAgeSeconds) return no("STRADDLE_STALE", "the straddle quote is stale or from the future");
  let tol: Dec;
  try { tol = dec(i.atmTolerancePct ?? "1"); } catch { return no("NOT_AT_THE_MONEY", "the at-the-money tolerance is invalid"); }
  const off = ck > u ? ck - u : u - ck;
  if (tol <= ZERO || off > mul(u, div(tol, dec(100)))) return no("NOT_AT_THE_MONEY", "the strike is further from the underlying than the at-the-money tolerance");
  const m = c + p;
  return { status: "OK", ...base, method: "ATM_STRADDLE", impliedMove: str(m, 2), impliedMovePct: str(mul(div(m, u), dec(100)), 2), upperBound: str(u + m, 2), lowerBound: str(sub(u, m), 2), guaranteed: false, estimate: true, note: "An estimate from market prices, not a forecast or a guarantee; it never sets a size or a limit." };
}
