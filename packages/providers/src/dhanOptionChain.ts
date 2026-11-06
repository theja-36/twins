import { OPTION_CHAIN_FORMAT, OPTION_QUOTES_FORMAT, optionQuoteProblem, parseOptionChainFile, parseOptionQuotesFile, type OptionQuote } from "@twins/agents";

/**
 * Pure converter from a Dhan option-chain API response (`POST /v2/optionchain`) to the two provider files the options-risk agent already reads (`twins-option-quotes-v1` and
 * `twins-option-chain-v1`). It makes NO network call, holds no credential and is not wired into the exporter: nothing contacts Dhan until the owner approves terms, cost, firewall and token handling.
 *
 * The response shape below is ASSUMED from Dhan's public documentation as remembered and MUST be confirmed against the official docs before any live use:
 *   { status, data: { last_price, oc: { "<strike>": { ce?: Leg, pe?: Leg } } } }  with Leg = { implied_volatility, last_price, oi, volume, top_bid_price, top_ask_price, greeks: { delta, theta, gamma, vega } }
 * Anything missing, non-numeric, non-positive where a price is required, or crossed becomes null (the agent then degrades to CAUTION instead of passing). A leg that still fails the agent's
 * own validation is skipped and listed, never published. Previous-session IV is not provided by this endpoint, so `iv_previous` is always null (the IV-change checks stay unassessed).
 */
export const DHAN_OPTION_SOURCE = "dhan-option-chain";

export class DhanChainError extends Error { constructor(readonly code: string) { super(code); this.name = "DhanChainError"; } }

export interface DhanConvertInput { market: string; underlying: string; expiry: string; asOf: Date }
export interface SkippedLeg { strike: number; optionType: "CE" | "PE"; reason: string }
export interface DhanConverted {
  quotesDoc: Record<string, unknown>;
  chainDoc: Record<string, unknown>;
  quoteCount: number;
  skipped: SkippedLeg[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A required-positive price field: zero or negative means "no market", which is null, not a price. */
const price = (v: unknown): number | null => (fin(v) && v > 0 ? v : null);
const size = (v: unknown): number | null => (fin(v) && v >= 0 ? v : null);
const greek = (v: unknown): number | null => (fin(v) ? v : null);
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

export function convertDhanOptionChain(response: unknown, input: DhanConvertInput): DhanConverted {
  if (!EXPIRY.test(input.expiry) || !/^[A-Z0-9&._-]{1,30}$/.test(input.underlying) || !/^[A-Z0-9]{2,20}$/.test(input.market)) throw new DhanChainError("bad_input");
  if (!isObj(response) || response["status"] !== "success" || !isObj(response["data"])) throw new DhanChainError("unexpected_response");
  const data = response["data"];
  const underlyingPrice = price(data["last_price"]);
  const oc = data["oc"];
  if (underlyingPrice === null || !isObj(oc) || Object.keys(oc).length === 0 || Object.keys(oc).length > 2000) throw new DhanChainError("unexpected_response");
  const asOf = input.asOf.toISOString();
  const quotes: Record<string, Record<string, unknown>> = {};
  const rows: Array<Record<string, unknown>> = [];
  const skipped: SkippedLeg[] = [];

  for (const strikeKey of Object.keys(oc).sort((a, b) => Number(a) - Number(b))) {
    const strike = Number(strikeKey);
    const strikeRow = oc[strikeKey];
    if (!Number.isFinite(strike) || strike <= 0 || !isObj(strikeRow)) { skipped.push({ strike: Number.isFinite(strike) ? strike : 0, optionType: "CE", reason: "strike" }); continue; }
    for (const [side, optionType] of [["ce", "CE"], ["pe", "PE"]] as const) {
      const leg = strikeRow[side];
      if (leg === undefined) continue;
      if (!isObj(leg)) { skipped.push({ strike, optionType, reason: "leg" }); continue; }
      const g = isObj(leg["greeks"]) ? leg["greeks"] : {};
      let bid = price(leg["top_bid_price"]), ask = price(leg["top_ask_price"]);
      if (bid !== null && ask !== null && ask < bid) { bid = null; ask = null; }
      const q: OptionQuote = {
        premium: price(leg["last_price"]), bid, ask, iv: price(leg["implied_volatility"]), ivPrevious: null,
        delta: greek(g["delta"]), gamma: size(g["gamma"]), theta: greek(g["theta"]), vega: size(g["vega"]),
        openInterest: size(leg["oi"]), volume: size(leg["volume"]), underlyingPrice, asOf,
      };
      const problem = q.premium === null ? "no_price" : optionQuoteProblem(q, optionType);
      if (problem !== null) { skipped.push({ strike, optionType, reason: problem }); continue; }
      const key = `${input.market}:${input.underlying}:${input.expiry}:${strike}:${optionType}`;
      quotes[key] = {
        premium: q.premium, bid: q.bid, ask: q.ask, iv: q.iv, iv_previous: null, delta: q.delta, gamma: q.gamma, theta: q.theta, vega: q.vega,
        open_interest: q.openInterest, volume: q.volume, underlying_price: underlyingPrice, as_of: asOf,
      };
      rows.push({ strike, option_type: optionType, iv: q.iv, open_interest: q.openInterest, volume: q.volume });
    }
  }
  if (Object.keys(quotes).length === 0) throw new DhanChainError("no_usable_legs");
  const chainKey = `${input.market}:${input.underlying}:${input.expiry}`;
  const quotesDoc = { format: OPTION_QUOTES_FORMAT, source: DHAN_OPTION_SOURCE, as_of: asOf, quotes };
  const chainDoc = { format: OPTION_CHAIN_FORMAT, source: DHAN_OPTION_SOURCE, as_of: asOf, chains: { [chainKey]: { underlying_price: underlyingPrice, as_of: asOf, rows } } };
  // Defence in depth: the agents' own strict parsers must accept exactly what would be published.
  try { parseOptionQuotesFile(JSON.parse(JSON.stringify(quotesDoc))); parseOptionChainFile(JSON.parse(JSON.stringify(chainDoc))); } catch { throw new DhanChainError("converted_document_rejected"); }
  return { quotesDoc, chainDoc, quoteCount: Object.keys(quotes).length, skipped };
}
