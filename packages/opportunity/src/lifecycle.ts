import type { CandidateDraft } from "./candidate";

/** Candidate lifecycle (mirrors the database guard in migration 0036). Pure transition rules plus revalidation. */
export type CandidateState = "NEW" | "IN_RESEARCH" | "READY_FOR_DECISION" | "EXPIRED" | "WITHDRAWN" | "INVALIDATED" | "SUPERSEDED";
export const TERMINAL_STATES: readonly CandidateState[] = ["EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"];
export const ACTIVE_STATES: readonly CandidateState[] = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION"];
const END: readonly CandidateState[] = ["EXPIRED", "INVALIDATED", "SUPERSEDED", "WITHDRAWN"];
const NEXT: Record<CandidateState, readonly CandidateState[]> = {
  NEW: ["IN_RESEARCH", ...END], IN_RESEARCH: ["NEW", "READY_FOR_DECISION", ...END], READY_FOR_DECISION: [...END], EXPIRED: [], WITHDRAWN: [], INVALIDATED: [], SUPERSEDED: [],
};
export const canTransition = (from: CandidateState, to: CandidateState): boolean => NEXT[from].includes(to);

export type RevalidationOutcome = { outcome: "VALID"; reason: "PRICE_WITHIN_THESIS" } | { outcome: "INVALIDATED"; reason: "STOP_BREACHED" | "TARGET_REACHED_BEFORE_ENTRY" } | { outcome: "EXPIRED"; reason: "PAST_EXPIRY" } | { outcome: "UNVERIFIABLE"; reason: "NO_PRICE" | "PRICE_STALE" | "PRICE_FROM_FUTURE" | "MALFORMED" };
export interface RevalidationSubject { side: "BUY" | "SELL"; invalidation: CandidateDraft["invalidation"] | null; stopLoss: number | null; targets: readonly number[]; expiresAt: Date }
/**
 * Re-checks a candidate against a current price. UNVERIFIABLE (no price, stale, malformed) never refreshes the candidate and never counts as valid: a candidate that cannot be re-checked must not be treated as fresh.
 * VALID means only that the price has not breached the thesis: it is not a recommendation.
 */
export function revalidate(c: RevalidationSubject, price: { price: number; asOf: string } | null, now: Date, maxPriceAgeMinutes: number): RevalidationOutcome {
  if (c.expiresAt.getTime() <= now.getTime()) return { outcome: "EXPIRED", reason: "PAST_EXPIRY" };
  if (!price) return { outcome: "UNVERIFIABLE", reason: "NO_PRICE" };
  const at = Date.parse(price.asOf);
  if (!Number.isFinite(price.price) || price.price <= 0 || Number.isNaN(at)) return { outcome: "UNVERIFIABLE", reason: "MALFORMED" };
  const ageMin = (now.getTime() - at) / 60_000;
  if (ageMin < -1) return { outcome: "UNVERIFIABLE", reason: "PRICE_FROM_FUTURE" };
  if (ageMin > maxPriceAgeMinutes) return { outcome: "UNVERIFIABLE", reason: "PRICE_STALE" };
  const level = c.invalidation?.price ?? c.stopLoss;
  if (level === null || level === undefined) return { outcome: "UNVERIFIABLE", reason: "MALFORMED" }; // a candidate without an invalidation level cannot be called valid
  const breached = c.side === "BUY" ? price.price <= level : price.price >= level;
  if (breached) return { outcome: "INVALIDATED", reason: "STOP_BREACHED" };
  const t1 = c.targets[0];
  if (t1 !== undefined && (c.side === "BUY" ? price.price >= t1 : price.price <= t1)) return { outcome: "INVALIDATED", reason: "TARGET_REACHED_BEFORE_ENTRY" };
  return { outcome: "VALID", reason: "PRICE_WITHIN_THESIS" };
}
