import type { OptionType, Underlying } from "./types";

/**
 * Option-premium data boundary (offline). Like the contract master, the default provider is explicitly UNAVAILABLE.
 * A provider answers only for the exact contract identity it is given (underlying, strike, CE/PE, expiry date); there
 * is no nearest-strike or nearest-expiry matching and no interpolation. Quotes carry no Greeks, IV, probabilities or
 * opinions. Even a present quote is only as real as its source: sample data is labelled and never "live".
 */
export interface PremiumQuery {
  underlying: Underlying;
  strike: number;
  optionType: OptionType;
  /** ISO date of the contract as matched in the verified reference. */
  expiryDate: string;
}

export interface PremiumQuote {
  bid?: number;
  ask?: number;
  last?: number;
}

export interface PremiumSourceInfo {
  version: string;
  source: string;
  collectedAsOf: string;
  synthetic: boolean;
  /** The data set's own statement that it is not live market data. */
  notLiveStatement: string;
}

export type PremiumLookup =
  | { status: "unavailable" }
  | { status: "not_attempted"; reason: string }
  | { status: "not_found" }
  | { status: "sample_quote"; quote: PremiumQuote; source: PremiumSourceInfo };

export interface OptionsPremiumProvider {
  readonly name: string;
  /** Present for data-backed providers. */
  readonly source?: PremiumSourceInfo;
  lookup(query: PremiumQuery): Promise<PremiumLookup>;
}

export const unavailablePremiumProvider: OptionsPremiumProvider = {
  name: "unavailable",
  async lookup() {
    return { status: "unavailable" };
  },
};
