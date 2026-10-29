import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RISK_PCT,
  STOP_LOSS_REASONS,
  STOP_LOSS_RULE_VERSION,
  StopLossInvariantError,
  assertStopLossAllowsEligibility,
  isExecutionEligibleState,
  loadStopLossConfig,
  parseLevel,
  validateOptionsClaimStopLoss,
  validateStopLoss,
  type StopLossInput,
  type StopLossReason,
  type StopLossResult,
} from "../../../packages/stop-loss/src/index";

const equity = (over: Partial<StopLossInput> = {}): StopLossInput => ({ instrumentType: "equity", side: "buy", stopLoss: 95, entryPrice: 100, ...over });
/** An option premium level set: BUY CE entry 120, SL 90 by default. */
const option = (over: Partial<StopLossInput> = {}): StopLossInput => ({ instrumentType: "option", side: "buy", optionType: "CE", stopLoss: 90, entryPrice: 120, levelBasis: "premium", ...over });

function expectOutcome(input: StopLossInput, result: StopLossResult, reason: StopLossReason | null, detail?: string): void {
  const v = validateStopLoss(input);
  expect({ result: v.result, reason: v.reasonCode }).toEqual({ result, reason });
  if (detail !== undefined) expect(v.detail).toBe(detail);
  expect(v.ruleVersion).toBe(STOP_LOSS_RULE_VERSION);
  // the contract: VALID has no reason code; everything else has one
  expect(v.reasonCode === null).toBe(v.result === "VALID");
}

describe("stop-loss presence and numeric validity (all failures are non-VALID with a machine-readable reason)", () => {
  it.each([
    ["missing (undefined)", undefined],
    ["null", null],
    ["empty string", ""],
    ["blank string", "   \t"],
  ])("%s -> MISSING_STOP_LOSS", (_n, stopLoss) => {
    expectOutcome(equity({ stopLoss }), "MISSING", "MISSING_STOP_LOSS", "absent_or_blank");
    expectOutcome(option({ stopLoss }), "MISSING", "MISSING_STOP_LOSS");
  });
  it.each([
    ["zero", 0, "zero"],
    ["zero string", "0", "zero"],
    ["zero decimal string", "0.00", "zero"],
    ["negative number", -5, "negative"],
    ["negative string", "-5", "negative"],
    ["negative zero string", "-0", "zero"],
    ["non-numeric text", "abc", "non_numeric"],
    ["number with a unit", "90rs", "non_numeric"],
    ["hex", "0x5A", "non_numeric"],
    ["exponent", "9e1", "non_numeric"],
    ["thousands separator", "1,000", "non_numeric"],
    ["leading plus", "+90", "non_numeric"],
    ["object", { price: 90 }, "non_numeric"],
    ["array", [90], "non_numeric"],
    ["boolean", true, "non_numeric"],
    ["NaN", Number.NaN, "not_finite"],
    ["Infinity", Number.POSITIVE_INFINITY, "not_finite"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "not_finite"],
  ])("%s -> INVALID_STOP_LOSS (%s)", (_n, stopLoss, detail) => {
    expectOutcome(equity({ stopLoss }), "INVALID", "INVALID_STOP_LOSS", detail);
    expectOutcome(option({ stopLoss }), "INVALID", "INVALID_STOP_LOSS", detail);
  });
  it("a numeric string is normalized, and the original is preserved as text", () => {
    const v = validateStopLoss(equity({ stopLoss: " 95.50 " }));
    expect(v).toMatchObject({ result: "VALID", normalizedStopLoss: 95.5, originalStopLoss: " 95.50 " });
    expect(parseLevel("95.5")).toEqual({ ok: true, value: 95.5 });
  });
});

describe("stock and futures: long below the entry, short above it", () => {
  it.each([["equity"], ["future"], ["EQUITY"], [" Future "]])("valid BUY stop below the entry (%s)", (instrumentType) => {
    const v = validateStopLoss(equity({ instrumentType }));
    expect(v).toMatchObject({ result: "VALID", reasonCode: null, normalizedStopLoss: 95, entryPrice: 100, riskDistance: 5, riskPct: 5, expectedStopSide: "below" });
  });
  it("valid SELL stop above the entry", () => {
    expect(validateStopLoss(equity({ side: "sell", stopLoss: 105 }))).toMatchObject({ result: "VALID", expectedStopSide: "above", riskPct: 5 });
    expect(validateStopLoss(equity({ instrumentType: "future", side: "sell", stopLoss: "108.5" })).result).toBe("VALID");
  });
  it("stop equal to the entry is not a stop", () => {
    expectOutcome(equity({ stopLoss: 100 }), "INVALID", "STOP_LOSS_EQUALS_ENTRY");
    expectOutcome(equity({ side: "sell", stopLoss: "100.0" }), "INVALID", "STOP_LOSS_EQUALS_ENTRY");
  });
  it("wrong side for BUY (above the entry) and for SELL (below the entry)", () => {
    expectOutcome(equity({ stopLoss: 105 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID", "wrong_side_expected_below");
    expectOutcome(equity({ side: "sell", stopLoss: 95 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID", "wrong_side_expected_above");
  });
  it("beyond the maximum risk distance (default 10% for equity and futures; boundary inclusive)", () => {
    expectOutcome(equity({ stopLoss: 89.99 }), "INVALID", "STOP_LOSS_TOO_FAR");
    expect(validateStopLoss(equity({ stopLoss: 90 })).result).toBe("VALID"); // exactly 10%
    expectOutcome(equity({ side: "sell", stopLoss: 111 }), "INVALID", "STOP_LOSS_TOO_FAR");
    const tight = loadStopLossConfig({ TWINS_STOPLOSS_MAX_RISK_PCT_EQUITY: "2.5" });
    expect(validateStopLoss(equity({ stopLoss: 95 }), tight)).toMatchObject({ result: "INVALID", reasonCode: "STOP_LOSS_TOO_FAR", maxRiskPct: 2.5, maxRiskSource: "env" });
  });
  it("no usable entry/reference price: cannot be shown valid (AMBIGUOUS), never VALID", () => {
    for (const entryPrice of [undefined, null, "", 0, -3, Number.NaN, "abc"]) expectOutcome(equity({ entryPrice }), "AMBIGUOUS", "STOP_LOSS_REFERENCE_MISSING");
  });
  it("unsupported instrument types and unknown sides are AMBIGUOUS, not valid", () => {
    for (const instrumentType of ["index", "fx", "commodity", "", null, undefined, 7]) expectOutcome(equity({ instrumentType }), "AMBIGUOUS", "UNSUPPORTED_INSTRUMENT_TYPE");
    for (const side of ["hold", "BUY", null, undefined, 1]) expectOutcome(equity({ side }), "AMBIGUOUS", "UNSUPPORTED_TRADE_SIDE");
  });
  it("the order of checks is fixed: a missing stop wins over a missing reference, an invalid stop over a wrong side", () => {
    expectOutcome(equity({ stopLoss: null, entryPrice: null }), "MISSING", "MISSING_STOP_LOSS");
    expectOutcome(equity({ stopLoss: -1, entryPrice: null }), "INVALID", "INVALID_STOP_LOSS");
  });
});

describe("options: validated against the option PREMIUM, with BUY/SELL and CE/PE semantics", () => {
  it("valid BUY CE: stop below the entry premium", () => {
    expect(validateStopLoss(option())).toMatchObject({ result: "VALID", reasonCode: null, levelBasis: "premium", instrumentKind: "option", normalizedStopLoss: 90, entryPrice: 120, riskPct: 25, expectedStopSide: "below" });
  });
  it("valid SELL PE: a short premium position's stop is ABOVE the entry premium", () => {
    expect(validateStopLoss(option({ side: "sell", optionType: "PE", stopLoss: 150, entryPrice: 120 }))).toMatchObject({ result: "VALID", expectedStopSide: "above", riskPct: 25 });
  });
  it("valid BUY PE and valid SELL CE (premium basis is the same direction for CE and PE)", () => {
    expect(validateStopLoss(option({ optionType: "PE" })).result).toBe("VALID");
    expect(validateStopLoss(option({ side: "sell", optionType: "CE", stopLoss: 150 })).result).toBe("VALID");
  });
  it("wrong side for CE and for PE (BUY with the stop above the premium; SELL with the stop below)", () => {
    expectOutcome(option({ optionType: "CE", stopLoss: 140 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(option({ optionType: "PE", stopLoss: 140 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(option({ side: "sell", optionType: "CE", stopLoss: 100 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(option({ side: "sell", optionType: "PE", stopLoss: 100 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
  });
  it("equal to the entry premium, and beyond the maximum premium risk (default 70%)", () => {
    expectOutcome(option({ stopLoss: 120 }), "INVALID", "STOP_LOSS_EQUALS_ENTRY");
    expectOutcome(option({ stopLoss: 30 }), "INVALID", "STOP_LOSS_TOO_FAR"); // 75% of the premium
    expect(validateStopLoss(option({ stopLoss: 36 })).result).toBe("VALID"); // exactly 70%
    expect(DEFAULT_MAX_RISK_PCT.option).toBe(70);
  });
  it("levels without a stated basis cannot be validated against the premium (AMBIGUOUS)", () => {
    for (const levelBasis of ["unspecified", undefined, null, "price", "bogus"]) expectOutcome(option({ levelBasis }), "AMBIGUOUS", "STOP_LOSS_BASIS_UNSPECIFIED");
  });
  it("underlying-basis levels: the CE/PE direction is checked, but a stop on the underlying is never valid for the option (STOP_LOSS_NOT_PREMIUM_BASIS)", () => {
    const u = (over: Partial<StopLossInput>): StopLossInput => option({ levelBasis: "underlying", entryPrice: 24500, ...over });
    // BUY CE and SELL PE are bullish: stop below the underlying entry; BUY PE and SELL CE are bearish: above
    expectOutcome(u({ side: "buy", optionType: "CE", stopLoss: 24300 }), "AMBIGUOUS", "STOP_LOSS_NOT_PREMIUM_BASIS");
    expectOutcome(u({ side: "sell", optionType: "PE", stopLoss: 24300 }), "AMBIGUOUS", "STOP_LOSS_NOT_PREMIUM_BASIS");
    expectOutcome(u({ side: "buy", optionType: "PE", stopLoss: 24700 }), "AMBIGUOUS", "STOP_LOSS_NOT_PREMIUM_BASIS");
    expectOutcome(u({ side: "sell", optionType: "CE", stopLoss: 24700 }), "AMBIGUOUS", "STOP_LOSS_NOT_PREMIUM_BASIS");
    // wrong underlying side for CE / PE
    expectOutcome(u({ side: "buy", optionType: "CE", stopLoss: 24700 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(u({ side: "buy", optionType: "PE", stopLoss: 24300 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(u({ side: "sell", optionType: "CE", stopLoss: 24300 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(u({ side: "sell", optionType: "PE", stopLoss: 24700 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(u({ optionType: null, stopLoss: 24300 }), "AMBIGUOUS", "STOP_LOSS_BASIS_UNSPECIFIED", "option_type_missing");
  });
  it("a range entry: the stop must clear the whole range and risk is measured from the farthest bound", () => {
    expect(validateStopLoss(option({ entryPrice: undefined, entryLow: 110, entryHigh: 120, stopLoss: 100 }))).toMatchObject({ result: "VALID", entryPrice: 120, riskDistance: 20 });
    expectOutcome(option({ entryPrice: undefined, entryLow: 110, entryHigh: 120, stopLoss: 115 }), "INVALID", "STOP_LOSS_EQUALS_ENTRY", "inside_entry_range");
    expectOutcome(option({ entryPrice: undefined, entryLow: 110, entryHigh: 120, stopLoss: 125 }), "INVALID", "STOP_LOSS_DIRECTION_INVALID");
    expectOutcome(option({ entryPrice: undefined, entryLow: 120, entryHigh: 110 }), "AMBIGUOUS", "STOP_LOSS_REFERENCE_MISSING"); // inverted range
    expect(validateStopLoss(option({ side: "sell", entryPrice: undefined, entryLow: 110, entryHigh: 120, stopLoss: 130 }))).toMatchObject({ result: "VALID", entryPrice: 110 });
  });
});

describe("options claims (the parsed shape)", () => {
  const claim = (over: Record<string, unknown> = {}) => ({ action: "buy", optionType: "CE", stopLoss: 90, levelBasis: "premium", entry: { type: "above", price: 120 }, ...over });
  it("valid, and each failure maps to the right reason", () => {
    expect(validateOptionsClaimStopLoss(claim())).toMatchObject({ result: "VALID", instrumentKind: "option" });
    expect(validateOptionsClaimStopLoss(claim({ stopLoss: null })).reasonCode).toBe("MISSING_STOP_LOSS");
    expect(validateOptionsClaimStopLoss(claim({ stopLoss: 0 })).reasonCode).toBe("INVALID_STOP_LOSS");
    expect(validateOptionsClaimStopLoss(claim({ stopLoss: 130 })).reasonCode).toBe("STOP_LOSS_DIRECTION_INVALID");
    expect(validateOptionsClaimStopLoss(claim({ levelBasis: "unspecified" })).reasonCode).toBe("STOP_LOSS_BASIS_UNSPECIFIED");
    expect(validateOptionsClaimStopLoss(claim({ entry: { type: "unspecified" } })).reasonCode).toBe("STOP_LOSS_REFERENCE_MISSING");
    expect(validateOptionsClaimStopLoss(claim({ entry: { type: "market" } })).reasonCode).toBe("STOP_LOSS_REFERENCE_MISSING");
    expect(validateOptionsClaimStopLoss(claim({ entry: { type: "range", low: 110, high: 120 }, stopLoss: 100 })).result).toBe("VALID");
    expect(validateOptionsClaimStopLoss(claim({ action: null })).reasonCode).toBe("UNSUPPORTED_TRADE_SIDE");
  });
  it("garbage input never validates", () => {
    for (const bad of [null, undefined, 5, "x", [], {}]) expect(validateOptionsClaimStopLoss(bad).result).not.toBe("VALID");
  });
});

describe("evidence content and configuration", () => {
  it("every result carries the evidence fields the audit trail stores", () => {
    const v = validateStopLoss(option({ stopLoss: "90" }));
    expect(v).toMatchObject({
      ruleVersion: "stop-loss-v1", result: "VALID", reasonCode: null, instrumentType: "option", instrumentKind: "option", side: "buy", optionType: "CE", levelBasis: "premium",
      originalStopLoss: "90", normalizedStopLoss: 90, entryPrice: 120, riskDistance: 30, riskPct: 25, maxRiskPct: 70, maxRiskSource: "default", expectedStopSide: "below",
    });
    const bad = validateStopLoss(equity({ stopLoss: "abc" }));
    expect(bad).toMatchObject({ originalStopLoss: "abc", normalizedStopLoss: null, reasonCode: "INVALID_STOP_LOSS" });
  });
  it("the reason codes are the documented closed set", () => {
    expect([...STOP_LOSS_REASONS].sort()).toEqual(["INVALID_STOP_LOSS", "MISSING_STOP_LOSS", "STOP_LOSS_BASIS_UNSPECIFIED", "STOP_LOSS_DIRECTION_INVALID", "STOP_LOSS_EQUALS_ENTRY", "STOP_LOSS_NOT_PREMIUM_BASIS", "STOP_LOSS_REFERENCE_MISSING", "STOP_LOSS_TOO_FAR", "UNSUPPORTED_INSTRUMENT_TYPE", "UNSUPPORTED_TRADE_SIDE"]);
  });
  it("the maximum-risk configuration comes from the environment; a malformed value throws instead of falling back", () => {
    expect(loadStopLossConfig({})).toMatchObject({ maxRiskPct: { equity: 10, future: 10, option: 70 }, source: { equity: "default", future: "default", option: "default" } });
    expect(loadStopLossConfig({ TWINS_STOPLOSS_MAX_RISK_PCT_OPTION: "50", TWINS_STOPLOSS_MAX_RISK_PCT_FUTURE: "" })).toMatchObject({ maxRiskPct: { option: 50, future: 10 }, source: { option: "env", future: "default" } });
    for (const bad of ["0", "-5", "101", "abc", "1e2", "10%", "NaN", " 10"]) expect(() => loadStopLossConfig({ TWINS_STOPLOSS_MAX_RISK_PCT_EQUITY: bad }), bad).toThrow(/TWINS_STOPLOSS_MAX_RISK_PCT_EQUITY/);
  });
});

describe("eligibility: no approval-class state without a VALID stop-loss", () => {
  const valid = validateStopLoss(equity());
  const missing = validateStopLoss(equity({ stopLoss: null }));
  const ambiguous = validateStopLoss(equity({ entryPrice: null }));
  it("APPROVE and QUALIFIED require a VALID validation", () => {
    for (const state of ["APPROVE", "QUALIFIED"]) {
      expect(() => assertStopLossAllowsEligibility(state, valid)).not.toThrow();
      for (const v of [missing, ambiguous, validateStopLoss(equity({ stopLoss: -1 })), undefined, null]) expect(() => assertStopLossAllowsEligibility(state, v)).toThrow(StopLossInvariantError);
    }
  });
  it("other states (REJECT, INSUFFICIENT_EVIDENCE, WAIT, NO_TRADE...) and CONDITIONAL are never execution-eligible and never need the rule to be produced", () => {
    for (const state of ["REJECT", "INSUFFICIENT_EVIDENCE", "WAIT", "NO_TRADE", "ALTERNATIVE_CANDIDATE", "CONDITIONAL"]) {
      expect(isExecutionEligibleState(state), state).toBe(false);
      expect(() => assertStopLossAllowsEligibility(state, missing)).not.toThrow();
    }
    expect(isExecutionEligibleState("APPROVE")).toBe(true);
    expect(isExecutionEligibleState("QUALIFIED")).toBe(true);
  });
});
