import type { ExpiryClaim, OptionType, Underlying } from "./types";

/**
 * Exact-contract verification boundary. A VERIFIED instrument master is the only source of a contract id, expiry
 * date, lot size and tick size; this code never invents them. No production master exists yet:
 * `unconfiguredContractMaster` is the default and verifies nothing. Test fixture masters live under tests/ only.
 */
export interface ContractQuery {
  underlying: Underlying;
  strike: number;
  optionType: OptionType;
  /** Always a calendar-valid explicit date (status "full"); other expiry shapes are never sent for lookup. */
  expiry: Extract<ExpiryClaim, { status: "full" }>;
}

export interface VerifiedContract {
  /** The master's own entry/contract id, when it has one. Never generated here. */
  contractId?: string;
  /** ISO date taken from the master, not computed here. */
  expiryDate: string;
  /** Only ever from the master. */
  lotSize: number;
  /** Only when the master carries one; never defaulted. */
  tickSize?: number;
  /** Raw tick size exactly as the provider supplied it. Its UNITS are not documented by the provider, so it is never converted. */
  tickSizeRaw?: string;
  /** Provider snapshots: who listed this contract, where, and under which provider identifiers (only fields actually supplied). */
  providerIdentity?: { provider: string; exchange: string; segment: string; instrument: string; securityId?: string; symbolName?: string };
  /** Manual references: when the owner checked this entry, what source, and the evidence note. */
  verifiedAsOf?: string;
  entrySource?: string;
  notes?: string;
}

/** Labels of a reference data set, so every result says what it was checked against. */
/** Provenance of an imported provider instrument-master snapshot. Provider-listed is NOT exchange-independent verification. */
export interface SnapshotProvenance {
  provider: string;
  sourceUrl: string;
  /** When the owner retrieved the provider file (or, if only the file time was available, an estimate - see retrievalTimeSource). */
  retrievedAt: string;
  retrievalTimeSource: "owner_supplied" | "file_mtime_estimate";
  contentSha256: string;
  importerVersion: string;
  snapshotSchemaVersion: string;
  importedAt: string;
  csvFormat: string;
}

export interface ReferenceInfo {
  /** Which kind of data this is. Never live market data. */
  kind: "manual_verified" | "synthetic_sample" | "provider_snapshot";
  /** Present for provider snapshots. */
  snapshot?: SnapshotProvenance | undefined;
  version: string;
  source: string;
  /** Synthetic samples are dated as a set; manual references are dated per entry (verifiedAsOf). */
  collectedAsOf?: string | undefined;
  /** True for invented sample data: such a result proves nothing about any real contract. */
  synthetic: boolean;
  entryCount?: number | undefined;
}

export type ContractVerification =
  | { status: "unconfigured" }
  | { status: "not_attempted"; reason: string }
  | { status: "reference_empty" }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: number }
  | { status: "verified"; contract: VerifiedContract; masterName: string; testFixture: boolean; reference?: ReferenceInfo };

export interface OptionsContractMaster {
  readonly name: string;
  /** True only for offline test masters; such a result must be reported as test-only. */
  readonly isTestFixture: boolean;
  /** Present for data-backed masters: what the data is, where it is from and when it was collected. */
  readonly reference?: ReferenceInfo;
  lookup(query: ContractQuery): Promise<ContractVerification>;
}

export const unconfiguredContractMaster: OptionsContractMaster = {
  name: "unconfigured",
  isTestFixture: false,
  async lookup() {
    return { status: "unconfigured" };
  },
};
