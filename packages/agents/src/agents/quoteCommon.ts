import { AgentUnavailableError } from "../contract";
import type { Collector } from "./common";
import type { QuoteInstrumentType, QuoteQuery } from "./quoteProviders";
import type { AgentRulesConfig } from "./rules";

/** Shared helpers of the Liquidity and Options Risk agents. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const spreadPct = (bid: number, ask: number): number => ((ask - bid) / ((ask + bid) / 2)) * 100;
export type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null; strike?: number | null; expiry?: string | null; entryPrice?: number | null; stopLoss?: number | null };

/** The quote query for a risk decision, or null when the contract is not fully specified (an option needs expiry, strike and CE/PE; a future needs an expiry). */
export function quoteQuery(rd: Rd): QuoteQuery | null {
  const type = (rd.instrumentType ?? "").toLowerCase();
  if (type !== "equity" && type !== "future" && type !== "option") return null;
  const market = (rd.market ?? "").trim().toUpperCase(), symbol = (rd.symbol ?? "").trim().toUpperCase();
  if (!market || !symbol || symbol === "UNKNOWN") return null;
  const expiry = typeof rd.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rd.expiry) ? rd.expiry : null;
  const strike = typeof rd.strike === "number" && Number.isFinite(rd.strike) && rd.strike > 0 ? rd.strike : null;
  const optionType = rd.optionType === "CE" || rd.optionType === "PE" ? rd.optionType : null;
  if (type === "equity") return { market, symbol, instrumentType: type as QuoteInstrumentType, expiry: null, strike: null, optionType: null };
  if (expiry === null) return null;
  if (type === "future") return { market, symbol, instrumentType: "future", expiry, strike: null, optionType: null };
  if (strike === null || optionType === null) return null;
  return { market, symbol, instrumentType: "option", expiry, strike, optionType };
}
/** Age of a snapshot in minutes. Too old / future-dated -> UNAVAILABLE; older than the caution limit -> a CAUTION finding. */
export function checkAge(rules: AgentRulesConfig, asOf: string, nowMs: number, c: Collector, what: string, code: string): number {
  const q = rules.quotes;
  const age = (nowMs - Date.parse(asOf)) / 60_000;
  if (Number.isNaN(age)) throw new AgentUnavailableError(`${code}_MALFORMED`, `the ${what} carries no usable time`);
  if (age < -q.futureToleranceMinutes) throw new AgentUnavailableError(`${code}_FROM_FUTURE`, `the ${what} is dated in the future`);
  if (age > q.unavailableMinutes) throw new AgentUnavailableError(`${code}_TOO_OLD`, `the ${what} is too old to describe current conditions`);
  c.check();
  if (age > q.staleCautionMinutes) c.add("CAUTION", `${code}_STALE`, `The ${what} is ${Math.round(age)} minutes old.`, { ageMinutes: Math.round(age) });
  return Math.max(0, Math.round(age));
}
