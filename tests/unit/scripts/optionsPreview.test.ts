import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadManualReferenceMaster, loadPremiumProvider, loadSampleReferenceMaster, renderOptionsPreview as renderRaw } from "../../../scripts/options-preview";
import type { OptionsContractMaster } from "../../../packages/signals/src/options/master";
import type { OptionsPremiumProvider } from "../../../packages/signals/src/options/premium";

// The preview's own default is the (empty) MANUAL reference with no premium data. The tests below that exercise the
// matching/labels use the explicit SYNTHETIC SAMPLE reference and sample premium (what --sample-reference selects).
const renderOptionsPreview = (text: string, master: OptionsContractMaster = loadSampleReferenceMaster(), premium: OptionsPremiumProvider = loadPremiumProvider()) =>
  renderRaw(text, master, premium);
const MANUAL_FIXTURE = "tests/fixtures/options/manual-reference.TEST-FIXTURE.json";
const EMPTY_FIXTURE = "tests/fixtures/options/manual-reference.EMPTY-FIXTURE.json";
import { unconfiguredContractMaster } from "../../../packages/signals/src/options/master";
import { unavailablePremiumProvider } from "../../../packages/signals/src/options/premium";

const A = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 210 PREMIUM";
const B = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 210";
const C = "BUY NIFTY 24500 CE 29-OCT-26 ABOVE 120 SL 90 TGT 150 180 210 PREMIUM";
const D = "BUY NIFTYBANK 52000 PE @ 300 SL 250 TGT 350";

describe("renderOptionsPreview (pure, offline)", () => {
  it("A: supported format, explicit PREMIUM, four-digit year", async () => {
    const t = await renderOptionsPreview(A);
    for (const s of [JSON.stringify(A), "telegram-regex-v2", "RECOGNIZED options claim", "NIFTY", "24500", "CE", "2026-10-29 (as written)", "NOT proof that an exchange contract exists",
      "above 120 (a trigger condition, not a fill)", "Level basis:", "premium", "150, 180, 210", "FOUND (exact match in the synthetic sample reference)", "INSUFFICIENT_EVIDENCE", "contract.found_in_local_reference",
      "option_premium_data.unavailable", "approvalPossible:", "false", "long entry presumed", "No order submitted."]) {
      expect(t, s).toContain(s);
    }
    expect(t).toMatch(/Level checks:\s+applied/);
  });

  it("B: same format, level basis unspecified: values kept, reason given, checks skipped", async () => {
    const t = await renderOptionsPreview(B);
    expect(t).toMatch(/Level basis:\s+UNSPECIFIED/);
    expect(t).toContain("level_basis.unspecified");
    expect(t).toMatch(/Level checks:\s+skipped/);
    expect(t).toContain("150, 180, 210");
  });

  it("C: two-digit year is shown as written and unresolved, no century", async () => {
    const t = await renderOptionsPreview(C);
    expect(t).toContain('year written as "26"');
    expect(t).toContain("expiry.year_two_digit_unresolved");
    expect(t).toContain("NOT_ATTEMPTED");
    expect(t).not.toMatch(/Expiry:\s+20\d\d-/); // no resolved date/century in the expiry field
  });

  it("D: unsupported underlying, shown raw, not mapped, not assessed, not sent to the equity parser", async () => {
    const t = await renderOptionsPreview(D);
    expect(t).toContain("UNSUPPORTED options-shaped input");
    expect(t).toMatch(/Raw symbol:\s+NIFTYBANK/);
    expect(t).toContain("not mapped, corrected or guessed");
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toContain("No order submitted.");
    expect(t).not.toMatch(/Underlying:\s+NIFTY\b/);
  });

  it("ambiguous input is reported, and equity text is not parsed by this preview", async () => {
    const amb = await renderOptionsPreview("BUY NIFTY 24500 CE @ 120 SELL BANKNIFTY 52000 PE @ 300");
    expect(amb).toContain("AMBIGUOUS");
    expect(amb).toMatch(/approvalPossible:\s+false/);
    const eq = await renderOptionsPreview("BUY RELIANCE @ 2800 SL 2750 TGT 2900");
    expect(eq).toContain("NOT AN OPTIONS MESSAGE");
    expect(eq).not.toMatch(/RELIANCE\s+(entry|SL)|Entry condition|Stop-loss/);
    expect(eq).toContain("No order submitted.");
  });

  it("the real ':-' multi-line message previews with its targets and stop-loss", async () => {
    const t = await renderOptionsPreview("BUY SENSEX 72500 CE ABOVE 530\n\nTARGET :- 580 / 800\n\nSL :- 400\n\n08 OCTOBER");
    expect(t).toMatch(/Targets \(in order\):\s+580, 800/);
    expect(t).toMatch(/Stop-loss:\s+400/);
    expect(t).toMatch(/Level basis:\s+UNSPECIFIED/);
    expect(t).toContain("day 8, month 10");
    expect(t).not.toMatch(/levels\.(targets|stop)_missing/);
    expect(t).toMatch(/Assessment:\s+INSUFFICIENT_EVIDENCE/);
    expect(t).toMatch(/approvalPossible:\s+false/);
  });

  it("SELL shows an unresolved intent", async () => {
    const t = await renderOptionsPreview("SELL NIFTY 24500 CE 29 OCT 2026 @ 100 SL 120 TGT 80 PREMIUM");
    expect(t).toContain("UNRESOLVED");
    expect(t).toContain("entry.short_option_unsupported");
  });
});

const NOT_AN_ORDER = /No order submitted\./;
const warn = "a local reference is not live entitlement and not a guarantee that the contract is currently tradable";

describe("local reference master in the preview", () => {
  const base = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
  it("FOUND: matched fields, lot size from the reference only, labels, warning, still non-approving", async () => {
    const t = await renderOptionsPreview(base);
    expect(t).toMatch(/Reference type:\s+SYNTHETIC SAMPLE/);
    expect(t).toMatch(/Contract verification:\s+FOUND/);
    expect(t).toMatch(/Matched contract:\s+entry SYNTH-001, expiry 2026-10-29, lot size 9001 \(lot size comes only from the reference\)/);
    expect(t).toMatch(/Reference version:\s+sample-reference-v1/);
    expect(t).toMatch(/Collected as of:\s+2026-10-20/);
    expect(t).toMatch(/Reference source:\s+SYNTHETIC SAMPLE/);
    expect(t).toMatch(/Reference synthetic:\s+YES/);
    expect(t).toContain(warn);
    expect(t).toMatch(/Assessment:\s+INSUFFICIENT_EVIDENCE/);
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toContain("option_premium_data.unavailable");
    expect(t).toMatch(NOT_AN_ORDER);
  });
  it.each([
    ["wrong strike", "BUY NIFTY 24600 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
    ["wrong CE/PE", "BUY NIFTY 24500 PE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
    ["wrong expiry (one day off: no nearest-expiry matching)", "BUY NIFTY 24500 CE 28 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
    ["wrong expiry month", "BUY NIFTY 24500 CE 29 NOV 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
    ["wrong underlying for the contract", "BUY SENSEX 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
  ])("NOT_FOUND: %s", async (_l, text) => {
    const t = await renderOptionsPreview(text);
    expect(t).toMatch(/Contract verification:\s+NOT_FOUND/);
    expect(t).not.toContain("Matched contract:");
    expect(t).not.toMatch(/lot size/);
    expect(t).toContain("contract.not_found");
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toContain(warn);
  });
  it("AMBIGUOUS: duplicate reference entries are reported, none chosen, no lot size shown", async () => {
    const t = await renderOptionsPreview("BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM");
    expect(t).toMatch(/Contract verification:\s+AMBIGUOUS \(2 identical entries/);
    expect(t).toContain("contract.ambiguous");
    expect(t).not.toMatch(/lot size/);
    expect(t).toMatch(/approvalPossible:\s+false/);
  });
  it("alias BANK NIFTY still matches exactly the same entry set (already-supported alias only)", async () => {
    expect(await renderOptionsPreview("BUY BANK NIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM")).toMatch(/AMBIGUOUS/);
  });
  it("incomplete contracts are NOT_ATTEMPTED (no lookup, no nearest guess)", async () => {
    for (const text of ["BUY NIFTY 24500 CE 29 OCT @ 120 SL 90 TGT 150 PREMIUM", "BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 PREMIUM", "BUY NIFTY 24500 CE 29-OCT-26 @ 120 SL 90 TGT 150 PREMIUM"]) {
      const t = await renderOptionsPreview(text);
      expect(t, text).toMatch(/Contract verification:\s+NOT_ATTEMPTED/);
      expect(t, text).not.toContain("Matched contract:");
    }
  });
  it("unsupported underlying is never looked up", async () => {
    const t = await renderOptionsPreview("BUY NIFTYBANK 52000 PE @ 300 SL 250 TGT 350");
    expect(t).toContain("UNSUPPORTED");
    expect(t).not.toMatch(/Contract verification|Matched contract/);
  });
  it("missing master configuration: UNCONFIGURED, no reference labels, still non-approving", async () => {
    const t = await renderOptionsPreview(base, unconfiguredContractMaster);
    expect(t).toMatch(/Contract verification:\s+UNCONFIGURED/);
    expect(t).toContain("contract.master_unconfigured");
    expect(t).not.toMatch(/Reference version|Matched contract/);
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toMatch(NOT_AN_ORDER);
  });
  it("the shipped sample reference file is labelled synthetic with version, source and collected-as-of", () => {
    const m = loadSampleReferenceMaster();
    expect(m.reference).toMatchObject({ version: "sample-reference-v1", synthetic: true, collectedAsOf: "2026-10-20" });
    expect(m.reference?.source).toMatch(/SYNTHETIC SAMPLE/);
    expect(m.isTestFixture).toBe(false);
  });
});

describe("MANUAL verified reference is the default (and never silently falls back to the sample)", () => {
  const full = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
  const manualEmpty = () => loadManualReferenceMaster(EMPTY_FIXTURE); // the shipped file now holds one real entry; emptiness is covered by this fixture
  const manualFixture = () => loadManualReferenceMaster(MANUAL_FIXTURE);

  it("the shipped manual file holds exactly the one transcribed entry, and keeps its manual / not-synthetic / not-live / not-refreshed labels", () => {
    const data = JSON.parse(readFileSync("data/options-reference/manual-reference.v1.json", "utf8")) as Record<string, unknown>;
    expect(data).toMatchObject({ referenceKind: "manual_verified_reference", manuallyMaintained: true, autoRefreshed: false, synthetic: false, liveMarketData: false });
    expect(String(data["tradabilityStatement"])).toMatch(/does NOT prove current tradability/);
    expect(data["contracts"]).toHaveLength(1);
    expect(loadManualReferenceMaster().reference).toMatchObject({ kind: "manual_verified", synthetic: false, entryCount: 1 });
  });

  it("EMPTY manual reference: MANUAL_REFERENCE_EMPTY, no lookup, no fallback to the sample (which DOES contain this contract)", async () => {
    expect(await renderOptionsPreview(full, loadSampleReferenceMaster())).toMatch(/FOUND/); // the sample would match
    const t = await renderRaw(full, manualEmpty());
    expect(t).toMatch(/Reference type:\s+MANUAL VERIFIED REFERENCE/);
    expect(t).toMatch(/Contract verification:\s+MANUAL_REFERENCE_EMPTY/);
    expect(t).toMatch(/Reference entries:\s+0 \(MANUAL_REFERENCE_EMPTY\)/);
    expect(t).toContain("contract.manual_reference_empty");
    expect(t).not.toMatch(/Matched contract|SYNTH-|Reference synthetic:\s+YES/);
    expect(t).toContain("a manual local reference is not live entitlement and does not prove current tradability");
    expect(t).toMatch(/Assessment:\s+INSUFFICIENT_EVIDENCE/);
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toMatch(NOT_AN_ORDER);
  });

  it("manual FOUND: entry id, expiry, lot size and the entry's verified-as-of, source and evidence note", async () => {
    const t = await renderRaw(full, manualFixture());
    expect(t).toMatch(/Reference type:\s+MANUAL VERIFIED REFERENCE/);
    expect(t).toMatch(/Contract verification:\s+FOUND \(exact match in the manual verified reference\)/);
    expect(t).toMatch(/Matched contract:\s+entry TESTFX-1, expiry 2026-10-29, lot size 4321/);
    expect(t).toMatch(/Entry verified as of:\s+2026-10-20/);
    expect(t).toMatch(/Entry source:\s+TEST FIXTURE \(invented\)/);
    expect(t).toMatch(/Entry evidence note:\s+invented for tests/);
    expect(t).toMatch(/Reference version:\s+TEST-FIXTURE-manual-v1/);
    expect(t).toContain("contract.found_in_manual_reference");
    expect(t).toContain("option_premium_data.unavailable");
    expect(t).toMatch(/Premium data:\s+NOT_ATTEMPTED|Premium data:\s+UNAVAILABLE/);
    expect(t).toMatch(/Assessment:\s+INSUFFICIENT_EVIDENCE/);
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toMatch(NOT_AN_ORDER);
  });

  it("manual NOT_FOUND (also when only the SAMPLE would have matched) and no nearest-expiry matching", async () => {
    for (const text of [full.replace("24500", "24600"), full.replace("29 OCT", "30 OCT"), full.replace(" CE ", " PE "), "BUY SENSEX 80000 PE 26 NOV 2026 @ 100 SL 80 TGT 130 PREMIUM"]) {
      const t = await renderRaw(text, manualFixture());
      expect(t, text).toMatch(/Contract verification:\s+NOT_FOUND/);
      expect(t, text).not.toContain("Matched contract:");
    }
  });

  it("manual AMBIGUOUS duplicate: none chosen, no lot size", async () => {
    const t = await renderRaw("BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM", manualFixture());
    expect(t).toMatch(/Contract verification:\s+AMBIGUOUS \(2 identical entries/);
    expect(t).not.toMatch(/lot size|Matched contract/);
  });

  it("incomplete contract is NOT_ATTEMPTED against the manual reference too (empty or not)", async () => {
    for (const m of [manualEmpty(), manualFixture()]) {
      const t = await renderRaw("BUY NIFTY 24500 CE 29 OCT ABOVE 120 SL 90 TGT 150 PREMIUM", m);
      expect(t).toMatch(/Contract verification:\s+NOT_ATTEMPTED/);
      expect(t).not.toMatch(/Matched contract/);
    }
  });

  it("sample premium quotes are never attached to a manual contract unless premium data is explicitly supplied", async () => {
    const t = await renderRaw(full, manualFixture()); // the sample file has a quote for this very identity
    expect(t).not.toContain("Sample quote:");
    expect(t).toMatch(/Premium data:\s+UNAVAILABLE/);
  });

  it("in EVERY manual path: no approval and no order", async () => {
    for (const m of [manualEmpty(), manualFixture()]) {
      for (const text of [full, full.replace("24500", "24600"), "BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 PREMIUM", "BUY NIFTY 24500 CE ABOVE 120", "BUY NIFTYBANK 52000 PE @ 300", "BUY RELIANCE @ 2800"]) {
        const t = await renderRaw(text, m);
        expect(t, text).toMatch(/approvalPossible:\s+false/);
        expect(t, text).toContain("No order submitted.");
        expect(t, text).not.toMatch(/Assessment:\s+APPROVE/);
      }
    }
  });
});

describe("the real manual entry MANUAL-001 (transcribed from a screenshot; not exchange-verified)", () => {
  const exact = "BUY NIFTY 24500 CE 26 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"; // levels are hypothetical parser inputs
  const real = () => loadManualReferenceMaster();
  it("exact lookup: FOUND in the MANUAL reference only, lot size 65 from the entry, evidence caveats shown, premium unavailable, non-approving", async () => {
    const t = await renderRaw(exact, real());
    expect(t).toMatch(/Reference type:\s+MANUAL VERIFIED REFERENCE/);
    expect(t).toMatch(/Contract verification:\s+FOUND \(exact match in the manual verified reference\)/);
    expect(t).toMatch(/Matched contract:\s+entry MANUAL-001, expiry 2026-10-26, lot size 65 \(lot size comes only from the reference\)/);
    expect(t).toMatch(/Entry verified as of:\s+2026-10-20/);
    expect(t).toMatch(/Entry source:\s+Dhan public NIFTY option-chain page, supplied screenshot/);
    expect(t).toContain("not independently exchange-verified");
    expect(t).toContain("Screenshot date is not a quote timestamp");
    expect(t).toMatch(/Reference entries:\s+1\b/);
    expect(t).toMatch(/Premium data:\s+UNAVAILABLE/);
    expect(t).not.toContain("Sample quote:");
    expect(t).toContain("option_premium_data.unavailable");
    expect(t).toMatch(/Assessment:\s+INSUFFICIENT_EVIDENCE/);
    expect(t).toMatch(/approvalPossible:\s+false/);
    expect(t).toContain("No order submitted.");
    expect(t).not.toMatch(/tick size/i);
  });
  it.each([
    ["one day off the expiry (no nearest-expiry)", exact.replace("26 OCT", "27 OCT")],
    ["the old sample expiry", exact.replace("26 OCT", "29 OCT")],
    ["other strike", exact.replace("24500", "24550")],
    ["PE instead of CE", exact.replace(" CE ", " PE ")],
    ["other underlying", exact.replace("NIFTY", "SENSEX")],
  ])("NOT_FOUND - exact matching only: %s", async (_l, text) => {
    const t = await renderRaw(text, real());
    expect(t).toMatch(/Contract verification:\s+NOT_FOUND/);
    expect(t).not.toContain("Matched contract:");
    expect(t).toMatch(/approvalPossible:\s+false/);
  });
  it("an incomplete contract (no year) is not looked up even though a matching entry exists", async () => {
    const t = await renderRaw("BUY NIFTY 24500 CE 26 OCT ABOVE 120 SL 90 TGT 150 PREMIUM", real());
    expect(t).toMatch(/Contract verification:\s+NOT_ATTEMPTED/);
    expect(t).not.toContain("MANUAL-001");
  });
});

describe("premium data in the preview", () => {
  const nonLive = "This is NOT live market data";
  it("quote present: sample quote with every label and the non-live statement, no value judgement", async () => {
    const t = await renderOptionsPreview("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM");
    expect(t).toMatch(/Premium data:\s+SAMPLE QUOTE \(exact match; SYNTHETIC, not live market data\)/);
    expect(t).toMatch(/Sample quote:\s+bid 11\.1, ask 11\.9, last 11\.5/);
    expect(t).toMatch(/Premium version:\s+sample-premium-v1/);
    expect(t).toMatch(/Premium collected:\s+2026-10-20/);
    expect(t).toMatch(/Premium synthetic:\s+YES/);
    expect(t).toContain(nonLive);
    expect(t).toContain("option_premium_data.unavailable"); // unchanged: sample data is not verified live data
    expect(t).toContain("option_premium_data.sample_quote_present");
    const withoutDisclaimer = t.replace(/\(no view is given on whether this is good, cheap, expensive, probable or tradable\)/, "");
    expect(withoutDisclaimer).not.toMatch(/\b(is|looks|seems) (cheap|expensive|good|attractive|fair)\b|\b(recommend|undervalued|overvalued)/i);
  });
  it("quote missing for a FOUND contract: PREMIUM_DATA_NOT_FOUND", async () => {
    const t = await renderOptionsPreview("BUY SENSEX 80000 PE 26 NOV 2026 @ 100 SL 80 TGT 130 PREMIUM");
    expect(t).toMatch(/Contract verification:\s+FOUND/);
    expect(t).toMatch(/Premium data:\s+PREMIUM_DATA_NOT_FOUND/);
    expect(t).not.toContain("Sample quote:");
    expect(t).toContain("option_premium_data.sample_quote_not_found");
  });
  it.each([
    ["NOT_FOUND contract (a quote exists for that identity)", "BUY NIFTY 24600 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM"],
    ["AMBIGUOUS contract (a quote exists)", "BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM"],
    ["incomplete contract", "BUY NIFTY 24500 CE 29 OCT ABOVE 120 SL 90 TGT 150 PREMIUM"],
  ])("no premium lookup: %s", async (_l, text) => {
    const t = await renderOptionsPreview(text);
    expect(t).toMatch(/Premium data:\s+NOT_ATTEMPTED/);
    expect(t).not.toContain("Sample quote:");
    expect(t).not.toMatch(/Premium source:/);
  });
  it("unavailable provider: UNAVAILABLE for a FOUND contract", async () => {
    const t = await renderOptionsPreview("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM", undefined, unavailablePremiumProvider);
    expect(t).toMatch(/Premium data:\s+UNAVAILABLE/);
  });
  it("in EVERY path: no approval and no order", async () => {
    for (const text of [
      "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM", "BUY SENSEX 80000 PE 26 NOV 2026 @ 100 SL 80 TGT 130 PREMIUM", "BUY NIFTY 24600 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM",
      "BUY BANKNIFTY 52000 PE 29 OCT 2026 @ 300 SL 250 TGT 350 PREMIUM", "BUY NIFTY 24500 CE ABOVE 120", "BUY NIFTYBANK 52000 PE @ 300", "SELL NIFTY 24500 CE 29 OCT 2026 @ 100 PREMIUM", "BUY RELIANCE @ 2800",
      "BUY NIFTY 24500 CE @ 120 SELL BANKNIFTY 52000 PE @ 300",
    ]) {
      const t = await renderOptionsPreview(text);
      expect(t, text).toMatch(/approvalPossible:\s+false/);
      expect(t, text).toContain("No order submitted.");
      expect(t, text).not.toMatch(/Assessment:\s+APPROVE/);
    }
  });
});

describe("options-preview command", () => {
  const run = (args: string[], stdin: string) =>
    spawnSync("node_modules/.bin/tsx", ["scripts/options-preview.ts", ...args], {
      input: stdin,
      encoding: "utf8",
      // No secrets and unusable service URLs: the preview must not need or touch them.
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgresql://nobody:x@192.0.2.1:1/none", REDIS_URL: "redis://192.0.2.1:1", LIVE_TRADING: "false" },
      timeout: 60_000,
    });

  it("argument mode: exit 0 for a completed preview, including an unsupported one", () => {
    for (const msg of [A, D]) {
      const r = run([msg], "");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("No order submitted.");
      expect(r.stdout).toMatch(/approvalPossible:\s+false/);
      expect(r.stderr).toBe("");
    }
  }, 120_000);

  it("stdin mode works and gives the same preview", () => {
    const r = run([], `${B}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("level_basis.unspecified");
  }, 60_000);

  it("CLI default = the shipped MANUAL reference (no sample data, no sample premium); --sample-reference is the only way to the synthetic sample; the two flags conflict", () => {
    const REAL = "BUY NIFTY 24500 CE 26 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
    const def = run([REAL], "");
    expect(def.status, def.stderr).toBe(0);
    expect(def.stdout).toMatch(/Reference type:\s+MANUAL VERIFIED REFERENCE/);
    expect(def.stdout).toContain("MANUAL-001");
    expect(def.stdout).not.toContain("SYNTH-001");
    expect(def.stdout).not.toContain("Sample quote:");
    const sample = run(["--sample-reference", A], "");
    expect(sample.status, sample.stderr).toBe(0);
    expect(sample.stdout).toMatch(/Reference type:\s+SYNTHETIC SAMPLE/);
    expect(sample.stdout).toContain("SYNTH-001");
    expect(sample.stdout).toMatch(/SAMPLE QUOTE/);
    const empty = run(["--reference", EMPTY_FIXTURE, A], "");
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain("MANUAL_REFERENCE_EMPTY");
    const manual = run(["--reference", MANUAL_FIXTURE, A], "");
    expect(manual.status, manual.stderr).toBe(0);
    expect(manual.stdout).toContain("TESTFX-1");
    const both = run(["--sample-reference", "--reference", MANUAL_FIXTURE, A], "");
    expect(both.status).toBe(2);
    expect(both.stdout).toBe("");
  }, 120_000);

  it("a missing or malformed reference file is a TOOL failure (exit 1), not an unverified assessment and not a silent fallback", () => {
    const missing = run(["--reference", "/nonexistent/reference.json", A], "");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("FAILED to run (tool error, not an assessment)");
    expect(missing.stdout).toBe("");
    const bad = run(["--reference", "package.json", A], "");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/invalid options reference data: referenceKind must be "manual_verified_reference"/);
    const sampleAsManual = run(["--reference", "data/options-reference/sample-reference.v1.json", A], "");
    expect(sampleAsManual.status).toBe(1); // the synthetic sample cannot masquerade as the manual reference
  }, 60_000);

  it("a missing or malformed premium file is a TOOL failure (exit 1)", () => {
    const missing = run(["--premium", "/nonexistent/premium.json", A], "");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("FAILED to run (tool error, not an assessment)");
    expect(missing.stdout).toBe("");
    const bad = run(["--premium", "data/options-reference/sample-reference.v1.json", A], "");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/invalid options premium data: premiumVersion is required/);
  }, 60_000);

  it("no input is a usage error (exit 2), distinct from a completed preview (exit 0)", () => {
    const r = run([], "   \n");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stdout).toBe("");
  }, 60_000);

  it("is offline by construction: imports only the parser/assessor, no database, queue, network or fixture code", () => {
    const src = readFileSync("scripts/options-preview.ts", "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      ["node:fs", "node:path", "node:url", "../packages/signals/src/extract", "../packages/signals/src/options/assess", "../packages/signals/src/options/master", "../packages/signals/src/options/premium", "../packages/signals/src/options/providerSnapshot", "../packages/signals/src/options/referenceMaster", "../packages/signals/src/options/samplePremium", "../packages/signals/src/options/types"].sort(),
    );
    expect(src).not.toMatch(/fixtureMaster|process\.env|fetch\(|node:net|node:http|bullmq|ioredis|from "pg"|drizzle/);
  });
});
