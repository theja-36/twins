/**
 * Offline OPTIONS signal claims (NIFTY / BANKNIFTY / SENSEX). A claim is what a message SAYS, field by field, with
 * every absent or ambiguous field kept explicit. Nothing here is verified against an exchange contract, and no
 * expiry date, year, contract id, lot size, tick size or probability is ever supplied by this code.
 */
export const SUPPORTED_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
export type Underlying = (typeof SUPPORTED_UNDERLYINGS)[number];
export type OptionType = "CE" | "PE";
export type OptionAction = "buy" | "sell";

/** What the quoted entry/SL/target numbers refer to. Never defaulted: it must be stated in the message. */
export type LevelBasis = "premium" | "underlying" | "unspecified";

/** ABOVE / BELOW / NEAR / RANGE are CONDITIONS of the claim, not executed fills. */
export type EntryCondition =
  | { type: "at" | "above" | "below" | "near"; price: number }
  | { type: "range"; low: number; high: number }
  | { type: "market" }
  | { type: "unspecified" };

export type ExpiryClaim =
  | { status: "missing" }
  | { status: "period_word"; word: string }
  /**
   * day + month + a TWO-digit year (e.g. 29-OCT-26). The century is never inferred: no century policy exists, so
   * this stays unresolved and is never sent for contract lookup.
   */
  | { status: "year_two_digit"; day: number; month: number; twoDigitYear: number; raw: string }
  /** day + month stated, year NOT stated (never inferred). */
  | { status: "day_month"; day: number; month: number; raw: string }
  /** 29 February without a year: whether the date exists depends on the year, so it stays unresolved. */
  | { status: "year_dependent"; day: number; month: number; raw: string }
  /** Day, month and year stated and calendar-valid. A calendar-valid date is NOT proof that an exchange contract exists. */
  | { status: "full"; day: number; month: number; year: number; raw: string }
  | { status: "invalid"; reason: string; raw: string };

export interface OptionsClaim {
  /** buy / sell as written; null when the text has no BUY/SELL. */
  action: OptionAction | null;
  /**
   * BUY is read as a long-premium entry (explicitly a presumption of the text). SELL is "unresolved": without
   * position context it may be an exit of a long or a fresh short, and fresh short-option entry is unsupported.
   */
  intent: "long_entry_presumed" | "unresolved";
  underlying: Underlying;
  /** True when the message used an accepted alias (BANK NIFTY) that was normalized. */
  underlyingAliasUsed: boolean;
  strike: number | null;
  optionType: OptionType | null;
  /** A compact contract code that could not be decoded (e.g. a weekly code); strike was left null rather than guessed. */
  compactCodeUnrecognized: boolean;
  /** Both CE and PE appeared with no single contract: type left null. */
  optionTypeConflict: boolean;
  expiry: ExpiryClaim;
  entry: EntryCondition;
  stopLoss: number | null;
  /** Order preserved as written. */
  targets: number[];
  levelBasis: LevelBasis;
  /** Both a premium and an underlying marker were present; basis left unspecified. */
  levelBasisConflict: boolean;
  /** Informational, and only for a presumed long entry: BUY CE bullish, BUY PE bearish. Separate from action and level basis. */
  impliedUnderlyingView: "bullish" | "bearish" | "unresolved";
}

export type OptionsTextAnalysis =
  | { kind: "none" }
  | { kind: "options_claim"; claim: OptionsClaim }
  | { kind: "ambiguous"; directives: Array<{ direction: OptionAction; symbol: string }>; optionsRelated?: true };

/** Tokens that are index underlyings (optionally followed by digits/compact code); never plain equity symbols. */
export const RESERVED_UNDERLYING_TOKEN = /^(BANKNIFTY|NIFTY|SENSEX)(\d.*)?$/;
export function isReservedUnderlyingToken(symbol: string): boolean {
  return RESERVED_UNDERLYING_TOKEN.test(symbol.toUpperCase());
}
