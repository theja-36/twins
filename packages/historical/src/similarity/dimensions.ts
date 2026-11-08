import { istParts, sessionBucket } from "@twins/signals";
import type { SimilarityDimensions } from "./types";

/**
 * Builds the similarity dimensions of a Telegram options claim, the SAME way for the claim being asked about and for every historical case, so the two are comparable. PURE.
 * Only what is derivable from the claim and its timestamp is filled in; everything else stays null (unknown: never a match). Buckets are fixed, documented thresholds, not fitted values.
 *  - instrument: the underlying.   - entryType: the stated entry condition.   - timeOfDay: the IST session bucket of the message time.
 *  - stopDistance: |entry reference - stop| as a share of the entry reference (known only for a stated entry and stop on one basis).
 *  - rewardRisk: first target distance / stop distance.   - expiryProximity: calendar days to a FULLY STATED expiry date (never inferred).
 *  - setup / horizon: supplied by the classifier when available.
 */
export interface ClaimShape { underlying: string | null; entry: { type: string; price?: number; low?: number; high?: number } | null; stopLoss: number | null; targets: readonly number[]; expiryDate: string | null; setup?: string | null; horizon?: string | null }
const ref = (e: ClaimShape["entry"]): number | null => (!e ? null : e.type === "range" && e.low !== undefined && e.high !== undefined ? (e.low + e.high) / 2 : e.price ?? null);
export const bucketStopDistance = (pct: number): string => (pct < 5 ? "STOP_LT_5" : pct < 10 ? "STOP_5_10" : pct < 20 ? "STOP_10_20" : "STOP_GE_20");
export const bucketRewardRisk = (rr: number): string => (rr < 1 ? "RR_LT_1" : rr < 2 ? "RR_1_2" : rr < 3 ? "RR_2_3" : "RR_GE_3");
export const bucketExpiryDays = (days: number): string => (days < 0 ? "EXPIRED" : days <= 1 ? "EXP_0_1D" : days <= 7 ? "EXP_2_7D" : days <= 30 ? "EXP_8_30D" : "EXP_GT_30D");
export function dimensionsOfClaim(c: ClaimShape, at: Date): SimilarityDimensions {
  const d: SimilarityDimensions = {};
  if (c.underlying) d.instrument = c.underlying;
  if (c.entry && c.entry.type !== "unspecified") d.entryType = c.entry.type;
  const p = istParts(at); d.timeOfDay = sessionBucket(p.weekday, p.minutes);
  const e = ref(c.entry);
  if (e !== null && e > 0 && c.stopLoss !== null && c.stopLoss > 0) {
    const stop = Math.abs(e - c.stopLoss); d.stopDistance = bucketStopDistance((stop / e) * 100);
    if (c.targets.length > 0 && stop > 0) d.rewardRisk = bucketRewardRisk(Math.abs((c.targets[0] as number) - e) / stop);
  }
  if (c.expiryDate) { const [y, m, dd] = c.expiryDate.split("-").map(Number); if (y && m && dd) d.expiryProximity = bucketExpiryDays(Math.floor((Date.UTC(y, m - 1, dd) - Date.UTC(p.y, p.m - 1, p.d)) / 86_400_000)); }
  if (c.setup && c.setup !== "UNKNOWN" && c.setup !== "OTHER") d.setup = c.setup;
  if (c.horizon && c.horizon !== "UNKNOWN") d.horizon = c.horizon;
  return d;
}
