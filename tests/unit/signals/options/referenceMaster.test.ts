import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessOptionsClaim } from "../../../../packages/signals/src/options/assess";
import { analyzeOptionsText } from "../../../../packages/signals/src/options/parse";
import { createManualReferenceContractMaster, createReferenceContractMaster, parseManualReferenceFile, parseReferenceFile, ReferenceFileError, type ReferenceFile } from "../../../../packages/signals/src/options/referenceMaster";
import type { OptionsClaim } from "../../../../packages/signals/src/options/types";

const file = (contracts: ReferenceFile["contracts"]): ReferenceFile => ({
  referenceVersion: "unit-ref-v1", sourceLabel: "UNIT TEST DATA - synthetic", collectedAsOf: "2026-10-20", synthetic: true, contracts,
});
const entry = (over: Partial<ReferenceFile["contracts"][number]> = {}): ReferenceFile["contracts"][number] =>
  ({ entryId: "U-1", underlying: "NIFTY", strike: 24500, optionType: "CE", expiryDate: "2026-10-29", lotSize: 4242, ...over });
const claim = (t: string): OptionsClaim => {
  const a = analyzeOptionsText(t);
  if (a.kind !== "options_claim") throw new Error(a.kind);
  return a.claim;
};
const run = (master: ReturnType<typeof createReferenceContractMaster>, t: string) => assessOptionsClaim(claim(t), master);
const FULL = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";

describe("local reference master: exact matching only", () => {
  const m = createReferenceContractMaster(file([entry()]));
  it("exact match: FOUND with the master's own lot size, still INSUFFICIENT_EVIDENCE and non-approving", async () => {
    const a = await run(m, FULL);
    expect(a.verification).toMatchObject({ status: "verified", testFixture: false, contract: { contractId: "U-1", lotSize: 4242, expiryDate: "2026-10-29" }, reference: { version: "unit-ref-v1", synthetic: true } });
    expect(a.verification.status === "verified" && "tickSize" in a.verification.contract).toBe(false); // never defaulted
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.approvalPossible).toBe(false);
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["contract.found_in_local_reference", "option_premium_data.unavailable"]));
  });
  it.each([
    ["wrong strike", FULL.replace("24500", "24550")],
    ["wrong CE/PE", FULL.replace("CE", "PE")],
    ["wrong expiry day", FULL.replace("29 OCT", "30 OCT")],
    ["wrong expiry month", FULL.replace("29 OCT", "29 SEP")],
    ["wrong expiry year", FULL.replace("2026", "2027")],
    ["unknown underlying in the data", FULL.replace("NIFTY", "SENSEX")],
  ])("NOT_FOUND - %s (no nearest/fuzzy match)", async (_l, text) => {
    const a = await run(m, text);
    expect(a.verification).toEqual({ status: "not_found" });
    expect(a.reasons.map((r) => r.code)).toContain("contract.not_found");
    expect(a.approvalPossible).toBe(false);
  });
  it("duplicate entries: AMBIGUOUS with the candidate count", async () => {
    const dup = createReferenceContractMaster(file([entry({ entryId: "U-1" }), entry({ entryId: "U-2" })]));
    const a = await run(dup, FULL);
    expect(a.verification).toEqual({ status: "ambiguous", candidates: 2 });
    expect(a.reasons.map((r) => r.code)).toContain("contract.ambiguous");
  });
  it("only a complete contract is looked up: a year-less expiry is never matched", async () => {
    const a = await run(m, "BUY NIFTY 24500 CE 29 OCT ABOVE 120 SL 90 TGT 150 PREMIUM");
    expect(a.verification.status).toBe("not_attempted");
  });
});

describe("reference file validation (strict, names fields not values)", () => {
  const first = (o: Record<string, unknown>): Record<string, unknown> => {
    const c = (o["contracts"] as Array<Record<string, unknown>>)[0];
    if (!c) throw new Error("no contract");
    return c;
  };
  const good = () => JSON.parse(JSON.stringify(file([entry()]))) as Record<string, unknown>;
  it("accepts a well-formed file", () => expect(parseReferenceFile(good()).contracts).toHaveLength(1));
  it.each([
    ["no version", (o: Record<string, unknown>) => { delete o["referenceVersion"]; }, /referenceVersion is required/],
    ["no source label", (o: Record<string, unknown>) => { delete o["sourceLabel"]; }, /sourceLabel is required/],
    ["bad collected-as-of", (o: Record<string, unknown>) => { o["collectedAsOf"] = "20-10-2026"; }, /collectedAsOf must be an ISO date/],
    ["synthetic not stated", (o: Record<string, unknown>) => { delete o["synthetic"]; }, /synthetic must be stated explicitly as true/],
    ["bad underlying", (o: Record<string, unknown>) => { first(o)["underlying"] = "NIFTYBANK"; }, /contracts\[0\]\.underlying/],
    ["bad strike", (o: Record<string, unknown>) => { first(o)["strike"] = "24500"; }, /contracts\[0\]\.strike/],
    ["impossible expiry", (o: Record<string, unknown>) => { first(o)["expiryDate"] = "2026-02-30"; }, /contracts\[0\]\.expiryDate/],
    ["missing lot size", (o: Record<string, unknown>) => { delete first(o)["lotSize"]; }, /contracts\[0\]\.lotSize/],
  ])("rejects: %s", (_l, mutate, message) => {
    const o = good();
    mutate(o);
    expect(() => parseReferenceFile(o)).toThrow(ReferenceFileError);
    expect(() => parseReferenceFile(o)).toThrow(message);
  });
});

describe("shipped sample reference", () => {
  const data = JSON.parse(readFileSync("data/options-reference/sample-reference.v1.json", "utf8")) as Record<string, unknown>;
  it("is valid, versioned, dated, explicitly synthetic, and carries no tick sizes", () => {
    const f = parseReferenceFile(data);
    expect(f).toMatchObject({ referenceVersion: "sample-reference-v1", collectedAsOf: "2026-10-20", synthetic: true });
    expect(f.sourceLabel).toMatch(/SYNTHETIC SAMPLE.*NOT exchange data/);
    expect(JSON.stringify(data)).not.toMatch(/tickSize/);
    expect(f.contracts.length).toBeLessThanOrEqual(6); // a tiny sample set
  });
});

describe("manual verified reference format", () => {
  const second = (o: Record<string, unknown>): Record<string, unknown> => {
    const c = (o["contracts"] as Array<Record<string, unknown>>)[1];
    if (!c) throw new Error("no contract");
    return c;
  };
  const good = () => JSON.parse(readFileSync("tests/fixtures/options/manual-reference.TEST-FIXTURE.json", "utf8")) as Record<string, unknown>;
  const first = (o: Record<string, unknown>): Record<string, unknown> => {
    const c = (o["contracts"] as Array<Record<string, unknown>>)[0];
    if (!c) throw new Error("no contract");
    return c;
  };
  it("accepts the test fixtures (populated and empty) and the shipped manual file with its one entry", () => {
    expect(parseManualReferenceFile(good()).contracts).toHaveLength(3);
    expect(parseManualReferenceFile(JSON.parse(readFileSync("tests/fixtures/options/manual-reference.EMPTY-FIXTURE.json", "utf8"))).contracts).toEqual([]);
    const shipped = parseManualReferenceFile(JSON.parse(readFileSync("data/options-reference/manual-reference.v1.json", "utf8")));
    expect(shipped.contracts).toEqual([
      {
        entryId: "MANUAL-001", underlying: "NIFTY", strike: 24500, optionType: "CE", expiryDate: "2026-10-26", lotSize: 65,
        source: "Dhan public NIFTY option-chain page, supplied screenshot", verifiedAsOf: "2026-10-20",
        notes: expect.stringContaining("not independently exchange-verified"),
      },
    ]);
    expect("tickSize" in (shipped.contracts[0] ?? {})).toBe(false); // not established by the evidence: omitted
  });
  it.each([
    ["wrong kind", (o: Record<string, unknown>) => { o["referenceKind"] = "synthetic_sample"; }, /referenceKind must be/],
    ["not manually maintained", (o: Record<string, unknown>) => { o["manuallyMaintained"] = false; }, /manuallyMaintained must be true/],
    ["claims auto-refresh", (o: Record<string, unknown>) => { o["autoRefreshed"] = true; }, /autoRefreshed must be false/],
    ["marked synthetic", (o: Record<string, unknown>) => { o["synthetic"] = true; }, /synthetic must be false/],
    ["claims live data", (o: Record<string, unknown>) => { o["liveMarketData"] = true; }, /liveMarketData must be false/],
    ["no tradability statement", (o: Record<string, unknown>) => { o["tradabilityStatement"] = "verified by hand"; }, /tradabilityStatement/],
    ["entry without source", (o: Record<string, unknown>) => { delete first(o)["source"]; }, /contracts\[0\]\.source is required/],
    ["entry without verified-as-of", (o: Record<string, unknown>) => { delete first(o)["verifiedAsOf"]; }, /contracts\[0\]\.verifiedAsOf/],
    ["entry without evidence note", (o: Record<string, unknown>) => { delete first(o)["notes"]; }, /contracts\[0\]\.notes/],
    ["entry without lot size", (o: Record<string, unknown>) => { delete first(o)["lotSize"]; }, /contracts\[0\]\.lotSize/],
    ["repeated entry id", (o: Record<string, unknown>) => { second(o)["entryId"] = "TESTFX-1"; }, /repeats an earlier entry id/],
    ["bad tick size", (o: Record<string, unknown>) => { first(o)["tickSize"] = 0; }, /tickSize/],
  ])("rejects: %s", (_l, mutate, message) => {
    const o = good();
    mutate(o);
    expect(() => parseManualReferenceFile(o)).toThrow(ReferenceFileError);
    expect(() => parseManualReferenceFile(o)).toThrow(message);
  });
  it("tick size is carried only when the entry states one; never defaulted", async () => {
    const f = parseManualReferenceFile(good());
    const withTick = parseManualReferenceFile({ ...good(), contracts: [{ ...first(good()), tickSize: 0.05 }] });
    const q = claim("BUY NIFTY 24500 CE 29 OCT 2026 @ 120 SL 90 TGT 150 PREMIUM");
    const a1 = await assessOptionsClaim(q, createManualReferenceContractMaster(f));
    const a2 = await assessOptionsClaim(q, createManualReferenceContractMaster(withTick));
    expect(a1.verification.status === "verified" && "tickSize" in a1.verification.contract).toBe(false);
    expect(a2.verification.status === "verified" && a2.verification.contract.tickSize).toBe(0.05);
  });
});
