import type { ContractQuery, ContractVerification, OptionsContractMaster, ReferenceInfo, SnapshotProvenance, VerifiedContract } from "./master";
import { SUPPORTED_UNDERLYINGS, type OptionType } from "./types";

/**
 * A locally stored snapshot of a PROVIDER's instrument master (currently Dhan), produced by an explicit import command
 * from a CSV the owner downloaded separately. Entries mean "the provider listed this contract in that file on that
 * date" - nothing more: not exchange-independent verification, not live entitlement, not proof of current
 * tradability. Matching is exact; missing or ambiguous data never yields a verified match.
 */
export const SNAPSHOT_SCHEMA_VERSION = "provider-snapshot-v1";
export const DHAN_IMPORTER_VERSION = "dhan-importer-v1";
export const PROVIDER_LISTED_STATEMENT =
  "Provider-listed only: this snapshot records what the provider's instrument file listed. It is NOT exchange-independent verification, NOT live entitlement and NOT proof that a contract is currently tradable.";

export interface ProviderContractRow {
  provider: "dhan";
  exchange: string;
  segment: string;
  instrument: string;
  securityId?: string;
  underlyingSymbol: string;
  underlyingSecurityId?: string;
  symbolName?: string;
  displayName?: string;
  strike: number;
  optionType: OptionType;
  /** Date part (YYYY-MM-DD) of the provider's expiry field, exactly as written there. */
  expiryDate: string;
  /** The provider's expiry field verbatim (it may carry a time of day; its meaning is not documented by the provider). */
  expiryRaw: string;
  lotSize: number;
  /** Tick size verbatim; units are not documented by the provider, so it is never converted. Absent when not supplied. */
  tickSizeRaw?: string;
}

export interface ProviderSnapshotFile {
  referenceKind: "provider_instrument_snapshot";
  provider: "dhan";
  snapshotSchemaVersion: string;
  importerVersion: string;
  synthetic: boolean;
  liveMarketData: false;
  statement: string;
  importedAt: string;
  source: Omit<SnapshotProvenance, "provider" | "importerVersion" | "snapshotSchemaVersion" | "importedAt"> & { columnsSeen: string[] };
  counts: { rowsRead: number; kept: number; skipped: Record<string, number>; rejected: Record<string, number> };
  contracts: ProviderContractRow[];
}

export class ProviderSnapshotError extends Error {
  constructor(message: string) {
    super(`invalid provider snapshot: ${message}`);
    this.name = "ProviderSnapshotError";
  }
}

const isIsoInstant = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(new Date(s).getTime());
const isCalendarDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function parseProviderSnapshotFile(raw: unknown): ProviderSnapshotFile {
  if (typeof raw !== "object" || raw === null) throw new ProviderSnapshotError("not an object");
  const o = raw as Record<string, unknown>;
  if (o["referenceKind"] !== "provider_instrument_snapshot") throw new ProviderSnapshotError('referenceKind must be "provider_instrument_snapshot"');
  if (o["provider"] !== "dhan") throw new ProviderSnapshotError('provider must be "dhan"');
  if (o["snapshotSchemaVersion"] !== SNAPSHOT_SCHEMA_VERSION) throw new ProviderSnapshotError(`snapshotSchemaVersion must be "${SNAPSHOT_SCHEMA_VERSION}"`);
  if (!str(o["importerVersion"])) throw new ProviderSnapshotError("importerVersion is required");
  if (o["liveMarketData"] !== false) throw new ProviderSnapshotError("liveMarketData must be false");
  if (typeof o["synthetic"] !== "boolean") throw new ProviderSnapshotError("synthetic must be stated explicitly");
  if (!str(o["statement"]) || !/not exchange-independent verification/i.test(o["statement"])) throw new ProviderSnapshotError("statement must say the data is NOT exchange-independent verification");
  if (!isIsoInstant(o["importedAt"])) throw new ProviderSnapshotError("importedAt must be an ISO instant");
  const src = (typeof o["source"] === "object" && o["source"] !== null ? o["source"] : {}) as Record<string, unknown>;
  if (!str(src["url"]) && !str(src["sourceUrl"])) throw new ProviderSnapshotError("source.sourceUrl is required");
  const sourceUrl = (src["sourceUrl"] ?? src["url"]) as string;
  if (!/^https:\/\//.test(sourceUrl)) throw new ProviderSnapshotError("source.sourceUrl must be an https URL");
  if (!isIsoInstant(src["retrievedAt"])) throw new ProviderSnapshotError("source.retrievedAt must be an ISO instant");
  if (src["retrievalTimeSource"] !== "owner_supplied" && src["retrievalTimeSource"] !== "file_mtime_estimate") throw new ProviderSnapshotError("source.retrievalTimeSource must be owner_supplied or file_mtime_estimate");
  if (!str(src["contentSha256"]) || !/^[0-9a-f]{64}$/.test(src["contentSha256"])) throw new ProviderSnapshotError("source.contentSha256 must be a SHA-256 hex digest");
  if (!str(src["csvFormat"])) throw new ProviderSnapshotError("source.csvFormat is required");
  const counts = (typeof o["counts"] === "object" && o["counts"] !== null ? o["counts"] : {}) as Record<string, unknown>;
  if (typeof counts["rowsRead"] !== "number" || typeof counts["kept"] !== "number") throw new ProviderSnapshotError("counts.rowsRead and counts.kept are required");
  if (!Array.isArray(o["contracts"])) throw new ProviderSnapshotError("contracts must be an array");
  const contracts = o["contracts"].map((c: unknown, i): ProviderContractRow => {
    const e = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const bad = (f: string): never => { throw new ProviderSnapshotError(`contracts[${i}].${f} is invalid`); };
    if (e["provider"] !== "dhan") bad("provider");
    if (!str(e["exchange"])) bad("exchange");
    if (!str(e["segment"])) bad("segment");
    if (!str(e["instrument"])) bad("instrument");
    if (!SUPPORTED_UNDERLYINGS.includes(e["underlyingSymbol"] as never)) bad("underlyingSymbol");
    if (typeof e["strike"] !== "number" || !Number.isInteger(e["strike"]) || e["strike"] <= 0) bad("strike");
    if (e["optionType"] !== "CE" && e["optionType"] !== "PE") bad("optionType");
    if (!isCalendarDate(e["expiryDate"])) bad("expiryDate");
    if (!str(e["expiryRaw"])) bad("expiryRaw");
    if (typeof e["lotSize"] !== "number" || !Number.isInteger(e["lotSize"]) || e["lotSize"] <= 0) bad("lotSize");
    if (e["tickSizeRaw"] !== undefined && !str(e["tickSizeRaw"])) bad("tickSizeRaw");
    return e as unknown as ProviderContractRow;
  });
  return {
    referenceKind: "provider_instrument_snapshot", provider: "dhan", snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION, importerVersion: o["importerVersion"], synthetic: o["synthetic"],
    liveMarketData: false, statement: o["statement"], importedAt: o["importedAt"],
    source: { sourceUrl, retrievedAt: src["retrievedAt"], retrievalTimeSource: src["retrievalTimeSource"], contentSha256: src["contentSha256"], csvFormat: src["csvFormat"] as string, columnsSeen: Array.isArray(src["columnsSeen"]) ? (src["columnsSeen"] as string[]) : [] },
    counts: o["counts"] as ProviderSnapshotFile["counts"],
    contracts,
  } as ProviderSnapshotFile;
}

const iso = (e: ContractQuery["expiry"]) => `${e.year}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`;

export function createProviderSnapshotContractMaster(file: ProviderSnapshotFile): OptionsContractMaster {
  const snapshot: SnapshotProvenance = {
    provider: file.provider, sourceUrl: file.source.sourceUrl, retrievedAt: file.source.retrievedAt, retrievalTimeSource: file.source.retrievalTimeSource,
    contentSha256: file.source.contentSha256, importerVersion: file.importerVersion, snapshotSchemaVersion: file.snapshotSchemaVersion, importedAt: file.importedAt, csvFormat: file.source.csvFormat,
  };
  const reference: ReferenceInfo = {
    kind: "provider_snapshot", version: `${file.provider}-snapshot:${file.source.contentSha256.slice(0, 12)}`, source: `Provider instrument master (${file.provider}) - ${file.source.sourceUrl}`,
    collectedAsOf: file.source.retrievedAt.slice(0, 10), synthetic: file.synthetic, entryCount: file.contracts.length, snapshot,
  };
  return {
    name: `provider-snapshot:${file.provider}:${file.source.contentSha256.slice(0, 12)}`,
    isTestFixture: false,
    reference,
    async lookup(q: ContractQuery): Promise<ContractVerification> {
      if (file.contracts.length === 0) return { status: "reference_empty" };
      const expiry = iso(q.expiry);
      // EXACT only: underlying symbol, strike, option type and the provider's expiry date. No alias, nearest expiry or nearest strike.
      const hits = file.contracts.filter((c) => c.underlyingSymbol === q.underlying && c.strike === q.strike && c.optionType === q.optionType && c.expiryDate === expiry);
      const [only] = hits;
      if (!only) return { status: "not_found" };
      if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
      const identity: NonNullable<VerifiedContract["providerIdentity"]> = { provider: only.provider, exchange: only.exchange, segment: only.segment, instrument: only.instrument };
      if (only.securityId) identity.securityId = only.securityId;
      if (only.symbolName) identity.symbolName = only.symbolName;
      const contract: VerifiedContract = { expiryDate: only.expiryDate, lotSize: only.lotSize, providerIdentity: identity };
      if (only.securityId) contract.contractId = only.securityId;
      if (only.tickSizeRaw) contract.tickSizeRaw = only.tickSizeRaw;
      return { status: "verified", masterName: `provider-snapshot:${file.provider}`, testFixture: false, reference, contract };
    },
  };
}
