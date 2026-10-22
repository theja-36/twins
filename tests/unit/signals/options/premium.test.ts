import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessOptionsClaim } from "../../../../packages/signals/src/options/assess";
import { analyzeOptionsText } from "../../../../packages/signals/src/options/parse";
import { unavailablePremiumProvider } from "../../../../packages/signals/src/options/premium";
import { createReferenceContractMaster, parseReferenceFile } from "../../../../packages/signals/src/options/referenceMaster";
import { createSamplePremiumProvider, parsePremiumFile, PremiumFileError } from "../../../../packages/signals/src/options/samplePremium";

const refFile = parseReferenceFile(JSON.parse(readFileSync("data/options-reference/sample-reference.v1.json", "utf8")));
const premFile = parsePremiumFile(JSON.parse(readFileSync("data/options-reference/sample-premium.v1.json", "utf8")));
const master = createReferenceContractMaster(refFile);
const provider = createSamplePremiumProvider(premFile);
const claim = (t: string) => {
  const a = analyzeOptionsText(t);
  if (a.kind !== "options_claim") throw new Error(a.kind);
  return a.claim;
};
const assess = (t: string, p = provider) => assessOptionsClaim(claim(t), master, p);
const codes = (a: Awaited<ReturnType<typeof assess>>) => a.reasons.map((r) => r.code);
const NIFTY = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";

describe("premium provider and assessment", () => {
  it("FOUND contract with a matching sample quote: quote shown, labelled, but the claim stays uncorroborated and non-approving", async () => {
    const a = await assess(NIFTY);
    expect(a.verification.status).toBe("verified");
    expect(a.premium).toMatchObject({ status: "sample_quote", quote: { bid: 11.1, ask: 11.9, last: 11.5 }, source: { version: "sample-premium-v1", synthetic: true, collectedAsOf: "2026-10-20" } });
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.approvalPossible).toBe(false);
    // 'sample present' is distinct from 'verified live premium data': the unavailable reason is NOT removed
    expect(codes(a)).toEqual(expect.arrayContaining(["option_premium_data.unavailable", "option_premium_data.sample_quote_present"]));
  });

  it("FOUND contract without a quote: not_found (exact only; no neighbour, no interpolation)", async () => {
    const a = await assess("BUY SENSEX 80000 PE 26 NOV 2026 @ 100 SL 80 TGT 130 PREMIUM");
    expect(a.verification.status).toBe("verified");
    expect(a.premium).toEqual({ status: "not_found" });
    expect(codes(a)).toEqual(expect.arrayContaining(["option_premium_data.unavailable", "option_premium_data.sample_quote_not_found"]));
    expect(a.approvalPossible).toBe(false);
  });

  it("NOT_FOUND contract: premium is NOT looked up even though a quote exists for that identity", async () => {
    const a = await assess("BUY NIFTY 24600 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"); // 24600 CE has a sample quote but no reference entry
    expect(a.verification).toEqual({ status: "not_found" });
    expect(a.premium.status).toBe("not_attempted");
    expect(codes(a)).not.toContain("option_premium_data.sample_quote_present");
  });

  it("AMBIGUOUS contract: premium is NOT looked up even though a quote exists", async () => {
    const a = await assess("BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM");
    expect(a.verification.status).toBe("ambiguous");
    expect(a.premium.status).toBe("not_attempted");
  });

  it("incomplete contract (no year / no expiry / two-digit year): premium is NOT looked up", async () => {
    for (const t of ["BUY NIFTY 24500 CE 29 OCT ABOVE 120 SL 90 TGT 150 PREMIUM", "BUY NIFTY 24500 CE ABOVE 120 SL 90 TGT 150 PREMIUM", "BUY NIFTY 24500 CE 29-OCT-26 ABOVE 120 SL 90 TGT 150 PREMIUM"]) {
      const a = await assess(t);
      expect(a.verification.status, t).toBe("not_attempted");
      expect(a.premium.status, t).toBe("not_attempted");
    }
  });

  it("default provider is explicitly UNAVAILABLE, even for a FOUND contract", async () => {
    const a = await assess(NIFTY, unavailablePremiumProvider);
    expect(a.premium).toEqual({ status: "unavailable" });
    expect(codes(a)).toContain("option_premium_data.unavailable");
    expect(a.approvalPossible).toBe(false);
  });

  it("matching is exact: a different strike, type or expiry never returns a neighbouring quote", async () => {
    for (const [q, label] of [
      [{ strike: 24550 }, "strike"], [{ optionType: "PE" as const }, "type"], [{ expiryDate: "2026-10-28" }, "expiry day"], [{ expiryDate: "2026-11-26" }, "expiry month"], [{ underlying: "SENSEX" as const }, "underlying"],
    ] as const) {
      expect(await provider.lookup({ underlying: "NIFTY", strike: 24500, optionType: "CE", expiryDate: "2026-10-29", ...q }), label).toEqual({ status: "not_found" });
    }
  });
});

describe("premium file validation (strict)", () => {
  const good = () => JSON.parse(readFileSync("data/options-reference/sample-premium.v1.json", "utf8")) as Record<string, unknown>;
  const q0 = (o: Record<string, unknown>): Record<string, unknown> => {
    const q = (o["quotes"] as Array<Record<string, unknown>>)[0];
    if (!q) throw new Error("no quote");
    return q;
  };
  it.each([
    ["no version", (o: Record<string, unknown>) => { delete o["premiumVersion"]; }, /premiumVersion is required/],
    ["no source label", (o: Record<string, unknown>) => { delete o["sourceLabel"]; }, /sourceLabel is required/],
    ["bad collected-as-of", (o: Record<string, unknown>) => { o["collectedAsOf"] = "yesterday"; }, /collectedAsOf must be an ISO date/],
    ["synthetic not true", (o: Record<string, unknown>) => { o["synthetic"] = false; }, /synthetic must be true/],
    ["claims live data", (o: Record<string, unknown>) => { o["liveMarketData"] = true; }, /liveMarketData must be false/],
    ["no not-live statement", (o: Record<string, unknown>) => { o["notLiveStatement"] = "these are quotes"; }, /notLiveStatement/],
    ["bad underlying", (o: Record<string, unknown>) => { q0(o)["underlying"] = "FINNIFTY"; }, /quotes\[0\]\.underlying/],
    ["bad expiry", (o: Record<string, unknown>) => { q0(o)["expiryDate"] = "2026-02-30"; }, /quotes\[0\]\.expiryDate/],
    ["negative price", (o: Record<string, unknown>) => { q0(o)["bid"] = -1; }, /quotes\[0\]\.bid/],
    ["ask below bid", (o: Record<string, unknown>) => { q0(o)["bid"] = 50; q0(o)["ask"] = 40; }, /ask is below bid/],
    ["no price at all", (o: Record<string, unknown>) => { const q = q0(o); delete q["bid"]; delete q["ask"]; delete q["last"]; }, /at least one of bid, ask, last/],
    ["duplicate identity", (o: Record<string, unknown>) => { (o["quotes"] as unknown[]).push({ ...q0(o) }); }, /repeats an earlier contract identity/],
  ])("rejects: %s", (_l, mutate, message) => {
    const o = good();
    mutate(o);
    expect(() => parsePremiumFile(o)).toThrow(PremiumFileError);
    expect(() => parsePremiumFile(o)).toThrow(message);
  });
  it("the shipped sample is labelled synthetic, versioned, dated, explicitly not live, and has no Greeks/IV/probability fields", () => {
    expect(premFile).toMatchObject({ premiumVersion: "sample-premium-v1", collectedAsOf: "2026-10-20", synthetic: true, liveMarketData: false });
    expect(premFile.notLiveStatement).toMatch(/NOT live market data/);
    expect(JSON.stringify(good())).not.toMatch(/delta|gamma|theta|vega|iv\b|implied|probab|recommend/i);
    expect(premFile.quotes.length).toBeLessThanOrEqual(5);
  });
});
