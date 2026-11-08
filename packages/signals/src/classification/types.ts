import type { EntryCondition, OptionsClaim } from "../options/types";

/** Vocabulary of Module 02 (mirrors the CHECK constraints of `signal_classifications`, migration 0033). */
export const CLASSIFIER_VERSION = "signal-classifier-v1";
export const SIGNAL_TYPES = ["OPTIONS_BUY", "OPTIONS_SELL", "FUTURES", "EQUITY", "UPDATE", "UNKNOWN"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export const HORIZONS = ["INTRADAY", "POSITIONAL", "SCALPING", "UNKNOWN"] as const;
export type Horizon = (typeof HORIZONS)[number];
export const SETUPS = ["BREAKOUT", "REVERSAL", "MOMENTUM", "GAP", "SCALP", "OTHER", "UNKNOWN"] as const;
export type Setup = (typeof SETUPS)[number];
export const RISK_PROFILES = ["CONSERVATIVE", "MODERATE", "AGGRESSIVE", "UNKNOWN"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export interface ClassificationInput {
  claim: OptionsClaim;
  /**
   * The message text, used ONLY to look for fixed whole-word cues (horizon and setup words). It is never stored, never returned and never interpreted as an instruction:
   * the result carries cue CODES only. Null means no text is available, and then no cue is found (nothing is guessed).
   */
  messageText: string | null;
  messageTimestamp: Date;
}

export interface StructureIssue { code: "entry_missing" | "stop_missing" | "targets_missing" | "stop_not_beyond_entry" | "targets_not_beyond_entry" | "targets_not_ordered" | "range_inverted" | "level_basis_unclear" | "option_contract_incomplete"; }

export interface ExitPattern { stopPresent: boolean; targetCount: number; targetsOrdered: boolean; rewardToRisk: number[] }

export type SessionBucket = "OPENING" | "MORNING" | "MIDDAY" | "AFTERNOON" | "CLOSING" | "OUTSIDE_SESSION" | "WEEKEND";
/** Reconstructed setup context: everything derivable from the message and its time, with each unknown kept explicit (null). */
export interface SignalContext {
  sessionBucket: SessionBucket; istWeekday: number; minutesSinceMidnightIst: number;
  /** Days from the message date to the stated expiry. The message states no year, so the NEXT occurrence of that day and month is assumed and flagged. */
  daysToExpiry: number | null; expiryYearAssumed: boolean; expiryStated: boolean;
  entry: { kind: EntryCondition["type"]; low: number | null; high: number | null; conditional: boolean };
  /** Stop distance as a percentage of the entry reference, only when both are known. */
  stopDistancePct: number | null; firstTargetDistancePct: number | null;
  rewardToRisk: number[]; levelBasis: OptionsClaim["levelBasis"]; basisStated: boolean;
}

export interface ClassificationResult {
  classifierVersion: string; signalType: SignalType; horizon: Horizon; setup: Setup; riskProfile: RiskProfile;
  entryCondition: SignalContext["entry"]; exitPattern: ExitPattern; structureValid: boolean; structureIssues: StructureIssue["code"][];
  /** Completeness of what could be determined (0..1). It is NOT a probability that the signal will work. */
  confidence: number; evidenceCodes: string[]; context: SignalContext;
}
