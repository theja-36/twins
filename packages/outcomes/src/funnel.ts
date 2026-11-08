import { isQualifiedOutcome } from "@twins/types";
import type { DecisionRow } from "@twins/database";
import type { AttributionRow } from "@twins/database";
import { computeMetrics, isEligible, type PerformanceMetrics } from "./metrics";

/**
 * Pipeline funnels (Module 15C/D). Telegram-originated and independently generated candidates are reported SEPARATELY, each stage with its own numerator and denominator (no rate without both). Counts of claims, candidates and scans
 * are platform-level pipeline facts; decisions, positions and outcomes are the user's own. A conversion is not a quality claim.
 */
export const FUNNEL_VERSION = "pipeline-funnel-v1";
export interface Rate { value: number | null; numerator: number; denominator: number }
export const rate = (num: number, den: number): Rate => ({ value: den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null, numerator: num, denominator: den });
export interface DecisionTally { total: number; byOutcome: Record<string, number>; qualified: number; approved: number; withPosition: number; invalidated: number; expiredOrCancelled: number }
export function tallyDecisions(rows: readonly DecisionRow[]): DecisionTally {
  const byOutcome: Record<string, number> = {}; for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  return { total: rows.length, byOutcome, qualified: rows.filter((r) => isQualifiedOutcome(r.outcome)).length, approved: rows.filter((r) => r.workflowState === "APPROVED").length, withPosition: rows.filter((r) => r.hasPosition).length, invalidated: rows.filter((r) => r.invalidated).length, expiredOrCancelled: rows.filter((r) => r.workflowState === "EXPIRED" || r.workflowState === "CANCELLED").length };
}
export interface FunnelStageInput { candidates: number; researched: number; byState: Record<string, number>; stateReasons: Record<string, number> }
export interface IndependentFunnel { source: "INDEPENDENT"; scans: number; generated: number; researched: number; decisions: DecisionTally; rates: { candidateToResearch: Rate; researchToDecision: Rate; decisionToQualified: Rate; qualifiedToApproved: Rate; approvedToPaperTrade: Rate; candidateExpiryRate: Rate; candidateInvalidationRate: Rate }; reasons: Record<string, number>; outcomes: { total: PerformanceMetrics; byOpportunityType: Array<{ key: string; metrics: PerformanceMetrics }> } | null; note: string }
export function independentFunnel(stage: FunnelStageInput & { scans: number }, rows: readonly DecisionRow[], records: readonly AttributionRow[], minSample: number): IndependentFunnel {
  const mine = rows.filter((r) => r.source === "INDEPENDENT"), t = tallyDecisions(mine), recs = records.filter((r) => r.candidateSource === "INDEPENDENT" && isEligible(r));
  const decidedCandidates = new Set(mine.map((r) => r.candidateId)).size;
  const byType = new Map<string, AttributionRow[]>(); for (const r of recs) byType.set(r.setup ?? "UNKNOWN", [...(byType.get(r.setup ?? "UNKNOWN") ?? []), r]);
  return { source: "INDEPENDENT", scans: stage.scans, generated: stage.candidates, researched: stage.researched, decisions: t,
    rates: { candidateToResearch: rate(stage.researched, stage.candidates), researchToDecision: rate(decidedCandidates, stage.researched), decisionToQualified: rate(t.qualified, t.total), qualifiedToApproved: rate(t.approved, t.qualified), approvedToPaperTrade: rate(t.withPosition, t.approved), candidateExpiryRate: rate(stage.byState["EXPIRED"] ?? 0, stage.candidates), candidateInvalidationRate: rate(stage.byState["INVALIDATED"] ?? 0, stage.candidates) },
    reasons: stage.stateReasons, outcomes: recs.length ? { total: computeMetrics(recs, minSample), byOpportunityType: [...byType.entries()].map(([key, rs]) => ({ key, metrics: computeMetrics(rs, minSample) })) } : null,
    note: "independent-engine results are never combined with Telegram-originated results; decision counts are this user's, candidate and scan counts are platform-level" };
}
export interface ChannelFunnelRow { channelId: string; channelLabel: string; messages: number; claims: number; ambiguous: number; unsupported: number; assessedReject: number; assessedInsufficient: number; decisions: DecisionTally; rates: { claimShare: Rate; invalidShare: Rate; claimToDecision: Rate; decisionToPaperTrade: Rate }; outcomes: PerformanceMetrics | null; reliability: string }
export interface TelegramFunnel { source: "TELEGRAM"; channels: ChannelFunnelRow[]; candidates: number; decisions: DecisionTally; unavailable: string[]; note: string }
export function telegramFunnel(channels: ReadonlyArray<{ channelId: string; channelLabel: string; messages: number; claims: number; ambiguous: number; unsupported: number; assessedReject: number; assessedInsufficient: number }>, candidates: number, rows: readonly DecisionRow[], records: readonly AttributionRow[], minSample: number): TelegramFunnel {
  const mine = rows.filter((r) => r.source === "TELEGRAM");
  const out: ChannelFunnelRow[] = channels.map((c) => {
    const ds = mine.filter((r) => r.channelId === c.channelId), t = tallyDecisions(ds), recs = records.filter((r) => r.candidateSource === "TELEGRAM" && r.channelId === c.channelId && isEligible(r));
    const m = recs.length ? computeMetrics(recs, minSample) : null;
    const parsed = c.claims + c.ambiguous + c.unsupported;
    return { ...c, decisions: t, rates: { claimShare: rate(c.claims, c.messages), invalidShare: rate(c.ambiguous + c.unsupported, parsed), claimToDecision: rate(t.total, c.claims), decisionToPaperTrade: rate(t.withPosition, t.total) }, outcomes: m, reliability: m ? m.reliability : "INSUFFICIENT_DATA" };
  });
  return { source: "TELEGRAM", channels: out, candidates, decisions: tallyDecisions(mine),
    unavailable: ["duplicate-signal analysis (duplicates are suppressed at intake and not counted per channel)", "stale-signal analysis (no per-claim staleness record)", "channel accuracy (it cannot be established without independently verified outcomes of the channel's calls; paper outcomes of TWINS decisions measure TWINS, not the channel)"],
    note: "claims-to-candidates conversion is not wired (G-19), so Telegram-originated candidates, decisions and outcomes are expected to be zero until it is" };
}
