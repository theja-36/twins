import { InputError } from "../readers";
import type { Metrics } from "./metrics";

/**
 * Trust tiers (Stage 4 / Task 3): a deterministic function of (all-time metric snapshot, threshold configuration). Every rule that decides the tier is recorded with the observed value
 * and its threshold. Tiers describe the evidence about a SOURCE'S PAST SIGNALS only; they never approve or size anything and no risk decision reads them in this task.
 *
 * Order: UNKNOWN (too few evaluable outcomes) -> D (negative net expectancy, severe data problems, major evidence conflicts) -> A -> B -> C, then a downgrade for high revision /
 * evidence-conflict activity, then non-configurable guardrails (an A needs >= 30 evaluable outcomes, positive net expectancy and <= 40% unverifiable, whatever the configuration says).
 */
export const TIER_ALGORITHM_VERSION = "trust-tier-v1";
export type Tier = "A" | "B" | "C" | "D" | "UNKNOWN";
export const TIER_LABELS: Record<Tier, string> = { A: "HIGH_TRUST", B: "MODERATE_TRUST", C: "LOW_TRUST", D: "UNTRUSTED", UNKNOWN: "INSUFFICIENT_EVIDENCE" };

export interface TierConfig {
  /** Fewer evaluable outcomes than this is UNKNOWN. Default 30 (the stricter reading of the contract; the 'initial defaults' list would allow 10 - see D-063). */
  unknownBelow: number;
  /** Net expectancy = (total R - costPerTradeR x entered trades) / evaluable. */
  costPerTradeR: number;
  a: { minEvaluable: number; minWinRateEntered: number; maxUnverifiableRate: number; maxConflictRate: number };
  b: { minEvaluable: number; maxUnverifiableRate: number };
  c: { minEvaluable: number };
  /** Above this revision / evidence-conflict rate the tier is lowered one step (A->B, B->C). */
  downgradeConflictRate: number;
  untrusted: { conflictRate: number; unverifiableRate: number; minDataQualityScore: number };
}
export const DEFAULT_TIER_CONFIG: TierConfig = {
  unknownBelow: 30, costPerTradeR: 0.05,
  a: { minEvaluable: 50, minWinRateEntered: 0.45, maxUnverifiableRate: 0.2, maxConflictRate: 0.05 },
  b: { minEvaluable: 30, maxUnverifiableRate: 0.35 },
  c: { minEvaluable: 10 },
  downgradeConflictRate: 0.15,
  untrusted: { conflictRate: 0.3, unverifiableRate: 0.6, minDataQualityScore: 0.4 },
};
type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };

export function resolveTierConfig(over: Deep<TierConfig> = {}): TierConfig {
  const d = DEFAULT_TIER_CONFIG;
  const c: TierConfig = {
    unknownBelow: over.unknownBelow ?? d.unknownBelow, costPerTradeR: over.costPerTradeR ?? d.costPerTradeR, downgradeConflictRate: over.downgradeConflictRate ?? d.downgradeConflictRate,
    a: { ...d.a, ...over.a }, b: { ...d.b, ...over.b }, c: { ...d.c, ...over.c }, untrusted: { ...d.untrusted, ...over.untrusted },
  };
  const rates = [c.a.minWinRateEntered, c.a.maxUnverifiableRate, c.a.maxConflictRate, c.b.maxUnverifiableRate, c.downgradeConflictRate, c.untrusted.conflictRate, c.untrusted.unverifiableRate, c.untrusted.minDataQualityScore];
  const counts = [c.unknownBelow, c.a.minEvaluable, c.b.minEvaluable, c.c.minEvaluable];
  if (rates.some((x) => !Number.isFinite(x) || x < 0 || x > 1) || counts.some((x) => !Number.isInteger(x) || x < 1 || x > 100_000) || !Number.isFinite(c.costPerTradeR) || c.costPerTradeR < 0 || c.costPerTradeR > 1) throw new InputError("invalid_tier_config");
  return c;
}

export interface TierRule { rule: string; observed: number | string | null; threshold: number | string | null; effect: string }
export interface TierResult { tier: Tier; label: string; rules: TierRule[] }
const RANK: Tier[] = ["D", "C", "B", "A"];

export function assignTier(m: Metrics, cfg: TierConfig): TierResult {
  const rules: TierRule[] = [];
  const done = (tier: Tier): TierResult => ({ tier, label: TIER_LABELS[tier], rules });
  const n = m.evaluable, net = m.netExpectancyR, unv = m.unverifiableRate ?? 0, conflict = m.revisionConflictRate ?? 0, dq = m.dataQualityScore;
  if (n < cfg.unknownBelow || n < 1) { rules.push({ rule: "INSUFFICIENT_EVALUABLE_OUTCOMES", observed: n, threshold: cfg.unknownBelow, effect: "UNKNOWN" }); return done("UNKNOWN"); }
  const dRules: TierRule[] = [];
  if (net !== null && net < 0) dRules.push({ rule: "NEGATIVE_NET_EXPECTANCY", observed: net, threshold: 0, effect: "D" });
  if (unv > cfg.untrusted.unverifiableRate) dRules.push({ rule: "SEVERE_UNVERIFIABLE_SHARE", observed: unv, threshold: cfg.untrusted.unverifiableRate, effect: "D" });
  if (dq !== null && dq < cfg.untrusted.minDataQualityScore) dRules.push({ rule: "SEVERE_DATA_QUALITY_ISSUES", observed: dq, threshold: cfg.untrusted.minDataQualityScore, effect: "D" });
  if (conflict >= cfg.untrusted.conflictRate) dRules.push({ rule: "MAJOR_EVIDENCE_CONFLICT", observed: conflict, threshold: cfg.untrusted.conflictRate, effect: "D" });
  if (dRules.length > 0) { rules.push(...dRules); return done("D"); }

  let tier: Tier;
  const aFails: string[] = [];
  if (n < cfg.a.minEvaluable) aFails.push("A_MIN_EVALUABLE");
  if (!(net !== null && net > 0)) aFails.push("A_POSITIVE_EXPECTANCY");
  if (!((m.winRateEntered ?? 0) >= cfg.a.minWinRateEntered)) aFails.push("A_MIN_WIN_RATE");
  if (!(unv < cfg.a.maxUnverifiableRate)) aFails.push("A_MAX_UNVERIFIABLE");
  if (!(conflict <= cfg.a.maxConflictRate)) aFails.push("A_MAX_CONFLICT");
  if (aFails.length === 0) { tier = "A"; rules.push({ rule: "MEETS_A_THRESHOLDS", observed: n, threshold: cfg.a.minEvaluable, effect: "A" }); }
  else if (n >= cfg.b.minEvaluable && net !== null && net >= 0 && unv < cfg.b.maxUnverifiableRate) {
    tier = "B"; rules.push({ rule: "MEETS_B_THRESHOLDS", observed: n, threshold: cfg.b.minEvaluable, effect: "B" });
    for (const f of aFails) rules.push({ rule: f, observed: null, threshold: null, effect: "NOT_A" });
  } else if (n >= cfg.c.minEvaluable) { tier = "C"; rules.push({ rule: "BELOW_B_THRESHOLDS", observed: n, threshold: cfg.b.minEvaluable, effect: "C" }); }
  else { rules.push({ rule: "INSUFFICIENT_EVALUABLE_OUTCOMES", observed: n, threshold: cfg.c.minEvaluable, effect: "UNKNOWN" }); return done("UNKNOWN"); }

  if (conflict > cfg.downgradeConflictRate && (tier === "A" || tier === "B")) {
    tier = RANK[RANK.indexOf(tier) - 1] as Tier;
    rules.push({ rule: "REVISION_ACTIVITY_DOWNGRADE", observed: conflict, threshold: cfg.downgradeConflictRate, effect: tier });
  }
  if (tier === "A" && (n < 30 || !(net !== null && net > 0) || unv > 0.4)) { tier = "B"; rules.push({ rule: "GUARDRAIL_A_REQUIREMENTS", observed: n, threshold: 30, effect: "B" }); }
  return done(tier);
}
