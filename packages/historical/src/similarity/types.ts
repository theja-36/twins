/**
 * Similar-signal matching (Module 03). A case is a past signal with its resolved outcome; a target is the current one. Every dimension may be UNKNOWN on either side.
 * RULE: unknown evidence never counts as a match. It lowers `coverage` (the share of weight that could be compared) and adds nothing to similarity.
 */
export const SIMILARITY_VERSION = "signal-similarity-v1";
export const SIMILARITY_DIMENSIONS = ["instrument", "setup", "horizon", "timeOfDay", "expiryProximity", "entryType", "stopDistance", "rewardRisk", "regime", "volatility"] as const;
export type SimilarityDimension = (typeof SIMILARITY_DIMENSIONS)[number];
export type SimilarityDimensions = Partial<Record<SimilarityDimension, string | null>>;
export type CaseOutcome = "WIN" | "LOSS" | "BREAKEVEN" | "UNRESOLVED";

export interface HistoricalCase {
  id: string; observedAt: Date; dimensions: SimilarityDimensions; outcome: CaseOutcome; rMultiple: number | null;
  /** WHEN the outcome became knowable (the decisive touch / the end of the evaluation window). A resolved outcome that became known AFTER the target's decision time is future information and is demoted to UNRESOLVED. */
  resolvedAt?: Date | null;
  /** Identity of the ORIGINAL message (all revisions share it). Revisions of the target's own message never count as past cases; among past revisions only the latest one before the target counts. */
  groupKey?: string;
}
export interface SimilarityTarget { id: string; at: Date; dimensions: SimilarityDimensions; groupKey?: string }

export interface SimilarityConfig {
  weights: Record<SimilarityDimension, number>;
  /** Minimum share of total weight that must be comparable (known on both sides) for a case to be considered at all. */
  minCoverage: number;
  /** Minimum similarity (matched weight / comparable weight). */
  minSimilarity: number;
  maxMatches: number;
  /** When true, a resolved outcome with no recorded resolution time cannot be shown to pre-date the target, so it is treated as UNRESOLVED. The API always sets it; the default stays false for older callers. */
  requireResolvedAt: boolean;
  /** Below this many RESOLVED matches the aggregate says INSUFFICIENT_EVIDENCE (the pattern library uses 30). */
  minResolved: number;
  wilsonZ: number;
}
export const DEFAULT_SIMILARITY: SimilarityConfig = {
  weights: { instrument: 3, setup: 2, horizon: 1, timeOfDay: 1, expiryProximity: 1, entryType: 0.5, stopDistance: 1, rewardRisk: 1, regime: 2, volatility: 1.5 },
  minCoverage: 0.5, minSimilarity: 0.6, maxMatches: 50, minResolved: 30, wilsonZ: 1.96, requireResolvedAt: false,
};

export interface Match { caseId: string; similarity: number; coverage: number; matched: SimilarityDimension[]; differing: SimilarityDimension[]; unknown: SimilarityDimension[]; outcome: CaseOutcome; rMultiple: number | null; observedAt: Date }
export interface OutcomeAggregate {
  considered: number; resolved: number; wins: number; losses: number; breakeven: number; unresolved: number;
  winRate: number | null; winRateInterval: { lower: number; upper: number } | null; avgR: number | null;
  status: "SUFFICIENT" | "INSUFFICIENT_EVIDENCE" | "NO_COMPARABLE_CASES";
}
export interface SimilarityResult { version: string; target: string; matches: Match[]; aggregate: OutcomeAggregate; excluded: { future: number; sameId: number; lowCoverage: number; lowSimilarity: number };
  /** Temporal-integrity counters: cases dropped or demoted so that nothing from after the decision time is used. */
  temporal: { sameGroup: number; duplicateRevision: number; outcomeNotYetKnown: number; unknownResolutionTime: number }; notes: string[] }
