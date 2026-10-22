import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeOptionsText } from "../../../../packages/signals/src/options/parse";
import { assessOptionsClaim } from "../../../../packages/signals/src/options/assess";
import type { OptionsClaim } from "../../../../packages/signals/src/options/types";
import { testFixtureMaster } from "../../../fixtures/options/fixtureMaster";

const claim = (t: string): OptionsClaim => {
  const a = analyzeOptionsText(t);
  if (a.kind !== "options_claim") throw new Error(a.kind);
  return a.claim;
};
const codes = async (t: string, master?: typeof testFixtureMaster) => (await assessOptionsClaim(claim(t), master)).reasons.map((r) => r.code);

describe("options claim assessment (no APPROVE is possible)", () => {
  it("complete premium-labelled claim, unconfigured master: INSUFFICIENT_EVIDENCE, master_unconfigured, premium data unavailable", async () => {
    const a = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 premium"));
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.approvalPossible).toBe(false);
    expect(a.levelChecks).toBe("applied");
    expect(a.verification).toEqual({ status: "unconfigured" });
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["contract.master_unconfigured", "option_premium_data.unavailable"]));
  });

  it("same claim with no level-basis marker: INSUFFICIENT_EVIDENCE with a clear reason, level checks skipped, values preserved", async () => {
    const c = claim("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180");
    const a = await assessOptionsClaim(c);
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.levelChecks).toBe("skipped");
    expect(a.reasons.map((r) => r.code)).toContain("level_basis.unspecified");
    expect(c.targets).toEqual([150, 180]);
  });

  it("missing expiry / missing year / period word / leap day are reported, not resolved", async () => {
    expect(await codes("BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 premium")).toContain("expiry.missing");
    expect(await codes("BUY NIFTY 24500 CE 29 OCT @ 120 SL 90 TGT 150 premium")).toContain("expiry.year_missing");
    expect(await codes("BUY NIFTY 24500 CE MONTHLY @ 120 SL 90 TGT 150 premium")).toContain("expiry.period_word");
    expect(await codes("BUY NIFTY 24500 CE 29 FEB @ 120 SL 90 TGT 150 premium")).toContain("expiry.year_dependent");
  });

  it("the real ':-' message: targets and stop are present (no *_missing reasons); basis, year and approval stay unresolved", async () => {
    const a = await assessOptionsClaim(claim("BUY SENSEX 72500 CE ABOVE 530\n\nTARGET :- 580 / 800\n\nSL :- 400\n\n08 OCTOBER"));
    const codes = a.reasons.map((r) => r.code);
    expect(codes).not.toContain("levels.targets_missing");
    expect(codes).not.toContain("levels.stop_missing");
    expect(codes).toEqual(expect.arrayContaining(["level_basis.unspecified", "expiry.year_missing"]));
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.approvalPossible).toBe(false);
    expect(a.levelChecks).toBe("skipped");
  });

  it("a two-digit year stays unresolved: reported, never sent to the master, approval impossible", async () => {
    const a = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 29-OCT-26 @ 120 SL 90 TGT 150 premium"), testFixtureMaster);
    expect(a.reasons.map((r) => r.code)).toContain("expiry.year_two_digit_unresolved");
    expect(a.verification.status).toBe("not_attempted");
    expect(a.approvalPossible).toBe(false);
  });

  it("an impossible date is REJECTed", async () => {
    const a = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 30 FEB 2026 @ 120 SL 90 TGT 150 premium"));
    expect(a.outcome).toBe("REJECT");
    expect(a.reasons.map((r) => r.code)).toContain("expiry.invalid_date");
  });

  it("premium ordering is applied only with a premium basis; BUY premium: SL below entry, targets rising (CE and PE alike)", async () => {
    expect(await codes("BUY NIFTY 24500 CE 29 OCT 2026 @ 120 SL 130 TGT 150 premium")).toContain("levels.stop_wrong_side");
    expect(await codes("BUY NIFTY 24500 PE 29 OCT 2026 @ 120 SL 130 TGT 150 premium")).toContain("levels.stop_wrong_side");
    expect(await codes("BUY NIFTY 24500 CE 29 OCT 2026 @ 120 SL 90 TGT 150 140 premium")).toContain("levels.targets_inconsistent");
    expect((await codes("BUY NIFTY 24500 PE 29 OCT 2026 @ 120 SL 90 TGT 150 180 premium")).filter((c) => c.startsWith("levels."))).toEqual([]);
  });

  it("underlying-basis levels follow the implied view; the BUY-premium rule is not applied to them", async () => {
    // BUY PE with underlying levels: bearish view, so falling levels are consistent (SL above entry, targets below)
    const ok = await assessOptionsClaim(claim("BUY NIFTY 24500 PE 29 OCT 2026 @ 24600 SL 24700 TGT 24500 24400 underlying"));
    expect(ok.reasons.map((r) => r.code)).not.toContain("levels.stop_wrong_side");
    expect(ok.levelChecks).toBe("applied");
    // the same numbers read as a premium would be inconsistent - they must not be judged that way
    const bad = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 29 OCT 2026 @ 24600 SL 24700 TGT 24500 spot"));
    expect(bad.reasons.map((r) => r.code)).toContain("levels.stop_wrong_side"); // bullish view: SL above entry is wrong
  });

  it("ranges and triggers are conditions: a range needs SL below its low and targets above its high", async () => {
    expect(await codes("BUY NIFTY 24500 CE 29 OCT 2026 @ 120-125 SL 118 TGT 130 premium")).not.toContain("levels.stop_wrong_side");
    expect(await codes("BUY NIFTY 24500 CE 29 OCT 2026 @ 120-125 SL 122 TGT 130 premium")).toContain("levels.stop_wrong_side");
  });

  it("SELL: unresolved intent and unsupported fresh short entry; no level rule is applied", async () => {
    const a = await assessOptionsClaim(claim("SELL NIFTY 24500 CE 29 OCT 2026 @ 100 SL 120 TGT 80 premium"));
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["action.sell_intent_unresolved", "entry.short_option_unsupported"]));
    expect(a.levelChecks).toBe("skipped");
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("test-fixture master: found / not-found / ambiguous - and APPROVE is still impossible", async () => {
    const found = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 29 OCT 2026 @ 120 SL 90 TGT 150 premium"), testFixtureMaster);
    expect(found.verification).toMatchObject({ status: "verified", testFixture: true, masterName: "OFFLINE-TEST-FIXTURE" });
    expect(found.reasons.map((r) => r.code)).toContain("contract.verified_by_test_fixture");
    expect(found.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(found.approvalPossible).toBe(false);
    const missing = await assessOptionsClaim(claim("BUY NIFTY 25000 CE 29 OCT 2026 @ 120 SL 90 TGT 150 premium"), testFixtureMaster);
    expect(missing.verification).toEqual({ status: "not_found" });
    const ambiguous = await assessOptionsClaim(claim("BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 premium"), testFixtureMaster);
    expect(ambiguous.verification).toEqual({ status: "ambiguous", candidates: 2 });
    expect(ambiguous.reasons.map((r) => r.code)).toContain("contract.ambiguous");
  });

  it("the master is not even consulted for an incomplete contract (no expiry year)", async () => {
    const a = await assessOptionsClaim(claim("BUY NIFTY 24500 CE 29 OCT @ 120 SL 90 TGT 150 premium"), testFixtureMaster);
    expect(a.verification.status).toBe("not_attempted");
  });
});

describe("production code embeds no contract data", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const prod = files("packages/signals/src/options");

  it("has no lot-size table, contract calendar, fabricated probability, or fixture master", () => {
    for (const f of prod) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/lotSize\s*[:=]\s*\d/);
      expect(src, f).not.toMatch(/tickSize\s*[:=]\s*\d/);
      expect(src, f).not.toMatch(/OFFLINE-TEST-FIXTURE|TEST-FIXTURE-/);
      expect(src, f).not.toMatch(/probability\s*[:=]\s*[\d.]/i);
      expect(src, f).not.toMatch(/expiryDate\s*[:=]\s*["'`]\d{4}-\d{2}-\d{2}/);
    }
  });
  it("no production module imports the test fixture master", () => {
    for (const f of [...files("packages"), ...files("services"), ...files("apps")]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/fixtures\/options\/fixtureMaster/);
    }
  });
});
