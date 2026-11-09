import { describe, expect, it } from "vitest";
import { adaptProviderRow, canonicalContractId, compareSources, isSizingEligible, normalizeStrike, resolveContractAt, validateCanonicalContract, type CanonicalContract, type ContractIdentity } from "../../../packages/signals/src/options/canonicalContract";

/** SYNTHETIC contracts only (no real instrument master is configured). These tests pin the rules, not any real contract's lot or tick size. */
const idn: ContractIdentity = { exchange: "NSE", segment: "NFO", kind: "OPTION", underlying: "NIFTY", expiryDate: "2030-06-27", strike: "24500", optionType: "CE" };
const base = (o: Partial<CanonicalContract> = {}): CanonicalContract => ({ canonicalId: canonicalContractId(idn), contractVersion: "canonical-contract-v1", ...idn, lotSize: 75, tickSize: "0.05", tickSizeUnit: "RUPEES", identifiers: [{ namespace: "test:id", value: "1" }], effectiveFrom: "2030-01-01", effectiveTo: null, version: 1, supersedes: null, validation: "MANUAL_VERIFIED", provenance: { source: "manual-test", retrievedAt: "2030-01-01T00:00:00Z" }, ...o });

describe("canonical contract identity", () => {
  it("the id is deterministic, provider-independent and sensitive to every identity field", () => {
    expect(canonicalContractId(idn)).toBe(canonicalContractId({ ...idn }));
    for (const change of [{ strike: "24550" }, { optionType: "PE" as const }, { expiryDate: "2030-07-25" }, { underlying: "BANKNIFTY" }, { exchange: "BSE" }, { segment: "BFO" }]) expect(canonicalContractId({ ...idn, ...change })).not.toBe(canonicalContractId(idn));
  });
  it("strikes are decimal strings: 24500, 24500.0 and 24500.50 normalise; floats, signs, exponents and zero are refused", () => {
    expect(normalizeStrike("24500")).toBe("24500"); expect(normalizeStrike(24500)).toBe("24500"); expect(normalizeStrike("24500.0")).toBe("24500"); expect(normalizeStrike("24500.50")).toBe("24500.5");
    for (const bad of ["-1", "0", "1e3", "abc", "", "24,500", "0.0"]) expect(normalizeStrike(bad), bad).toBeNull();
  });
});
describe("validation", () => {
  it("a well-formed record has no problems", () => { expect(validateCanonicalContract(base())).toEqual([]); });
  it("each defect is named, never silently repaired", () => {
    expect(validateCanonicalContract(base({ canonicalId: "ctr_wrong" }))).toContain("ID_MISMATCH");
    expect(validateCanonicalContract(base({ expiryDate: "2030-02-30" }))).toContain("BAD_EXPIRY");
    expect(validateCanonicalContract(base({ lotSize: 0 }))).toContain("LOT_SIZE_INVALID"); expect(validateCanonicalContract(base({ lotSize: 7.5 }))).toContain("LOT_SIZE_INVALID");
    expect(validateCanonicalContract(base({ tickSize: "-0.05" }))).toContain("TICK_SIZE_INVALID");
    expect(validateCanonicalContract(base({ effectiveTo: "2029-12-31" }))).toContain("EFFECTIVE_RANGE_INVALID");
    expect(validateCanonicalContract(base({ provenance: { source: "", retrievedAt: "not a date" } }))).toContain("PROVENANCE_MISSING");
    expect(validateCanonicalContract(base({ identifiers: [] }))).toContain("NO_IDENTIFIER");
    expect(validateCanonicalContract(base({ validation: "SYNTHETIC" }))).toContain("SYNTHETIC_MISLABELLED");
    expect(validateCanonicalContract(base({ provenance: { source: "synthetic-x", retrievedAt: "2030-01-01T00:00:00Z" } }))).toContain("SYNTHETIC_MISLABELLED");
  });
  it("a provider listing can never be labelled exchange verified", () => {
    expect(validateCanonicalContract(base({ validation: "EXCHANGE_VERIFIED", provenance: { source: "dhan-scrip-master", retrievedAt: "2030-01-01T00:00:00Z" } }))).toContain("PROVIDER_CANNOT_BE_EXCHANGE_VERIFIED");
  });
});
describe("what may feed sizing", () => {
  it("only exchange-verified or manually verified, valid records", () => {
    expect(isSizingEligible(base())).toBe(true); expect(isSizingEligible(base({ validation: "EXCHANGE_VERIFIED", provenance: { source: "nse-contract-master", retrievedAt: "2030-01-01T00:00:00Z" } }))).toBe(true);
    for (const v of ["PROVIDER_LISTED", "SYNTHETIC", "UNVERIFIED"] as const) expect(isSizingEligible(base({ validation: v, provenance: { source: v === "SYNTHETIC" ? "synthetic" : "manual-test", retrievedAt: "2030-01-01T00:00:00Z" } })), v).toBe(false);
    expect(isSizingEligible(base({ lotSize: 0 }))).toBe(false);
  });
  it("a provider row is adapted as PROVIDER_LISTED with an unspecified tick unit, and is never sizing eligible", () => {
    const c = adaptProviderRow({ provider: "dhan", exchange: "NSE", segment: "NFO", instrument: "OPTIDX", securityId: "55555", underlyingSymbol: "NIFTY", strike: 24500, optionType: "CE", expiryDate: "2030-06-27", expiryRaw: "2030-06-27 14:30:00", lotSize: 75, tickSizeRaw: "5" }, { source: "dhan-scrip-master", retrievedAt: "2030-01-02T00:00:00Z", contentSha256: "a".repeat(64) }, "2030-01-02")!;
    expect(c.validation).toBe("PROVIDER_LISTED"); expect(c.tickSizeUnit).toBe("UNSPECIFIED"); expect(c.canonicalId).toBe(canonicalContractId(idn)); expect(c.identifiers).toEqual([{ namespace: "dhan:securityId", value: "55555" }]);
    expect(validateCanonicalContract(c)).toEqual([]); expect(isSizingEligible(c)).toBe(false);
    expect(adaptProviderRow({ provider: "dhan", exchange: "NSE", segment: "NFO", instrument: "OPTIDX", underlyingSymbol: "NIFTY", strike: -1, optionType: "CE", expiryDate: "2030-06-27", expiryRaw: "x", lotSize: 75 }, { source: "dhan", retrievedAt: "2030-01-02T00:00:00Z" }, "2030-01-02")).toBeNull();
  });
});
describe("versions and effective dates", () => {
  const id = canonicalContractId(idn);
  it("the version in force at a date is returned; a lot-size change is a new effective-dated version, not an edit", () => {
    const v1 = base({ version: 1, effectiveFrom: "2030-01-01", effectiveTo: "2030-03-01", lotSize: 75 }), v2 = base({ version: 2, supersedes: 1, effectiveFrom: "2030-03-01", effectiveTo: null, lotSize: 65 });
    expect(resolveContractAt([v1, v2], id, "2030-02-15")).toMatchObject({ status: "RESOLVED", contract: { lotSize: 75 } });
    expect(resolveContractAt([v1, v2], id, "2030-03-01")).toMatchObject({ status: "RESOLVED", contract: { lotSize: 65 } }); // the end of v1 is exclusive
    expect(resolveContractAt([v1, v2], id, "2029-12-31")).toEqual({ status: "NOT_FOUND" });
  });
  it("unknown contracts and invalid records are not found, never guessed", () => {
    expect(resolveContractAt([base()], "ctr_other", "2030-02-01")).toEqual({ status: "NOT_FOUND" });
    expect(resolveContractAt([base({ lotSize: 0 })], id, "2030-02-01")).toEqual({ status: "NOT_FOUND" });
  });
  it("two records in force that disagree are a CONFLICT", () => {
    expect(resolveContractAt([base({ lotSize: 75 }), base({ lotSize: 50 })], id, "2030-02-01")).toMatchObject({ status: "CONFLICT" });
  });
});
describe("cross-source comparison", () => {
  it("reports every difference and reconciles nothing; different contracts are not compared", () => {
    const a = base(), b = base({ lotSize: 50, tickSize: "0.10", provenance: { source: "other", retrievedAt: "2030-01-01T00:00:00Z" } });
    expect(compareSources(a, b)).toEqual([{ field: "lotSize", a: "75", b: "50" }, { field: "tickSize", a: "0.05", b: "0.10" }]);
    expect(compareSources(a, base())).toEqual([]);
    expect(compareSources(a, { ...a, canonicalId: "ctr_x" })).toBe("DIFFERENT_CONTRACTS");
  });
});
