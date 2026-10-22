import type { ContractQuery, ContractVerification, OptionsContractMaster, ReferenceInfo, VerifiedContract } from "./master";
import { SUPPORTED_UNDERLYINGS, type OptionType } from "./types";

/**
 * A data-backed contract master built from a versioned reference object (the preview loads a local JSON file; this
 * module does no I/O). Matching is EXACT on underlying, strike, option type and expiry date: no fuzzy matching, no
 * nearest-expiry selection. The data is whatever the file says - this code supplies no contract, expiry or lot size.
 * A reference set is not live entitlement and not a guarantee that a contract is currently tradable.
 */
export interface ReferenceContractEntry {
  entryId: string;
  underlying: string;
  strike: number;
  optionType: OptionType;
  /** ISO calendar date YYYY-MM-DD. */
  expiryDate: string;
  lotSize: number;
}

export interface ReferenceFile {
  referenceVersion: string;
  sourceLabel: string;
  /** ISO date YYYY-MM-DD. */
  collectedAsOf: string;
  synthetic: boolean;
  contracts: ReferenceContractEntry[];
}

export class ReferenceFileError extends Error {
  constructor(message: string) {
    super(`invalid options reference data: ${message}`);
    this.name = "ReferenceFileError";
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Strict validation: a malformed reference is an error, never silently partial. Messages name fields, not values. */
export function parseReferenceFile(raw: unknown): ReferenceFile {
  if (typeof raw !== "object" || raw === null) throw new ReferenceFileError("not an object");
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o["referenceVersion"])) throw new ReferenceFileError("referenceVersion is required");
  if (!isNonEmptyString(o["sourceLabel"])) throw new ReferenceFileError("sourceLabel is required");
  if (!isCalendarDate(o["collectedAsOf"])) throw new ReferenceFileError("collectedAsOf must be an ISO date (YYYY-MM-DD)");
  if (o["synthetic"] !== true) throw new ReferenceFileError("synthetic must be stated explicitly as true (sample format only; manually verified data uses the manual format)");
  if (!Array.isArray(o["contracts"])) throw new ReferenceFileError("contracts must be an array");
  const contracts = o["contracts"].map((c: unknown, i): ReferenceContractEntry => {
    const e = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    if (!isNonEmptyString(e["entryId"])) throw new ReferenceFileError(`contracts[${i}].entryId is required`);
    if (!SUPPORTED_UNDERLYINGS.includes(e["underlying"] as never)) throw new ReferenceFileError(`contracts[${i}].underlying must be one of ${SUPPORTED_UNDERLYINGS.join(", ")}`);
    if (!isPositiveInt(e["strike"])) throw new ReferenceFileError(`contracts[${i}].strike must be a positive integer`);
    if (e["optionType"] !== "CE" && e["optionType"] !== "PE") throw new ReferenceFileError(`contracts[${i}].optionType must be CE or PE`);
    if (!isCalendarDate(e["expiryDate"])) throw new ReferenceFileError(`contracts[${i}].expiryDate must be an ISO calendar date`);
    if (!isPositiveInt(e["lotSize"])) throw new ReferenceFileError(`contracts[${i}].lotSize must be a positive integer`);
    return { entryId: e["entryId"], underlying: e["underlying"] as string, strike: e["strike"], optionType: e["optionType"], expiryDate: e["expiryDate"], lotSize: e["lotSize"] };
  });
  return {
    referenceVersion: o["referenceVersion"],
    sourceLabel: o["sourceLabel"],
    collectedAsOf: o["collectedAsOf"],
    synthetic: true,
    contracts,
  };
}

const iso = (e: ContractQuery["expiry"]) => `${e.year}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`;

export function createReferenceContractMaster(file: ReferenceFile): OptionsContractMaster {
  const reference: ReferenceInfo = { kind: "synthetic_sample", version: file.referenceVersion, source: file.sourceLabel, collectedAsOf: file.collectedAsOf, synthetic: true, entryCount: file.contracts.length };
  return {
    name: `local-reference:${file.referenceVersion}`,
    isTestFixture: false,
    reference,
    async lookup(q: ContractQuery): Promise<ContractVerification> {
      const expiry = iso(q.expiry);
      const hits = file.contracts.filter((c) => c.underlying === q.underlying && c.strike === q.strike && c.optionType === q.optionType && c.expiryDate === expiry);
      const [only] = hits;
      if (!only) return { status: "not_found" };
      if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
      return {
        status: "verified",
        masterName: `local-reference:${file.referenceVersion}`,
        testFixture: false,
        reference,
        contract: { contractId: only.entryId, expiryDate: only.expiryDate, lotSize: only.lotSize },
      };
    },
  };
}


// ---------------------------------------------------------------------------------------------------------------
// MANUAL VERIFIED REFERENCE: a hand-maintained file. It starts empty and contains only entries the owner adds after
// checking them. It is distinct from synthetic sample data and from live market data, is not refreshed
// automatically, and does not prove current tradability.
// ---------------------------------------------------------------------------------------------------------------
export interface ManualReferenceEntry {
  entryId: string;
  underlying: string;
  strike: number;
  optionType: OptionType;
  expiryDate: string;
  lotSize: number;
  tickSize?: number;
  source: string;
  verifiedAsOf: string;
  notes: string;
}

export interface ManualReferenceFile {
  referenceVersion: string;
  sourceLabel: string;
  tradabilityStatement: string;
  contracts: ManualReferenceEntry[];
}

export function parseManualReferenceFile(raw: unknown): ManualReferenceFile {
  if (typeof raw !== "object" || raw === null) throw new ReferenceFileError("not an object");
  const o = raw as Record<string, unknown>;
  if (o["referenceKind"] !== "manual_verified_reference") throw new ReferenceFileError('referenceKind must be "manual_verified_reference"');
  if (!isNonEmptyString(o["referenceVersion"])) throw new ReferenceFileError("referenceVersion is required");
  if (!isNonEmptyString(o["sourceLabel"])) throw new ReferenceFileError("sourceLabel is required");
  if (o["manuallyMaintained"] !== true) throw new ReferenceFileError("manuallyMaintained must be true");
  if (o["autoRefreshed"] !== false) throw new ReferenceFileError("autoRefreshed must be false");
  if (o["synthetic"] !== false) throw new ReferenceFileError("synthetic must be false in a manual verified reference (sample data uses the sample format)");
  if (o["liveMarketData"] !== false) throw new ReferenceFileError("liveMarketData must be false");
  if (!isNonEmptyString(o["tradabilityStatement"]) || !/does not prove current tradability/i.test(o["tradabilityStatement"])) {
    throw new ReferenceFileError('tradabilityStatement is required and must say the reference "does NOT prove current tradability"');
  }
  if (!Array.isArray(o["contracts"])) throw new ReferenceFileError("contracts must be an array");
  const ids = new Set<string>();
  const contracts = o["contracts"].map((c: unknown, i): ManualReferenceEntry => {
    const e = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    if (!isNonEmptyString(e["entryId"])) throw new ReferenceFileError(`contracts[${i}].entryId is required`);
    if (ids.has(e["entryId"])) throw new ReferenceFileError(`contracts[${i}].entryId repeats an earlier entry id`);
    ids.add(e["entryId"]);
    if (!SUPPORTED_UNDERLYINGS.includes(e["underlying"] as never)) throw new ReferenceFileError(`contracts[${i}].underlying must be one of ${SUPPORTED_UNDERLYINGS.join(", ")}`);
    if (!isPositiveInt(e["strike"])) throw new ReferenceFileError(`contracts[${i}].strike must be a positive integer`);
    if (e["optionType"] !== "CE" && e["optionType"] !== "PE") throw new ReferenceFileError(`contracts[${i}].optionType must be CE or PE`);
    if (!isCalendarDate(e["expiryDate"])) throw new ReferenceFileError(`contracts[${i}].expiryDate must be an ISO calendar date`);
    if (!isPositiveInt(e["lotSize"])) throw new ReferenceFileError(`contracts[${i}].lotSize must be a positive integer`);
    if (!isNonEmptyString(e["source"])) throw new ReferenceFileError(`contracts[${i}].source is required`);
    if (!isCalendarDate(e["verifiedAsOf"])) throw new ReferenceFileError(`contracts[${i}].verifiedAsOf must be an ISO date (YYYY-MM-DD)`);
    if (!isNonEmptyString(e["notes"])) throw new ReferenceFileError(`contracts[${i}].notes (evidence reference) is required`);
    const entry: ManualReferenceEntry = {
      entryId: e["entryId"], underlying: e["underlying"] as string, strike: e["strike"], optionType: e["optionType"],
      expiryDate: e["expiryDate"], lotSize: e["lotSize"], source: e["source"], verifiedAsOf: e["verifiedAsOf"], notes: e["notes"],
    };
    if (e["tickSize"] !== undefined) {
      if (typeof e["tickSize"] !== "number" || !(e["tickSize"] > 0)) throw new ReferenceFileError(`contracts[${i}].tickSize must be a positive number when present`);
      entry.tickSize = e["tickSize"];
    }
    return entry;
  });
  return { referenceVersion: o["referenceVersion"], sourceLabel: o["sourceLabel"], tradabilityStatement: o["tradabilityStatement"], contracts };
}

export function createManualReferenceContractMaster(file: ManualReferenceFile): OptionsContractMaster {
  const reference: ReferenceInfo = { kind: "manual_verified", version: file.referenceVersion, source: file.sourceLabel, synthetic: false, entryCount: file.contracts.length };
  return {
    name: `manual-reference:${file.referenceVersion}`,
    isTestFixture: false,
    reference,
    async lookup(q: ContractQuery): Promise<ContractVerification> {
      // An empty manual reference is reported as such: it never falls back to sample data or to a guess.
      if (file.contracts.length === 0) return { status: "reference_empty" };
      const expiry = iso(q.expiry);
      const hits = file.contracts.filter((c) => c.underlying === q.underlying && c.strike === q.strike && c.optionType === q.optionType && c.expiryDate === expiry);
      const [only] = hits;
      if (!only) return { status: "not_found" };
      if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
      const contract: VerifiedContract = { contractId: only.entryId, expiryDate: only.expiryDate, lotSize: only.lotSize, verifiedAsOf: only.verifiedAsOf, entrySource: only.source, notes: only.notes };
      if (only.tickSize !== undefined) contract.tickSize = only.tickSize;
      return { status: "verified", masterName: `manual-reference:${file.referenceVersion}`, testFixture: false, reference, contract };
    },
  };
}
