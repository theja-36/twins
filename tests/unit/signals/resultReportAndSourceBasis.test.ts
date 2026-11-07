import { describe, expect, it } from "vitest";
import {
  analyzeTelegramText, analyzeTelegramTextV2, applySourceDefaultBasis, hasResultWording, NO_SOURCE_BASIS, parseSourceBasisConfig, SHIPPED_TELEGRAM_PARSERS, SourceBasisConfigError,
  TELEGRAM_PARSER_VERSION, TELEGRAM_PARSER_VERSION_V2, type OptionsClaim,
} from "../../../packages/signals/src/index";
import { normalizeText } from "../../../packages/historical/src/normalize";
import { batchKeyOf } from "../../../packages/historical/src/prepare";
import type { InputFile } from "../../../packages/historical/src/readers";

// SYNTHETIC texts that mimic the SHAPES of the two message families seen in capture; no real message is quoted.
const REPORTS = [
  "120 - 190 HIT IN NIFTY CALL \u{1F3AF}\u{1F3AF}\n\nEASY 70+ POINTS GAINS ✅\n\nALL TARGET ACHIEVED \u{1F525}\n\nGAINING RS 5,000",
  "100 - 160 HIT IN BANKNIFTY PUT\n\nEASY 60 POINTS GAINS\n\n1ST TARGET ACHIEVED\n\nGAINING RS 3,000/-",
  "NIFTY 24500 CE PROFIT BOOKED",
];
const SIGNAL = "BUY SENSEX 80000 CE ABOVE 300\n\nTARGET :- 350 / 400\n\nSL :- 250\n\n12 NOVEMBER EXPIRY";

describe("parser v3: report of past results is not a signal", () => {
  it("is the current version and v2 stays shipped", () => {
    expect(TELEGRAM_PARSER_VERSION).toBe("telegram-regex-v3");
    expect(Object.keys(SHIPPED_TELEGRAM_PARSERS).sort()).toEqual(["telegram-regex-v1", TELEGRAM_PARSER_VERSION_V2, TELEGRAM_PARSER_VERSION].sort());
  });
  it("classifies result reports as no signal with a reason, while v2 still returns the empty claim", () => {
    for (const t of REPORTS) {
      expect(hasResultWording(t)).toBe(true);
      expect(analyzeTelegramText(t)).toEqual({ kind: "none", reason: "result_report" });
      expect(analyzeTelegramTextV2(t).kind).toBe("options_claim"); // old behaviour preserved under the old version
    }
  });
  it("never drops a message with a BUY/SELL action, whatever else it says", () => {
    for (const t of [SIGNAL, `${REPORTS[0]}\nBUY NIFTY 24500 CE ABOVE 120 SL 90 TGT 150`, "SELL NIFTY 24500 PE PROFIT BOOKED", "BUY NIFTY 24500 CE TARGET DONE"]) {
      expect(analyzeTelegramText(t).kind).not.toBe("none");
    }
  });
  it("never drops a message that carries an entry level, even without BUY/SELL", () => {
    expect(analyzeTelegramText("NIFTY 24500 CE @ 120 SL 90 TGT 150 PROFIT SOON").kind).toBe("options_claim");
    expect(analyzeTelegramText("NIFTY 24500 CE ABOVE 120 TGT 150 GAIN").kind).toBe("options_claim");
  });
  it("leaves a claim with no result wording alone", () => {
    expect(analyzeTelegramText("NIFTY 24500 CE").kind).toBe("options_claim");
    expect(analyzeTelegramText("NIFTY 24500 CE EXPIRY 12 NOV").kind).toBe("options_claim");
  });
  it("leaves equity signals and plain noise exactly as before", () => {
    expect(analyzeTelegramText("BUY RELIANCE @ 2800 SL 2750 TGT 2900").kind).toBe("signal");
    expect(analyzeTelegramText("Good morning, markets look calm").kind).toBe("none");
    expect(analyzeTelegramText("Good morning, markets look calm")).toEqual(analyzeTelegramTextV2("Good morning, markets look calm"));
  });
  it("property: any text containing a BUY or SELL word is never classified as a result report", () => {
    let s = 3; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const words = ["HIT", "PROFIT", "TARGET", "ACHIEVED", "NIFTY", "24500", "CE", "PE", "ABOVE", "SL", "GAINING", "RS", "5,000", "BOOKED", "DONE", "EXPIRY", "NOV", "@", "120"];
    for (let i = 0; i < 3000; i++) {
      const n = 3 + Math.floor(rnd() * 10);
      const parts = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)] as string);
      parts.splice(Math.floor(rnd() * parts.length), 0, rnd() < 0.5 ? "BUY" : "SELL");
      const a = analyzeTelegramText(parts.join(" "));
      expect(a.kind === "none" && a.reason === "result_report").toBe(false);
    }
  });
});

const claim = (o: Partial<OptionsClaim> = {}): OptionsClaim => {
  const a = analyzeTelegramText(SIGNAL);
  if (a.kind !== "options_claim") throw new Error("fixture");
  return { ...a.claim, ...o };
};
const cfg = parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: "chan-1=premium" });

describe("per-source default level basis (premium)", () => {
  it("the fixture is a silent-basis claim with a stop far below the strike", () => {
    const c = claim();
    expect(c).toMatchObject({ levelBasis: "unspecified", stopLoss: 250, strike: 80000 });
  });
  it("applies only to a configured source, records the inference, and changes nothing else", () => {
    const c = claim();
    const out = applySourceDefaultBasis(c, "chan-1", cfg);
    expect(out.levelBasis).toBe("premium");
    expect(out.levelBasisInference).toMatchObject({ rule: "source-default-premium-v1", sourceDefault: "premium", maxStopPctOfStrike: 10 });
    expect(out.levelBasisInference?.stopPctOfStrike).toBeCloseTo(0.3125, 3);
    expect({ ...out, levelBasis: "unspecified", levelBasisInference: undefined }).toEqual({ ...c, levelBasisInference: undefined });
    expect(applySourceDefaultBasis(c, "other", cfg)).toBe(c);
    expect(applySourceDefaultBasis(c, null, cfg)).toBe(c);
    expect(applySourceDefaultBasis(c, "chan-1", NO_SOURCE_BASIS)).toBe(c);
  });
  it("is blocked by every guard", () => {
    expect(applySourceDefaultBasis(claim({ stopLoss: 8000 }), "chan-1", cfg).levelBasis).toBe("unspecified"); // exactly 10%: not below
    expect(applySourceDefaultBasis(claim({ stopLoss: 79000 }), "chan-1", cfg).levelBasis).toBe("unspecified"); // underlying-like
    expect(applySourceDefaultBasis(claim({ stopLoss: null }), "chan-1", cfg).levelBasis).toBe("unspecified");
    expect(applySourceDefaultBasis(claim({ strike: null }), "chan-1", cfg).levelBasis).toBe("unspecified");
    expect(applySourceDefaultBasis(claim({ levelBasisConflict: true }), "chan-1", cfg).levelBasis).toBe("unspecified");
    expect(applySourceDefaultBasis(claim({ levelBasis: "underlying" }), "chan-1", cfg).levelBasis).toBe("underlying"); // a stated basis always wins
    expect(applySourceDefaultBasis(claim({ levelBasis: "premium" }), "chan-1", cfg)).toEqual(claim({ levelBasis: "premium" }));
  });
  it("config: empty means none; malformed or non-premium entries fail closed", () => {
    expect(parseSourceBasisConfig({}).premiumSources.size).toBe(0);
    expect(parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: "  " }).premiumSources.size).toBe(0);
    expect([...parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: "a=premium, b c =premium" }).premiumSources]).toEqual(["a", "b c"]);
    for (const bad of ["a", "a=underlying", "=premium", "a=premium,b", "a;b=premium"]) expect(() => parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: bad })).toThrow(SourceBasisConfigError);
    expect(() => parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: "a=premium" }, 50)).toThrow(SourceBasisConfigError);
  });
});

describe("historical normalizer with the new rules", () => {
  const ctx = { recordMarket: "NSE", defaultMarket: null };
  it("a result report becomes NO_SIGNAL with a result_report warning", () => {
    const n = normalizeText(REPORTS[0] as string, ctx);
    expect(n).toMatchObject({ parseStatus: "NO_SIGNAL", validationResult: "NOT_A_SIGNAL" });
    expect(n.warnings).toContain("result_report");
  });
  it("without a configured source the stop basis stays unspecified; with one it is premium, valid and flagged", () => {
    const plain = normalizeText(SIGNAL, ctx);
    expect(plain.levelBasis).toBe("unspecified");
    expect(plain.stopLossValidation?.result).toBe("AMBIGUOUS");
    const inferred = normalizeText(SIGNAL, { ...ctx, source: "chan-1", sourceBasis: cfg });
    expect(inferred.levelBasis).toBe("premium");
    expect(inferred.warnings).toContain("level_basis_inferred_source_default");
    expect(inferred.stopLossValidation?.result).not.toBe("AMBIGUOUS");
    expect((inferred.parsed as { levelBasisInference?: unknown }).levelBasisInference).toBeDefined();
    expect(normalizeText(SIGNAL, { ...ctx, source: "someone-else", sourceBasis: cfg }).levelBasis).toBe("unspecified");
  });
  it("batch identity is unchanged when no source is configured and differs when one is", () => {
    const files: InputFile[] = [{ path: "/x", name: "x.jsonl", format: "jsonl", sha256: "a".repeat(64), bytes: 10 }];
    const base = batchKeyOf(files, { label: "l", defaultMarket: "NSE" });
    expect(batchKeyOf(files, { label: "l", defaultMarket: "NSE", sourceBasis: NO_SOURCE_BASIS })).toBe(base);
    expect(batchKeyOf(files, { label: "l", defaultMarket: "NSE", sourceBasis: cfg })).not.toBe(base);
  });
});
