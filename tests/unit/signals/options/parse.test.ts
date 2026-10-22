import { describe, expect, it } from "vitest";
import { analyzeOptionsText } from "../../../../packages/signals/src/options/parse";
import type { OptionsClaim } from "../../../../packages/signals/src/options/types";
import { analyzeTelegramText, parseTelegramSignal } from "../../../../packages/signals/src/extract";

function claimOf(text: string): OptionsClaim {
  const a = analyzeOptionsText(text);
  if (a.kind !== "options_claim") throw new Error(`expected options_claim, got ${a.kind}`);
  return a.claim;
}

describe("options claim parsing", () => {
  it("complete premium-labelled example: every field kept separate", () => {
    const c = claimOf("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 210 premium levels");
    expect(c).toMatchObject({
      action: "buy", intent: "long_entry_presumed", underlying: "NIFTY", strike: 24500, optionType: "CE",
      expiry: { status: "full", day: 29, month: 10, year: 2026 },
      entry: { type: "above", price: 120 }, stopLoss: 90, targets: [150, 180, 210],
      levelBasis: "premium", impliedUnderlyingView: "bullish",
    });
  });

  it("the same example with no level-basis marker keeps the values and leaves the basis unspecified", () => {
    const c = claimOf("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 210");
    expect(c.levelBasis).toBe("unspecified");
    expect(c).toMatchObject({ entry: { type: "above", price: 120 }, stopLoss: 90, targets: [150, 180, 210] });
  });

  it.each([
    ["BUY NIFTY24500CE @ 120 SL 90 TGT 150", "NIFTY", 24500, "CE"],
    ["BUY BANKNIFTY 52000PE @ 300 SL 250 TGT 350", "BANKNIFTY", 52000, "PE"],
    ["BUY SENSEX CE 80000 @ 500 SL 400 TGT 600", "SENSEX", 80000, "CE"],
    ["BUY NIFTY 24500 CALL @ 120 SL 90 TGT 150", "NIFTY", 24500, "CE"],
    ["BUY BANKNIFTY 26OCT52000PE @ 300 SL 250 TGT 350", "BANKNIFTY", 52000, "PE"],
  ])("compact and spaced strike/type forms: %s", (text, underlying, strike, type) => {
    expect(claimOf(text)).toMatchObject({ underlying, strike, optionType: type });
  });

  it("accepts the explicit alias BANK NIFTY and normalizes it; no other alias is invented", () => {
    const c = claimOf("buy bank nifty 52000 pe @ 300 sl 250 tgt 350");
    expect(c).toMatchObject({ underlying: "BANKNIFTY", underlyingAliasUsed: true, optionType: "PE" });
    expect(analyzeOptionsText("BUY NIFTYBANK 52000 PE @ 300").kind).toBe("none"); // not an accepted alias
    expect(analyzeOptionsText("BUY FINNIFTY 23000 CE @ 100").kind).toBe("none"); // unsupported underlying
  });

  it("missing expiry, missing year, weekly/monthly words: nothing is inferred or resolved", () => {
    expect(claimOf("BUY NIFTY 24500 CE @ 120 SL 90 TGT 150").expiry).toEqual({ status: "missing" });
    expect(claimOf("BUY NIFTY 24500 CE 29 OCT @ 120 SL 90 TGT 150").expiry).toMatchObject({ status: "day_month", day: 29, month: 10 });
    expect(claimOf("BUY NIFTY 24500 CE WEEKLY @ 120 SL 90 TGT 150").expiry).toEqual({ status: "period_word", word: "WEEKLY" });
    expect(claimOf("BUY NIFTY 24500 CE next month @ 120 SL 90 TGT 150").expiry.status).toBe("period_word");
  });

  it("impossible dates are invalid; a leap day without a year stays unresolved; with a year it is checked", () => {
    expect(claimOf("BUY NIFTY 24500 CE 30 FEB 2026 @ 120").expiry.status).toBe("invalid");
    expect(claimOf("BUY NIFTY 24500 CE 31 APR 2026 @ 120").expiry.status).toBe("invalid");
    expect(claimOf("BUY NIFTY 24500 CE 29 FEB @ 120").expiry).toMatchObject({ status: "year_dependent", day: 29, month: 2 });
    expect(claimOf("BUY NIFTY 24500 CE 29 FEB 2028 @ 120").expiry).toMatchObject({ status: "full", year: 2028 });
    expect(claimOf("BUY NIFTY 24500 CE 29 FEB 2026 @ 120").expiry.status).toBe("invalid"); // 2026 is not a leap year
  });

  it("an unrecognized compact weekly-style code is flagged, not decoded", () => {
    const c = claimOf("BUY NIFTY2610824500CE @ 120");
    expect(c.compactCodeUnrecognized).toBe(true);
    expect(c.strike).toBeNull();
  });

  it("entry conditions are preserved as conditions: above, below, near, range, market", () => {
    expect(claimOf("BUY NIFTY 24500 CE ABOVE 120 SL 90 TGT 150").entry).toEqual({ type: "above", price: 120 });
    expect(claimOf("BUY NIFTY 24500 CE BELOW 120 SL 90 TGT 150").entry).toEqual({ type: "below", price: 120 });
    expect(claimOf("BUY NIFTY 24500 CE NEAR 120 SL 90 TGT 150").entry).toEqual({ type: "near", price: 120 });
    expect(claimOf("BUY NIFTY 24500 CE @ 120-125 SL 90 TGT 150").entry).toEqual({ type: "range", low: 120, high: 125 });
    expect(claimOf("BUY NIFTY 24500 CE CMP SL 90 TGT 150").entry).toEqual({ type: "market" });
  });

  it("BUY PE: action, option type, implied underlying view and level basis stay separate", () => {
    const c = claimOf("BUY NIFTY 24500 PE @ 100 SL 80 TGT 130 premium");
    expect(c).toMatchObject({ action: "buy", optionType: "PE", impliedUnderlyingView: "bearish", levelBasis: "premium" });
  });

  it("SELL is parsed but its intent stays unresolved and no underlying view is derived", () => {
    const c = claimOf("SELL NIFTY 24500 CE @ 100 SL 120 TGT 80");
    expect(c).toMatchObject({ action: "sell", intent: "unresolved", impliedUnderlyingView: "unresolved" });
  });

  it("multiple directives or contracts are ambiguous, never merged", () => {
    expect(analyzeOptionsText("BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 and BUY BANKNIFTY 52000 PE @ 300").kind).toBe("ambiguous");
    expect(analyzeOptionsText("BUY NIFTY 24500 CE @ 120 SELL NIFTY 24500 CE @ 150").kind).toBe("ambiguous");
    expect(analyzeOptionsText("BUY NIFTY 24500 CE or 24600 CE @ 120 SL 90 TGT 150").kind).toBe("ambiguous");
    expect(analyzeOptionsText("BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 BUY RELIANCE @ 2800").kind).toBe("ambiguous");
  });

  it("CE and PE in one directive is a conflict, not a guess", () => {
    const c = claimOf("BUY NIFTY 24500 CE PE @ 120");
    expect(c).toMatchObject({ optionType: null, optionTypeConflict: true });
  });
});

describe("equity path protection (telegram-regex-v2)", () => {
  it("options text never becomes an equity signal for the underlying", () => {
    for (const text of ["BUY NIFTY 24500 CE @ 120 SL 90 TGT 150", "BUY NIFTY24500CE @ 120", "buy bank nifty 52000 pe @ 300", "BUY NIFTY @ 24500 SL 24400 TGT 24600", "BUY SENSEX 80000 @ 500"]) {
      expect(analyzeTelegramText(text).kind, text).not.toBe("signal");
    }
  });
  it("a bare index underlying with no options fields is held back (ambiguous), not an equity", () => {
    expect(analyzeTelegramText("BUY NIFTY @ 24500 SL 24400 TGT 24600").kind).not.toBe("signal");
  });
  it("normal equity parsing is unchanged, including NIFTY-prefixed ETF symbols", () => {
    const a = analyzeTelegramText("BUY RELIANCE @ 2800 SL 2750 TGT 2900");
    expect(a).toEqual({ kind: "signal", signal: parseTelegramSignal("BUY RELIANCE @ 2800 SL 2750 TGT 2900") });
    expect(a.kind === "signal" && a.signal).toMatchObject({ direction: "buy", symbol: "RELIANCE", entryPrice: 2800, stopLoss: 2750, targets: [2900] });
    expect(analyzeTelegramText("BUY NIFTYBEES @ 250 SL 240 TGT 270").kind).toBe("signal");
    expect(analyzeTelegramText("hello world").kind).toBe("none");
    expect(analyzeTelegramText("BUY RELIANCE @ 2800 SELL TCS @ 3500").kind).toBe("ambiguous");
  });
});

describe("options-shaped input with an unsupported underlying (never reaches the equity resolver)", () => {
  it.each([
    ["BUY NIFTYBANK 52000 PE @ 300 SL 250 TGT 350", "NIFTYBANK"],
    ["BUY NIFTYBANK52000PE @ 300", "NIFTYBANK"],
    ["buy finnifty 23000 ce @ 100 sl 80 tgt 130", "FINNIFTY"],
    ["BUY TCS 3500 PE @ 40 SL 30 TGT 60", "TCS"],
    ["SELL RELIANCE 29 OCT 2900 CE @ 50", "RELIANCE"],
    ["BUY TCS26OCT3500CE @ 40", "TCS"],
    ["BUY TCS CE 3500 @ 40", "TCS"],
    ["BUY SOMETHING2610824500CE @ 100", "SOMETHING"],
  ])("held back as unsupported options input, underlying not mapped: %s", (text, symbol) => {
    const a = analyzeTelegramText(text);
    expect(a.kind, text).toBe("options_unsupported");
    expect(a.kind === "options_unsupported" && a.symbol).toBe(symbol);
  });

  it("ordinary equity text and prose are NOT caught by the structural detector", () => {
    for (const text of [
      "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
      "BUY PEL @ 1000 SL 950 TGT 1100",
      "BUY CEATLTD @ 2500 SL 2400 TGT 2700",
      "BUY TCS @ 3500 SL 3400 TGT 3700 PE ratio is high",
      "BUY HDFCBANK @ 1500 SL 1450 TGT 1600 (see PE chart)",
      "BUY ICICIBANK @ 1100 SL 1050 TGT 1200 for the ceasefire rally",
    ]) {
      expect(analyzeTelegramText(text).kind, text).toBe("signal");
    }
  });

  it("an unsupported options directive next to another directive is ambiguous", () => {
    expect(analyzeTelegramText("BUY TCS 3500 PE @ 40 SELL RELIANCE @ 2800").kind).toBe("ambiguous");
  });

  it("without any BUY/SELL the equity parser could not have created a signal anyway (documented limit)", () => {
    expect(analyzeTelegramText("NIFTYBANK 52000 PE @ 300").kind).toBe("none");
  });
});

describe("two-digit years are never expanded to a century", () => {
  it.each([
    ["BUY NIFTY 24500 CE 29-OCT-26 @ 120", 29, 10, 26],
    ["BUY NIFTY 24500 CE 29 OCT'26 @ 120", 29, 10, 26],
    ["BUY NIFTY 24500 CE 29/OCT/26 @ 120", 29, 10, 26],
  ])("kept as written and unresolved: %s", (text, day, month, yy) => {
    const e = claimOf(text).expiry;
    expect(e.status).toBe("year_two_digit");
    expect(e).toMatchObject({ day, month, twoDigitYear: yy });
    expect(JSON.stringify(e)).not.toMatch(/"year"|2026|2126/);
  });
  it("a four-digit year is accepted as written; an unattached or spaced two-digit number is not interpreted as a year", () => {
    expect(claimOf("BUY NIFTY 24500 CE 29 OCT 2026 @ 120").expiry).toMatchObject({ status: "full", year: 2026 });
    expect(claimOf("BUY NIFTY 24500 CE 29 OCT 26 @ 120").expiry.status).toBe("day_month");
    expect(claimOf("BUY BANKNIFTY26OCT52000PE @ 300").expiry.status).toBe("day_month");
  });
});

describe("Telegram-style labels with ':-' separators (SL / TARGET / TGT / STOPLOSS)", () => {
  const REAL = "BUY SENSEX 72500 CE ABOVE 530\n\nTARGET :- 580 / 800\n\nSL :- 400\n\n08 OCTOBER";

  it("the real multi-line message: targets, stop-loss, entry, expiry; basis and year are NOT inferred", () => {
    const c = claimOf(REAL);
    expect(c).toMatchObject({
      underlying: "SENSEX", strike: 72500, optionType: "CE", entry: { type: "above", price: 530 },
      stopLoss: 400, targets: [580, 800], levelBasis: "unspecified", expiry: { status: "day_month", day: 8, month: 10 },
    });
  });

  it.each([
    ["same-line TARGET :-", "BUY NIFTY 24500 CE ABOVE 120 TARGET :- 150 / 180 SL :- 90", 90, [150, 180]],
    ["next-line TARGET :-", "BUY NIFTY 24500 CE ABOVE 120\nTARGET :-\n150 / 180\nSL :-\n90", 90, [150, 180]],
    ["same-line TGT :-", "BUY NIFTY 24500 CE ABOVE 120 TGT :- 150/180/210 SL :- 90", 90, [150, 180, 210]],
    ["STOPLOSS :-", "BUY NIFTY 24500 CE ABOVE 120 TGT 150 STOPLOSS :- 90", 90, [150]],
    ["STOP LOSS :-", "BUY NIFTY 24500 CE ABOVE 120 TGT 150 STOP LOSS :- 90", 90, [150]],
    ["next-line SL after blank lines", "BUY NIFTY 24500 CE ABOVE 120\n\nTGT :- 150\n\nSTOP LOSS :-\n\n90", 90, [150]],
    ["colon only", "BUY NIFTY 24500 CE ABOVE 120 TARGET: 150, 180 SL: 90", 90, [150, 180]],
    ["hyphen only", "BUY NIFTY 24500 CE ABOVE 120 TGT - 150 SL - 90", 90, [150]],
  ])("%s", (_l, text, sl, targets) => {
    const c = claimOf(text);
    expect(c.stopLoss).toBe(sl);
    expect(c.targets).toEqual(targets);
    expect(c.levelBasis).toBe("unspecified");
    expect(c.entry).toEqual({ type: "above", price: 120 });
  });

  it("targets keep their written order, including a descending list (order is never sorted)", () => {
    expect(claimOf("BUY NIFTY 24500 PE ABOVE 120 TARGET :- 180 / 150 SL :- 90").targets).toEqual([180, 150]);
  });

  it("existing compact forms are unchanged", () => {
    expect(claimOf("BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 180 210")).toMatchObject({ stopLoss: 90, targets: [150, 180, 210], entry: { type: "at", price: 120 } });
    expect(claimOf("BUY NIFTY 24500 CE @ 120 STOP LOSS 90 TARGETS 150, 180")).toMatchObject({ stopLoss: 90, targets: [150, 180] });
    expect(claimOf("BUY BANKNIFTY 52000 PE @ 300 SL: 250 TGT: 350")).toMatchObject({ stopLoss: 250, targets: [350] });
  });

  it("a range written with a hyphen is not mistaken for a label separator", () => {
    expect(claimOf("BUY NIFTY 24500 CE @ 120-125 SL 90 TGT 150-180").entry).toEqual({ type: "range", low: 120, high: 125 });
  });
});

describe("which ambiguous results are options-related (only those are recorded as options claims)", () => {
  it("options directives mixed with others, and unsupported-underlying shapes mixed with others, are options-related", () => {
    for (const text of ["BUY NIFTY 24500 CE @ 120 SELL BANKNIFTY 52000 PE @ 300", "BUY NIFTY 24500 CE @ 120 BUY RELIANCE @ 2800", "BUY TCS 3500 PE @ 40 SELL RELIANCE @ 2800"]) {
      const a = analyzeTelegramText(text);
      expect(a.kind, text).toBe("ambiguous");
      expect(a.kind === "ambiguous" && a.optionsRelated, text).toBe(true);
    }
  });
  it("equity-only ambiguity is not options-related", () => {
    const a = analyzeTelegramText("BUY RELIANCE @ 2800 SELL TCS @ 3500");
    expect(a.kind === "ambiguous" && a.optionsRelated).toBeFalsy();
  });
});
