import type { DecisionRow } from "@twins/database";
import type { AttributionRow } from "@twins/database";
import { computeMetrics, isEligible, type PerformanceMetrics } from "./metrics";
import { tallyDecisions, type DecisionTally } from "./funnel";

/**
 * Decision quality (Module 15F). Realised results exist only for decisions that were executed. For decisions that were NOT executed (WAIT, REJECT, EVALUATION_ONLY, NO_TRADE, unapproved QUALIFIED) the only thing offered is a clearly
 * labelled ESTIMATE of what price did afterwards relative to the candidate's own stop and first target. It has NO currency amount, assumes entry at the decision price, ignores costs and slippage, and is never added to any realised figure.
 */
export const DECISION_QUALITY_VERSION = "decision-quality-v1";
export interface Bar { t: string; open: number; high: number; low: number; close: number }
export type Hypothetical = "TARGET_FIRST" | "STOP_FIRST" | "NEITHER" | "AMBIGUOUS" | "HORIZON_NOT_REACHED" | "NO_PRICE_EVIDENCE" | "NO_LEVELS";
export interface HypotheticalResult { class: Hypothetical; estimatedR: number | null; barsExamined: number; label: "ESTIMATE_NOT_REALISED"; assumptions: string[] }
const ASSUME = ["entry at the candidate's own entry price at the decision time", "no costs and no slippage", "the first target and the stop of the candidate only", "a bar touching both levels is AMBIGUOUS (never resolved in the favourable direction)"];
/** What price did after the decision, against the candidate's levels. `horizonEnd` is the time after which the question can be answered (the candidate's own validity); before it the answer is HORIZON_NOT_REACHED. */
export function estimateHypothetical(row: Pick<DecisionRow, "side" | "entryLow" | "entryHigh" | "stopLoss" | "targets" | "createdAt">, bars: readonly Bar[], now: Date, horizonEnd: Date): HypotheticalResult {
  const entry = row.entryLow !== null && row.entryHigh !== null ? (row.entryLow + row.entryHigh) / 2 : row.entryLow ?? row.entryHigh, stop = row.stopLoss, t1 = row.targets[0];
  const mk = (c: Hypothetical, r: number | null, n: number): HypotheticalResult => ({ class: c, estimatedR: r, barsExamined: n, label: "ESTIMATE_NOT_REALISED", assumptions: ASSUME });
  if (entry === null || stop === null || t1 === undefined || stop === entry) return mk("NO_LEVELS", null, 0);
  const buy = row.side === "BUY";
  if (buy ? !(stop < entry && t1 > entry) : !(stop > entry && t1 < entry)) return mk("NO_LEVELS", null, 0);
  const after = bars.filter((b) => Date.parse(b.t) >= row.createdAt.getTime() && Date.parse(b.t) <= horizonEnd.getTime()).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (after.length === 0) return mk(now.getTime() < horizonEnd.getTime() ? "HORIZON_NOT_REACHED" : "NO_PRICE_EVIDENCE", null, 0);
  const R = Math.abs(entry - stop), tR = Math.round((Math.abs(t1 - entry) / R) * 100) / 100;
  let n = 0;
  for (const b of after) {
    n++;
    const hitStop = buy ? b.low <= stop : b.high >= stop, hitT = buy ? b.high >= t1 : b.low <= t1;
    if (hitStop && hitT) return mk("AMBIGUOUS", null, n);
    if (hitStop) return mk("STOP_FIRST", -1, n);
    if (hitT) return mk("TARGET_FIRST", tR, n);
  }
  return now.getTime() < horizonEnd.getTime() ? mk("HORIZON_NOT_REACHED", null, n) : mk("NEITHER", null, n);
}
export interface DecisionQuality {
  version: string; decisions: DecisionTally; executed: { qualifiedExecuted: number; metrics: PerformanceMetrics | null };
  notExecuted: Array<{ outcome: string; count: number; estimate: { evaluated: number; unavailable: number; targetFirst: number; stopFirst: number; neither: number; ambiguous: number; pending: number; note: string } }>;
  limitations: string[];
}
export function assessDecisionQuality(rows: readonly DecisionRow[], records: readonly AttributionRow[], hypo: ReadonlyMap<string, HypotheticalResult>, minSample: number): DecisionQuality {
  const exec = records.filter((r) => isEligible(r));
  const groups = new Map<string, DecisionRow[]>(); for (const r of rows.filter((x) => !x.hasPosition)) groups.set(r.outcome, [...(groups.get(r.outcome) ?? []), r]);
  const notExecuted = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([outcome, rs]) => {
    const e = { evaluated: 0, unavailable: 0, targetFirst: 0, stopFirst: 0, neither: 0, ambiguous: 0, pending: 0, note: "ESTIMATES of what price did relative to the candidate's own levels; not realised returns; no currency amounts" };
    for (const r of rs) { const h = hypo.get(r.id); if (!h || h.class === "NO_PRICE_EVIDENCE" || h.class === "NO_LEVELS") e.unavailable++; else if (h.class === "HORIZON_NOT_REACHED") e.pending++; else { e.evaluated++; if (h.class === "TARGET_FIRST") e.targetFirst++; else if (h.class === "STOP_FIRST") e.stopFirst++; else if (h.class === "NEITHER") e.neither++; else e.ambiguous++; } }
    return { outcome, count: rs.length, estimate: e };
  });
  return { version: DECISION_QUALITY_VERSION, decisions: tallyDecisions(rows), executed: { qualifiedExecuted: exec.length, metrics: exec.length ? computeMetrics(exec, minSample) : null }, notExecuted,
    limitations: ["a decision is judged by its realised outcome only when it was executed", "an unexecuted decision has no P&L: the estimate counts which level price reached first and nothing more", "estimates need later price bars; with none, the answer is UNAVAILABLE, never a guess", "a small sample of estimates says nothing about decision quality"] };
}
