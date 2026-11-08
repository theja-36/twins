import { dimensionsOfClaim } from "./dimensions";
import type { CaseOutcome, HistoricalCase } from "./types";

/**
 * Archive row -> HistoricalCase (PURE). The mapping is deliberately conservative:
 *  - WIN_T1 / WIN_T2 / WIN_T3 -> WIN, LOSS_SL -> LOSS. EVERYTHING ELSE (no entry, expired, invalid, unverifiable, expired after entry) -> UNRESOLVED: an unknown outcome is not a win, not a loss and not a match.
 *  - resolvedAt is the instant the outcome became knowable: the first touch of the target that was hit, or of the stop. If it cannot be established the case has no resolvedAt, and the matcher (requireResolvedAt) will not trust its outcome.
 *  - r-multiples are not recorded by the archive, so none is invented.
 *  - groupKey ties the revisions of one original message together.
 */
export interface CaseRowInput { caseId: string; messageTimestamp: Date; channelLabel: string; originalMessageId: string; underlying: string | null; entry: unknown; stopLoss: number | null; targets: unknown; expiryDate: string | null; finalOutcome: string; slFirstTouchAt: Date | null; targetEvaluations: unknown }
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
function entryOf(v: unknown): { type: string; price?: number; low?: number; high?: number } | null {
  if (typeof v !== "object" || v === null) return null; const o = v as Record<string, unknown>; if (typeof o["type"] !== "string") return null;
  const price = num(o["price"]), low = num(o["low"]), high = num(o["high"]); return { type: o["type"], ...(price !== undefined ? { price } : {}), ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}) };
}
export function caseOutcomeOf(finalOutcome: string): CaseOutcome { return /^WIN_T[123]$/.test(finalOutcome) ? "WIN" : finalOutcome === "LOSS_SL" ? "LOSS" : "UNRESOLVED"; }
function resolvedAtOf(r: CaseRowInput): Date | null {
  if (r.finalOutcome === "LOSS_SL") return r.slFirstTouchAt;
  const m = /^WIN_T([123])$/.exec(r.finalOutcome); if (!m || !Array.isArray(r.targetEvaluations)) return null;
  const t = (r.targetEvaluations as Array<Record<string, unknown>>).find((x) => Number(x["index"]) === Number(m[1]) && x["status"] === "TARGET_HIT" && typeof x["firstTouchAt"] === "string");
  return t ? new Date(t["firstTouchAt"] as string) : null;
}
export function historicalCaseFromRow(r: CaseRowInput): HistoricalCase {
  const outcome = caseOutcomeOf(r.finalOutcome), targets = Array.isArray(r.targets) ? r.targets.map(num).filter((x): x is number => x !== undefined) : [];
  return { id: r.caseId, observedAt: r.messageTimestamp, outcome, rMultiple: null, resolvedAt: outcome === "UNRESOLVED" ? null : resolvedAtOf(r), groupKey: `${r.channelLabel}:${r.originalMessageId}`, dimensions: dimensionsOfClaim({ underlying: r.underlying, entry: entryOf(r.entry), stopLoss: r.stopLoss, targets, expiryDate: r.expiryDate }, r.messageTimestamp) };
}
