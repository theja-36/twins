import { createHash } from "node:crypto";
import type { ProviderContractRow } from "./providerSnapshot";
import type { OptionType } from "./types";

/**
 * Canonical contract record (G-38). A PROVIDER-INDEPENDENT, versioned, effective-dated description of one exchange-traded contract, built to WRAP the existing models (provider snapshot rows, `VerifiedContract`, planning
 * `InstrumentSpec`) rather than replace them. It invents nothing: every field comes from a source, the source is recorded, and a record adapted from a provider listing can never be "exchange verified".
 * No external source is configured, so nothing here is populated from real data; the persistence table and API route are specified in `docs/product/G38_CONTRACT_MASTER.md` and are not built.
 */
export const CANONICAL_CONTRACT_VERSION = "canonical-contract-v1";
/** What the record's data rests on. Only EXCHANGE_VERIFIED and MANUAL_VERIFIED may feed sizing; a provider listing and synthetic data may not. */
export type ContractValidationStatus = "EXCHANGE_VERIFIED" | "MANUAL_VERIFIED" | "PROVIDER_LISTED" | "SYNTHETIC" | "UNVERIFIED";
export type TickSizeUnit = "RUPEES" | "PAISE" | "UNSPECIFIED";
export interface ContractIdentifier { namespace: string; value: string }
export interface ContractProvenance { source: string; sourceUrl?: string; retrievedAt: string; contentSha256?: string; importerVersion?: string; retrievalTimeSource?: string }
export interface CanonicalContract {
  canonicalId: string; contractVersion: typeof CANONICAL_CONTRACT_VERSION;
  exchange: string; segment: string; kind: "OPTION" | "FUTURE"; underlying: string;
  /** YYYY-MM-DD, calendar-valid. */
  expiryDate: string;
  /** Decimal string without trailing zeros: never a float. Null for futures. */
  strike: string | null; optionType: OptionType | null;
  lotSize: number; tickSize: string | null; tickSizeUnit: TickSizeUnit;
  /** Provider and exchange ids. A namespace names who issued the id; an exchange token alone is never the identity (tokens are reused after expiry). */
  identifiers: ContractIdentifier[];
  /** This record applies from effectiveFrom (inclusive) to effectiveTo (exclusive; null = open). A lot-size change is a NEW version with a new range, never an edit. */
  effectiveFrom: string; effectiveTo: string | null; version: number; supersedes: number | null;
  validation: ContractValidationStatus; provenance: ContractProvenance;
}
export type ContractIdentity = Pick<CanonicalContract, "exchange" | "segment" | "kind" | "underlying" | "expiryDate" | "strike" | "optionType">;
export type ContractProblemCode = "ID_MISMATCH" | "BAD_EXPIRY" | "BAD_STRIKE" | "OPTION_NEEDS_STRIKE_AND_TYPE" | "FUTURE_HAS_STRIKE_OR_TYPE" | "LOT_SIZE_INVALID" | "TICK_SIZE_INVALID" | "EFFECTIVE_RANGE_INVALID" | "PROVENANCE_MISSING" | "SYNTHETIC_MISLABELLED" | "PROVIDER_CANNOT_BE_EXCHANGE_VERIFIED" | "NO_IDENTIFIER";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => { if (!DATE.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; };
/** "24500", "24500.0", "24500.50" -> canonical decimal text; anything not a plain positive decimal -> null. */
export function normalizeStrike(v: string | number): string | null {
  const t = String(v).trim(); if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t; const stripped = n.replace(/^0+(?=\d)/, "");
  return Number(stripped) > 0 ? stripped : null;
}
/** Deterministic, provider-independent identity: the same contract has the same id whichever source listed it. */
export function canonicalContractId(i: ContractIdentity): string {
  return "ctr_" + createHash("sha256").update([i.exchange, i.segment, i.kind, i.underlying, i.expiryDate, i.strike ?? "-", i.optionType ?? "-"].join("|")).digest("hex").slice(0, 32);
}
export function validateCanonicalContract(c: CanonicalContract): ContractProblemCode[] {
  const p: ContractProblemCode[] = [];
  if (c.canonicalId !== canonicalContractId(c)) p.push("ID_MISMATCH");
  if (!validDate(c.expiryDate)) p.push("BAD_EXPIRY");
  if (c.kind === "OPTION") { if (c.strike === null || c.optionType === null) p.push("OPTION_NEEDS_STRIKE_AND_TYPE"); else if (normalizeStrike(c.strike) !== c.strike) p.push("BAD_STRIKE"); }
  else if (c.strike !== null || c.optionType !== null) p.push("FUTURE_HAS_STRIKE_OR_TYPE");
  if (!Number.isInteger(c.lotSize) || c.lotSize < 1) p.push("LOT_SIZE_INVALID");
  if (c.tickSize !== null && !(Number(c.tickSize) > 0 && /^\d+(\.\d+)?$/.test(c.tickSize))) p.push("TICK_SIZE_INVALID");
  if (!validDate(c.effectiveFrom) || (c.effectiveTo !== null && (!validDate(c.effectiveTo) || c.effectiveTo <= c.effectiveFrom)) || !Number.isInteger(c.version) || c.version < 1) p.push("EFFECTIVE_RANGE_INVALID");
  if (!c.provenance.source || !Number.isFinite(Date.parse(c.provenance.retrievedAt))) p.push("PROVENANCE_MISSING");
  if (c.identifiers.length === 0) p.push("NO_IDENTIFIER");
  if (c.validation === "SYNTHETIC" !== /^synthetic/i.test(c.provenance.source)) p.push("SYNTHETIC_MISLABELLED");
  if (c.validation === "EXCHANGE_VERIFIED" && /^(dhan|kite|zerodha|upstox|angel|provider)/i.test(c.provenance.source)) p.push("PROVIDER_CANNOT_BE_EXCHANGE_VERIFIED");
  return p;
}
/** Only exchange-verified or manually verified records may feed sizing, risk or execution; a provider listing and synthetic data never. */
export const isSizingEligible = (c: CanonicalContract): boolean => (c.validation === "EXCHANGE_VERIFIED" || c.validation === "MANUAL_VERIFIED") && validateCanonicalContract(c).length === 0;

/** Adapts a provider-snapshot row. The result is PROVIDER_LISTED (never verified), the tick unit stays UNSPECIFIED because the provider does not document it, and nothing is defaulted. Null when the row cannot be represented. */
export function adaptProviderRow(r: ProviderContractRow, prov: ContractProvenance, effectiveFrom: string): CanonicalContract | null {
  const strike = normalizeStrike(r.strike); if (strike === null) return null;
  const idn: ContractIdentity = { exchange: r.exchange, segment: r.segment, kind: "OPTION", underlying: r.underlyingSymbol, expiryDate: r.expiryDate, strike, optionType: r.optionType };
  const c: CanonicalContract = { canonicalId: canonicalContractId(idn), contractVersion: CANONICAL_CONTRACT_VERSION, ...idn, lotSize: r.lotSize, tickSize: r.tickSizeRaw !== undefined && Number(r.tickSizeRaw) > 0 ? String(r.tickSizeRaw) : null, tickSizeUnit: "UNSPECIFIED",
    identifiers: r.securityId ? [{ namespace: `${r.provider}:securityId`, value: r.securityId }] : [], effectiveFrom, effectiveTo: null, version: 1, supersedes: null, validation: "PROVIDER_LISTED", provenance: prov };
  return c;
}
export type ContractResolution = { status: "RESOLVED"; contract: CanonicalContract } | { status: "NOT_FOUND" } | { status: "CONFLICT"; reason: string };
/** The record in force for an identity at `at` (YYYY-MM-DD). Several records in force with different lot or tick sizes are a CONFLICT, never a guess; identical ones resolve to the highest version. */
export function resolveContractAt(all: CanonicalContract[], id: string, at: string): ContractResolution {
  const live = all.filter((c) => c.canonicalId === id && c.effectiveFrom <= at && (c.effectiveTo === null || at < c.effectiveTo) && validateCanonicalContract(c).length === 0);
  if (live.length === 0) return { status: "NOT_FOUND" };
  const top = live.reduce((a, b) => (b.version > a.version ? b : a));
  const clash = live.filter((c) => c !== top && c.version === top.version);
  if (clash.length > 0 && clash.some((c) => c.lotSize !== top.lotSize || c.tickSize !== top.tickSize)) return { status: "CONFLICT", reason: "two records with the same version disagree on lot or tick size" };
  const sources = new Set(live.map((c) => `${c.lotSize}|${c.tickSize}`));
  if (sources.size > 1 && live.every((c) => c.version === top.version)) return { status: "CONFLICT", reason: "records in force disagree on lot or tick size" };
  return { status: "RESOLVED", contract: top };
}
export interface SourceConflict { field: "lotSize" | "tickSize" | "expiryDate"; a: string; b: string }
/** Compares two records of the same contract from different sources. Any difference is reported; nothing is reconciled automatically. */
export function compareSources(a: CanonicalContract, b: CanonicalContract): SourceConflict[] | "DIFFERENT_CONTRACTS" {
  if (a.canonicalId !== b.canonicalId) return "DIFFERENT_CONTRACTS";
  const out: SourceConflict[] = [];
  if (a.lotSize !== b.lotSize) out.push({ field: "lotSize", a: String(a.lotSize), b: String(b.lotSize) });
  if (a.tickSize !== null && b.tickSize !== null && Number(a.tickSize) !== Number(b.tickSize)) out.push({ field: "tickSize", a: a.tickSize, b: b.tickSize });
  if (a.expiryDate !== b.expiryDate) out.push({ field: "expiryDate", a: a.expiryDate, b: b.expiryDate });
  return out;
}
