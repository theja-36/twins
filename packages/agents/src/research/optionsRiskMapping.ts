import type { AgentRunResult } from "../contract";
import type { ResearchCandidate } from "./candidateInput";
import { EXTRA_SPECIALIST_SUPPLEMENTS, type SpecRole } from "./specMapping";

/**
 * Options-risk mapping (A13, `options-risk-mapping-v1`). A PURE, deterministic description of how an option candidate maps onto its underlying, its contract facts and its risk context, built to sit beside the
 * existing `options-risk-v1` specialist (which it preserves and never replaces). It validates and labels; it never prices, never computes Greeks, never defaults a lot or tick size, and never lets a model
 * decide anything: a value that is not supplied is MISSING, a stale one STALE, a disagreeing one CONTRADICTORY, a provider-listed or synthetic one UNVERIFIED. An unsafe or unsupported mapping is REFUSED with reason codes.
 * It is evidence for the research package, not a decision, a size or an approval.
 */
export const OPTIONS_RISK_MAPPING_VERSION = "options-risk-mapping-v1";
export const OPTIONS_RISK_CATEGORY = "OPTIONS_MARKET_LIQUIDITY_RISK";
/** `options-risk-v1` is outside the twelve roles; it SUPPLEMENTS these two (market and liquidity risk) and replaces neither. */
export const OPTIONS_RISK_SUPPLEMENTS: readonly SpecRole[] = EXTRA_SPECIALIST_SUPPLEMENTS["options-risk-v1"] ?? [];

/** The contract facts the mapping needs. Structurally identical to the canonical contract record (`@twins/signals`), so a canonical record can be passed as is; nothing is imported from it. */
export interface ContractFacts {
  canonicalId: string; exchange: string; underlying: string; expiryDate: string; strike: string | null; optionType: "CE" | "PE" | null;
  lotSize: number; tickSize: string | null; tickSizeUnit: string; effectiveFrom: string; effectiveTo: string | null;
  validation: "EXCHANGE_VERIFIED" | "MANUAL_VERIFIED" | "PROVIDER_LISTED" | "SYNTHETIC" | "UNVERIFIED"; provenance: { source: string; retrievedAt: string };
}
export type DataStatus = "OK" | "MISSING" | "STALE" | "CONTRADICTORY" | "UNVERIFIED";
export type MappingStatus = "NOT_APPLICABLE" | "MAPPED_VERIFIED" | "MAPPED_UNVERIFIED" | "REFUSED";
export type MappingReason =
  | "NOT_AN_OPTION" | "UNDERLYING_MISSING" | "EXCHANGE_MISSING" | "EXPIRY_MISSING" | "EXPIRY_INVALID" | "STRIKE_MISSING" | "STRIKE_INVALID" | "OPTION_TYPE_MISSING" | "OPTION_EXPIRED"
  | "UNDERLYING_UNSUPPORTED" | "CONTRACT_MASTER_UNAVAILABLE" | "CONTRACT_MISMATCH" | "CONTRACT_NOT_IN_FORCE" | "CONTRACT_LOT_SIZE_INVALID" | "CONTRACT_PROVIDER_LISTED_ONLY" | "CONTRACT_SYNTHETIC" | "CONTRACT_UNVERIFIED"
  | "TICK_SIZE_MISSING" | "PRICE_OFF_TICK_GRID" | "UNDERLYING_PRICE_MISSING" | "UNDERLYING_PRICE_STALE" | "UNDERLYING_PRICE_FUTURE_DATED" | "OPTION_QUOTE_MISSING" | "OPTION_QUOTE_STALE" | "OPTION_QUOTE_FUTURE_DATED" | "GREEKS_NOT_SUPPLIED";
export interface TimedValue { asOf: string | null }
export interface OptionsRiskMapping {
  mappingVersion: typeof OPTIONS_RISK_MAPPING_VERSION; status: MappingStatus; category: typeof OPTIONS_RISK_CATEGORY; supplementsRoles: SpecRole[];
  asOf: string; reasons: MappingReason[];
  underlying: { exchange: string | null; symbol: string | null; supported: boolean | null };
  contract: { expiry: string | null; strike: number | null; optionType: "CE" | "PE" | null; canonicalId: string | null; validation: ContractFacts["validation"] | null; lotSize: number | null; tickSize: string | null; tickSizeUnit: string | null; source: string | null };
  elements: Record<"identity" | "expiry" | "strike" | "optionType" | "lotSize" | "tickSize" | "underlyingPrice" | "optionQuote" | "greeks", DataStatus>;
  tickAlignment: { checked: boolean; offGrid: string[] };
}
export interface MappingInput {
  candidate: Pick<ResearchCandidate, "underlying" | "exchange" | "strike" | "optionType" | "expiry" | "entryLow" | "entryHigh" | "stopLoss" | "targets">;
  /** The orchestrator's clock; the mapping never reads the system clock. */
  now: Date;
  /** The contract in force for the claimed contract, or null when no master is configured. */
  contract?: ContractFacts | null;
  supportedUnderlyings?: readonly string[] | null;
  underlyingQuote?: TimedValue | null; optionQuote?: (TimedValue & { greeks?: unknown }) | null;
  maxQuoteAgeMs?: number; futureToleranceMs?: number;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => { if (!DATE.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; };

/** Whether `price` sits on the `tick` grid, by exact decimal arithmetic (never floats). null when it cannot be decided (a malformed decimal). */
export function onTickGrid(price: number, tick: string): boolean | null {
  const p = String(price), dec = (t: string): number => (t.includes(".") ? t.split(".")[1]!.length : 0);
  if (!/^\d+(\.\d+)?$/.test(p) || !/^\d+(\.\d+)?$/.test(tick)) return null;
  const d = Math.max(dec(p), dec(tick)), scale = (t: string): bigint => BigInt(t.replace(".", "") + "0".repeat(d - dec(t)));
  const tk = scale(tick); if (tk === 0n) return null;
  return scale(p) % tk === 0n;
}
function fresh(q: TimedValue | null | undefined, now: Date, maxAge: number, tol: number): "MISSING" | "STALE" | "FUTURE" | "OK" {
  if (!q || q.asOf === null || !Number.isFinite(Date.parse(q.asOf))) return "MISSING";
  const age = now.getTime() - Date.parse(q.asOf);
  return age < -tol ? "FUTURE" : age > maxAge ? "STALE" : "OK";
}

export function mapOptionsRisk(i: MappingInput): OptionsRiskMapping {
  const c = i.candidate, now = i.now, reasons = new Set<MappingReason>();
  const nowDate = now.toISOString().slice(0, 10), maxAge = i.maxQuoteAgeMs ?? 15 * 60_000, tol = i.futureToleranceMs ?? 120_000;
  const out: OptionsRiskMapping = {
    mappingVersion: OPTIONS_RISK_MAPPING_VERSION, status: "MAPPED_UNVERIFIED", category: OPTIONS_RISK_CATEGORY, supplementsRoles: [...OPTIONS_RISK_SUPPLEMENTS], asOf: now.toISOString(), reasons: [],
    underlying: { exchange: c.exchange?.trim() || null, symbol: c.underlying?.trim().toUpperCase() || null, supported: null },
    contract: { expiry: c.expiry, strike: c.strike, optionType: c.optionType, canonicalId: null, validation: null, lotSize: null, tickSize: null, tickSizeUnit: null, source: null },
    elements: { identity: "MISSING", expiry: "MISSING", strike: "MISSING", optionType: "MISSING", lotSize: "MISSING", tickSize: "MISSING", underlyingPrice: "MISSING", optionQuote: "MISSING", greeks: "MISSING" },
    tickAlignment: { checked: false, offGrid: [] },
  };
  const finish = (status: MappingStatus): OptionsRiskMapping => { out.status = status; out.reasons = [...reasons].sort(); return out; };
  if (c.strike === null && c.optionType === null) { reasons.add("NOT_AN_OPTION"); return finish("NOT_APPLICABLE"); }

  // identity of the claimed contract: each missing or invalid part is named; nothing is inferred
  if (!out.underlying.symbol || out.underlying.symbol === "UNKNOWN") reasons.add("UNDERLYING_MISSING");
  if (!out.underlying.exchange) reasons.add("EXCHANGE_MISSING");
  if (c.expiry === null) reasons.add("EXPIRY_MISSING"); else if (!validDate(c.expiry)) { reasons.add("EXPIRY_INVALID"); out.elements.expiry = "CONTRADICTORY"; } else out.elements.expiry = "OK";
  if (c.strike === null) reasons.add("STRIKE_MISSING"); else if (!(Number.isFinite(c.strike) && c.strike > 0)) { reasons.add("STRIKE_INVALID"); out.elements.strike = "CONTRADICTORY"; } else out.elements.strike = "OK";
  if (c.optionType === null) reasons.add("OPTION_TYPE_MISSING"); else out.elements.optionType = "OK";
  if (c.expiry !== null && validDate(c.expiry) && c.expiry < nowDate) { reasons.add("OPTION_EXPIRED"); out.elements.expiry = "STALE"; }
  if (i.supportedUnderlyings && out.underlying.symbol) { out.underlying.supported = i.supportedUnderlyings.includes(out.underlying.symbol); if (!out.underlying.supported) reasons.add("UNDERLYING_UNSUPPORTED"); }
  const identityOk = out.underlying.symbol !== null && out.underlying.symbol !== "UNKNOWN" && !!out.underlying.exchange && out.elements.expiry === "OK" && out.elements.strike === "OK" && out.elements.optionType === "OK";
  out.elements.identity = identityOk ? "OK" : "MISSING";

  // contract master: lot and tick size come ONLY from a verified or provider-listed record, and the record must describe THIS contract and be in force
  const k = i.contract ?? null;
  if (k === null) reasons.add("CONTRACT_MASTER_UNAVAILABLE");
  else {
    out.contract = { ...out.contract, canonicalId: k.canonicalId, validation: k.validation, lotSize: k.lotSize, tickSize: k.tickSize, tickSizeUnit: k.tickSizeUnit, source: k.provenance.source };
    const same = k.underlying === out.underlying.symbol && k.expiryDate === c.expiry && k.optionType === c.optionType && k.strike !== null && c.strike !== null && Number(k.strike) === c.strike && k.exchange === out.underlying.exchange;
    if (!same) { reasons.add("CONTRACT_MISMATCH"); out.elements.identity = "CONTRADICTORY"; out.contract = { ...out.contract, lotSize: null, tickSize: null, tickSizeUnit: null }; }
    else if (!(k.effectiveFrom <= nowDate && (k.effectiveTo === null || nowDate < k.effectiveTo))) { reasons.add("CONTRACT_NOT_IN_FORCE"); out.elements.identity = "STALE"; out.contract = { ...out.contract, lotSize: null, tickSize: null, tickSizeUnit: null }; }
    else {
      if (!Number.isInteger(k.lotSize) || k.lotSize < 1) { reasons.add("CONTRACT_LOT_SIZE_INVALID"); out.contract.lotSize = null; } else out.elements.lotSize = k.validation === "EXCHANGE_VERIFIED" || k.validation === "MANUAL_VERIFIED" ? "OK" : "UNVERIFIED";
      if (k.tickSize === null) { reasons.add("TICK_SIZE_MISSING"); } else out.elements.tickSize = k.validation === "EXCHANGE_VERIFIED" || k.validation === "MANUAL_VERIFIED" ? "OK" : "UNVERIFIED";
      if (k.validation === "PROVIDER_LISTED") reasons.add("CONTRACT_PROVIDER_LISTED_ONLY"); else if (k.validation === "SYNTHETIC") reasons.add("CONTRACT_SYNTHETIC"); else if (k.validation === "UNVERIFIED") reasons.add("CONTRACT_UNVERIFIED");
    }
  }
  // prices on the tick grid (only when a tick size is known; a misaligned price is flagged, never "corrected")
  if (out.contract.tickSize !== null && out.elements.tickSize !== "MISSING") {
    out.tickAlignment.checked = true;
    const levels: Array<[string, number | null]> = [["entryLow", c.entryLow], ["entryHigh", c.entryHigh], ["stopLoss", c.stopLoss], ...c.targets.map((t, n) => [`target${n + 1}`, t] as [string, number])];
    for (const [name, v] of levels) if (v !== null && onTickGrid(v, out.contract.tickSize) === false) out.tickAlignment.offGrid.push(name);
    if (out.tickAlignment.offGrid.length > 0) reasons.add("PRICE_OFF_TICK_GRID");
  }
  // market data behind the risk assessment: labelled, never filled in
  for (const [name, q, el, codes] of [["underlying", i.underlyingQuote, "underlyingPrice", ["UNDERLYING_PRICE_MISSING", "UNDERLYING_PRICE_STALE", "UNDERLYING_PRICE_FUTURE_DATED"]], ["option", i.optionQuote, "optionQuote", ["OPTION_QUOTE_MISSING", "OPTION_QUOTE_STALE", "OPTION_QUOTE_FUTURE_DATED"]]] as const) {
    void name; const f = fresh(q, now, maxAge, tol);
    out.elements[el] = f === "OK" ? "OK" : f === "MISSING" ? "MISSING" : f === "STALE" ? "STALE" : "CONTRADICTORY";
    if (f !== "OK") reasons.add((codes[f === "MISSING" ? 0 : f === "STALE" ? 1 : 2]) as MappingReason);
  }
  out.elements.greeks = i.optionQuote?.greeks && typeof i.optionQuote.greeks === "object" ? "OK" : "MISSING";
  if (out.elements.greeks === "MISSING") reasons.add("GREEKS_NOT_SUPPLIED");

  const refused: MappingReason[] = ["UNDERLYING_MISSING", "EXCHANGE_MISSING", "EXPIRY_MISSING", "EXPIRY_INVALID", "STRIKE_MISSING", "STRIKE_INVALID", "OPTION_TYPE_MISSING", "OPTION_EXPIRED", "UNDERLYING_UNSUPPORTED", "CONTRACT_MISMATCH", "CONTRACT_NOT_IN_FORCE", "CONTRACT_LOT_SIZE_INVALID"];
  if (refused.some((r) => reasons.has(r))) return finish("REFUSED");
  const verified = k !== null && (k.validation === "EXCHANGE_VERIFIED" || k.validation === "MANUAL_VERIFIED") && out.elements.lotSize === "OK" && out.elements.tickSize === "OK";
  return finish(verified ? "MAPPED_VERIFIED" : "MAPPED_UNVERIFIED");
}

/** How the findings of `options-risk-v1` group into market risk, liquidity risk and contract risk, for the package and the future screens. Unknown codes are reported as UNCLASSIFIED, never dropped. */
export const OPTIONS_FINDING_CATEGORY: Readonly<Record<string, "MARKET_RISK" | "LIQUIDITY_RISK" | "CONTRACT_RISK">> = {
  EXPIRY_IMMINENT: "MARKET_RISK", EXPIRY_WITHIN_DAY: "MARKET_RISK", EXPIRY_NEAR: "MARKET_RISK", EXPIRY_DISTANT: "MARKET_RISK",
  IV_EXTREME: "MARKET_RISK", IV_HIGH: "MARKET_RISK", IV_ELEVATED: "MARKET_RISK", IV_SPIKE_EXTREME: "MARKET_RISK", IV_SPIKE: "MARKET_RISK", IV_RISING: "MARKET_RISK", IV_ABOVE_ATM: "MARKET_RISK", IV_MISSING: "MARKET_RISK",
  THETA_DECAY_EXTREME: "MARKET_RISK", THETA_DECAY_HIGH: "MARKET_RISK", THETA_DECAY_MODERATE: "MARKET_RISK", THETA_DECAY_FOR_SELLER: "MARKET_RISK",
  GAMMA_RISK_EXTREME: "MARKET_RISK", GAMMA_RISK_HIGH: "MARKET_RISK", GAMMA_RISK_MODERATE: "MARKET_RISK", GAMMA_OUTSIDE_WINDOW: "MARKET_RISK", VEGA_EXPOSURE: "MARKET_RISK", DELTA_HIGH: "MARKET_RISK", DELTA_LOW: "MARKET_RISK", GREEKS_INCOMPLETE: "MARKET_RISK",
  PREMIUM_BELOW_INTRINSIC: "MARKET_RISK", PREMIUM_VERY_LOW: "MARKET_RISK", PREMIUM_THROUGH_STOP: "MARKET_RISK", ENTRY_FAR_FROM_QUOTE: "MARKET_RISK", ENTRY_AWAY_FROM_QUOTE: "MARKET_RISK",
  STRIKE_DEEP_ITM: "MARKET_RISK", STRIKE_FAR_OTM: "MARKET_RISK", STRIKE_OTM: "MARKET_RISK", STRIKE_OTM_FOR_SELLER: "MARKET_RISK", STOP_IMPLIED_UNDERLYING_MOVE: "MARKET_RISK", STOP_WITHIN_DAILY_DECAY: "MARKET_RISK", STOP_INCOHERENT: "MARKET_RISK",
  PREMIUM_SPREAD_WIDE: "LIQUIDITY_RISK", PREMIUM_SPREAD_MODERATE: "LIQUIDITY_RISK", NO_MARKET_SIDE: "LIQUIDITY_RISK", ONE_SIDED_QUOTE: "LIQUIDITY_RISK", STOP_INSIDE_SPREAD: "LIQUIDITY_RISK",
  OPEN_INTEREST_POOR: "LIQUIDITY_RISK", OPEN_INTEREST_LOW: "LIQUIDITY_RISK", OPEN_INTEREST_MISSING: "LIQUIDITY_RISK", NO_TRADED_VOLUME: "LIQUIDITY_RISK", VOLUME_LOW: "LIQUIDITY_RISK", VOLUME_MISSING: "LIQUIDITY_RISK",
  OPTION_EXPIRED: "CONTRACT_RISK", STRIKE_NOT_IN_CHAIN: "CONTRACT_RISK", CHAIN_NOT_CONFIGURED: "CONTRACT_RISK", CHAIN_UNAVAILABLE: "CONTRACT_RISK", CHAIN_NOT_AVAILABLE: "CONTRACT_RISK", CHAIN_UNUSABLE: "CONTRACT_RISK",
};
export interface OptionsRiskContext { agentId: string; agentVersion: string; status: AgentRunResult["status"]; verdict: AgentRunResult["verdict"]; marketRisk: string[]; liquidityRisk: string[]; contractRisk: string[]; unclassified: string[] }
/** Groups an `options-risk-v1` result by risk category (market / liquidity / contract). A result that did not complete maps to empty lists: its absence is carried by `status`, never read as "no risk". */
export function mapOptionsFindings(r: Pick<AgentRunResult, "agentId" | "agentVersion" | "status" | "verdict" | "findings">): OptionsRiskContext {
  const o: OptionsRiskContext = { agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, marketRisk: [], liquidityRisk: [], contractRisk: [], unclassified: [] };
  if (r.status !== "COMPLETED") return o;
  for (const f of r.findings.filter((x) => x.severity !== "INFO")) {
    const cat = OPTIONS_FINDING_CATEGORY[f.code];
    (cat === "MARKET_RISK" ? o.marketRisk : cat === "LIQUIDITY_RISK" ? o.liquidityRisk : cat === "CONTRACT_RISK" ? o.contractRisk : o.unclassified).push(f.code);
  }
  for (const k of ["marketRisk", "liquidityRisk", "contractRisk", "unclassified"] as const) o[k] = [...new Set(o[k])].sort();
  return o;
}
