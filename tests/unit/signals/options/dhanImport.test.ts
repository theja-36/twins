import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeTelegramText } from "../../../../packages/signals/src/extract";
import { assessOptionsClaim } from "../../../../packages/signals/src/options/assess";
import { buildDhanSnapshot, DhanImportError, expiryDatePart, parseCsv } from "../../../../packages/signals/src/options/dhanImport";
import { createProviderSnapshotContractMaster, parseProviderSnapshotFile, ProviderSnapshotError } from "../../../../packages/signals/src/options/providerSnapshot";
import { unavailablePremiumProvider } from "../../../../packages/signals/src/options/premium";

const detailed = readFileSync("tests/fixtures/options/dhan-detailed.TEST-FIXTURE.csv", "utf8");
const compact = readFileSync("tests/fixtures/options/dhan-compact.TEST-FIXTURE.csv", "utf8");
const base = { sourceUrl: "https://example.invalid/test-fixture.csv", retrievedAt: "2026-10-20T10:00:00Z", retrievalTimeSource: "owner_supplied" as const, importedAt: "2026-10-21T00:00:00Z" };
const snap = () => buildDhanSnapshot({ ...base, csvText: detailed });
const master = () => createProviderSnapshotContractMaster(parseProviderSnapshotFile(JSON.parse(JSON.stringify(snap()))));
const q = (o: Partial<{ underlying: "NIFTY" | "SENSEX"; strike: number; optionType: "CE" | "PE"; y: number; m: number; d: number }> = {}) =>
  ({ underlying: o.underlying ?? "NIFTY", strike: o.strike ?? 24500, optionType: o.optionType ?? "CE", expiry: { status: "full" as const, year: o.y ?? 2026, month: o.m ?? 10, day: o.d ?? 27 } });

describe("Dhan CSV import (offline fixtures)", () => {
  it("imports supported rows, preserving supplied identity fields and raw tick size", () => {
    const s = snap();
    const c = s.contracts.find((x) => x.securityId === "900001")!;
    expect(c).toMatchObject({ provider: "dhan", exchange: "NSE", segment: "D", instrument: "OPTIDX", underlyingSymbol: "NIFTY", underlyingSecurityId: "13", strike: 24500, optionType: "CE", expiryDate: "2026-10-27", expiryRaw: "2026-10-27 14:30:00", lotSize: 65, tickSizeRaw: "5.0" });
    expect(s.counts.kept).toBe(6);
    expect(s.counts.skipped).toEqual({ not_index_option: 1 });
    expect(s.counts.rejected).toMatchObject({ expiry_unrecognised: 1, lot_size_invalid: 1, strike_invalid_or_not_integer: 1, option_type_invalid: 1 });
    expect(s.source.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.source.csvFormat).toBe("dhan-detailed");
    expect(s.statement).toMatch(/NOT exchange-independent verification/);
  });
  it("omits tick size when not supplied rather than inventing one", () => {
    expect(snap().contracts.find((x) => x.securityId === "900006")!.tickSizeRaw).toBeUndefined();
  });
  it("accepts integral values written with decimals (observed real format) and rejects genuinely fractional ones", () => {
    const h = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,\n";
    const row = (strike: string, lot: string) => `NSE,D,1,OPTIDX,26000,NIFTY,TESTFIXTURE,TESTFIXTURE,${lot},2026-10-27,${strike},CE,5.0000,\n`;
    const s = buildDhanSnapshot({ ...base, csvText: h + row("24500.00000", "65.0") + row("24500.50000", "65.0") + row("24600.00000", "65.5") });
    expect(s.contracts).toHaveLength(1);
    expect(s.contracts[0]).toMatchObject({ strike: 24500, lotSize: 65, tickSizeRaw: "5.0000" });
    expect(s.counts.rejected).toEqual({ strike_invalid_or_not_integer: 1, lot_size_invalid: 1 });
  });
  it("reads the compact layout and keeps the hash stable for identical content", () => {
    const c = buildDhanSnapshot({ ...base, csvText: compact });
    expect(c.source.csvFormat).toBe("dhan-compact");
    expect(c.contracts[0]).toMatchObject({ underlyingSymbol: "NIFTY", lotSize: 65, securityId: "910001" });
    expect(snap().source.contentSha256).toBe(snap().source.contentSha256);
  });
  it("refuses unknown headers, empty input, non-https source and bad retrieval time", () => {
    expect(() => buildDhanSnapshot({ ...base, csvText: "A,B\n1,2\n" })).toThrow(DhanImportError);
    expect(() => buildDhanSnapshot({ ...base, csvText: "" })).toThrow(DhanImportError);
    expect(() => buildDhanSnapshot({ ...base, csvText: detailed, sourceUrl: "http://x" })).toThrow(/https/);
    expect(() => buildDhanSnapshot({ ...base, csvText: detailed, retrievedAt: "nope" })).toThrow(/retrievedAt/);
  });
  it("recognises only strict expiry shapes and never infers", () => {
    expect(expiryDatePart("2026-10-27 14:30:00")).toBe("2026-10-27");
    expect(expiryDatePart("2026-10-27")).toBe("2026-10-27");
    for (const bad of ["27-Oct-2026", "27/10/26", "2026-02-30", "", "Oct 2026"]) expect(expiryDatePart(bad), bad).toBeNull();
  });
  it("parses quoted CSV and rejects an unterminated quote", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n1,2,3\n')).toEqual([["a", "b,c", 'd"e'], ["1", "2", "3"]]);
    expect(() => parseCsv('a,"b\n')).toThrow(DhanImportError);
  });
});

describe("provider snapshot master (exact match only)", () => {
  it("verifies an exact match and carries provider identity; never claims exchange verification", async () => {
    const v = await master().lookup(q());
    expect(v.status).toBe("verified");
    if (v.status !== "verified") return;
    expect(v.contract).toMatchObject({ expiryDate: "2026-10-27", lotSize: 65, contractId: "900001", tickSizeRaw: "5.0", providerIdentity: { provider: "dhan", exchange: "NSE", segment: "D", instrument: "OPTIDX" } });
    expect(v.reference?.kind).toBe("provider_snapshot");
    expect(v.reference?.snapshot).toMatchObject({ retrievedAt: "2026-10-20T10:00:00Z", importerVersion: "dhan-importer-v1" });
  });
  it("does not choose a nearest expiry, nearest strike or other side", async () => {
    const m = master();
    expect((await m.lookup(q({ d: 28 }))).status).toBe("not_found");
    expect((await m.lookup(q({ strike: 24550 }))).status).toBe("not_found");
    expect((await m.lookup(q({ strike: 24600 }))).status).toBe("not_found"); // rejected row is absent
    expect((await m.lookup(q({ strike: 24500, optionType: "PE", d: 27 }))).status).toBe("verified");
    expect((await m.lookup(q({ underlying: "SENSEX" }))).status).toBe("not_found");
  });
  it("reports duplicates as ambiguous, not as a verified match", async () => {
    expect(await master().lookup(q({ strike: 25000, m: 11, d: 3 }))).toEqual({ status: "ambiguous", candidates: 2 });
  });
  it("an empty snapshot is reference_empty", async () => {
    const f = parseProviderSnapshotFile({ ...JSON.parse(JSON.stringify(snap())), contracts: [] });
    expect((await createProviderSnapshotContractMaster(f).lookup(q())).status).toBe("reference_empty");
  });
  it("rejects malformed snapshot files", () => {
    type Mut = { liveMarketData?: boolean; statement?: string; synthetic?: boolean; source: { contentSha256: string; sourceUrl: string }; contracts: { lotSize: number; expiryDate: string }[] };
    const ok = JSON.parse(JSON.stringify(snap()));
    for (const mut of [(o: Mut) => { o.liveMarketData = true; }, (o: Mut) => { o.statement = "verified"; }, (o: Mut) => { o.source.contentSha256 = "x"; }, (o: Mut) => { o.contracts[0].lotSize = 0; }, (o: Mut) => { o.contracts[0].expiryDate = "2026-13-01"; }, (o: Mut) => { o.source.sourceUrl = "http://x"; }, (o: Mut) => { delete o.synthetic; }]) {
      const copy = JSON.parse(JSON.stringify(ok)); mut(copy);
      expect(() => parseProviderSnapshotFile(copy)).toThrow(ProviderSnapshotError);
    }
  });
});

describe("assessment with a provider snapshot", () => {
  const assess = async (text: string) => {
    const a = analyzeTelegramText(text);
    if (a.kind !== "options_claim") throw new Error("not a claim");
    return assessOptionsClaim(a.claim, master(), unavailablePremiumProvider);
  };
  it("labels a match as provider-listed only and never approves", async () => {
    const r = await assess("BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 180");
    expect(r.approvalPossible).toBe(false);
    const code = r.reasons.find((x) => x.code === "contract.found_in_provider_snapshot");
    expect(code?.description).toMatch(/PROVIDER-LISTED ONLY/);
    expect(code?.description).toMatch(/not exchange-independent verification/);
  });
  it("a missing year or day/month-only expiry is not looked up", async () => {
    const r = await assess("BUY NIFTY 24500 CE 27 OCT ABOVE 120 SL 90 TGT 150 180");
    expect(r.reasons.some((x) => x.code === "contract.found_in_provider_snapshot")).toBe(false);
    expect(r.verification.status).toBe("not_attempted");
  });
});

describe("repository hygiene", () => {
  it("keeps fixtures tiny and ships no full provider dataset", () => {
    for (const f of readdirSync("tests/fixtures/options").filter((n) => n.includes("dhan"))) {
      expect(f).toContain("TEST-FIXTURE");
      expect(statSync(`tests/fixtures/options/${f}`).size).toBeLessThan(4000);
    }
  });
  it("importer, snapshot master and CLI contain no network code and no download", () => {
    for (const f of ["packages/signals/src/options/dhanImport.ts", "packages/signals/src/options/providerSnapshot.ts", "scripts/options-import-dhan.ts"]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\bfetch\s*\(|node:https?|node:net|axios|undici|XMLHttpRequest|child_process/);
    }
  });
  it("the worker enables a snapshot only via explicit configuration", () => {
    const w = readFileSync("services/worker/src/index.ts", "utf8");
    expect(w).toMatch(/TWINS_OPTIONS_PROVIDER_SNAPSHOT/);
    expect(w).toMatch(/both set; configure exactly one/);
  });
});
