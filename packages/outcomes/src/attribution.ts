import { abs, ceilTo2, dec, div, mul, str, ZERO } from "@twins/planning";
import type { AttributionFacts, AttributionRow, NewAttribution } from "@twins/database";

/**
 * Outcome attribution (Module 15 foundation). PURE: turns the facts of one paper position into an attribution record, or returns null when the latest stored version already says the same thing (idempotent). It never
 * infers an outcome from a decision: a FINAL record exists only for a CLOSED position that has a recorded trade outcome. What was not recorded stays in `missing`; anything that taints the record goes in `dataQuality`.
 */
export const ATTRIBUTION_VERSION = "outcome-attribution-v1";
const TOL = dec("0.05");
export function dataSourceOf(f: AttributionFacts): "FIXTURE" | "LIVE" | "HISTORICAL" {
  const s = f.fills.priceSources;
  if (f.candidate.dataSource === "FIXTURE" || s.includes("FIXTURE") || s.length === 0) return "FIXTURE"; // the weakest provenance wins; no recorded price source is treated as fixture
  if (s.includes("HISTORICAL") || f.candidate.dataSource === "HISTORICAL") return "HISTORICAL";
  return "LIVE";
}
function compose(f: AttributionFacts, prev: AttributionRow | null, reason: string | null): NewAttribution {
  const p = f.position, closed = p.status === "CLOSED" && f.outcome !== null, quality: string[] = [], missing: string[] = ["mae_mfe", "slippage_reference_price", "regime_during_trade"];
  const gross = dec(p.realizedPnl), costs = dec(p.realizedCosts), net = gross - costs;
  const risk = ceilTo2(mul(abs(dec(p.avgEntryPrice) - dec(p.initialStop)), dec(p.initialQuantity), "up"));
  const source = dataSourceOf(f);
  if (source === "FIXTURE") quality.push("FIXTURE_PRICES");
  if (f.fills.priceSources.length === 0) quality.push("NO_PRICE_SOURCE_RECORDED");
  if (!f.confidence) { quality.push("NO_CONFIDENCE_ASSESSMENT"); missing.push("confidence_at_decision"); }
  else if (f.confidence.createdAt.getTime() > p.openedAt.getTime()) quality.push("CONFIDENCE_RECORDED_AFTER_OPEN"); // look-ahead: this score cannot be used to evaluate the trade
  if (!f.regime) missing.push("regime_at_decision");
  if (!f.risk) missing.push("risk_assessment");
  if (!f.agentVersions) missing.push("agent_versions");
  if (closed) {
    const diff = abs(dec(f.outcome!.pnl) - net);
    if (diff > TOL) quality.push("OUTCOME_PNL_MISMATCH");
    if (p.closedAt && f.outcome!.closedAt.getTime() < p.openedAt.getTime()) quality.push("CLOSE_BEFORE_OPEN");
  }
  const setupEv = (f.candidate.evidence as Array<{ kind?: string; detector?: string; timeframeSeconds?: number }>).find((e) => e && e.kind === "setup");
  if (!setupEv) missing.push("timeframe");
  const finality: "PARTIAL" | "FINAL" = closed ? "FINAL" : "PARTIAL";
  const stopMoves = f.events["STOP_MOVED"] ?? 0;
  const out: NewAttribution = {
    userId: p.userId, accountId: p.accountId, paperPositionId: p.id, outcomeId: closed ? f.outcome!.id : null, decisionId: p.decisionId, candidateId: f.decision.candidateId, version: prev ? prev.version + 1 : 1, supersedesId: prev?.id ?? null,
    correctionReason: prev ? (reason ?? (prev.finality === "PARTIAL" && finality === "FINAL" ? "the position closed: the final outcome is now recorded" : "the recorded result of the position changed since the previous version")) : null,
    finality, mode: "PAPER", dataSource: source, candidateSource: f.candidate.source, setup: f.candidate.setup, detectorVersion: setupEv?.detector ?? null, channelId: f.candidate.channelId, playbookRef: null,
    instrument: p.instrument, timeframeSeconds: setupEv?.timeframeSeconds ?? null, side: p.side, quantity: p.initialQuantity, entryPrice: p.avgEntryPrice,
    exitPrice: closed ? f.outcome!.exitPrice : null, grossPnl: str(gross, 2), costs: str(costs, 2), netPnl: closed ? f.outcome!.pnl : str(net, 2), riskAmount: risk > ZERO ? str(risk, 2) : null,
    rMultiple: closed ? (f.outcome!.rMultiple ?? (risk > ZERO ? str(div(dec(f.outcome!.pnl), risk, "down"), 2) : null)) : null,
    holdingSeconds: closed && p.closedAt ? Math.max(0, Math.round((f.outcome!.closedAt.getTime() - p.openedAt.getTime()) / 1000)) : null, exitReason: closed ? f.outcome!.exitReason : null,
    trade: { stopMoves, targetsHit: f.events["TARGET_HIT"] ?? 0, partialExits: f.events["PARTIAL_EXIT"] ?? 0, stopHit: closed ? f.outcome!.exitReason === "STOP_HIT" : null, reachedBreakeven: stopMoves > 0, initialStop: p.initialStop, finalStop: p.stopLoss, targetsPlanned: p.targets.length, entryFills: f.fills.entryFills, exitFills: f.fills.exitFills },
    regime: f.regime ? { atDecision: { regime: f.regime.regime, direction: f.regime.direction, volatilityRegime: f.regime.volatilityRegime, asOf: f.regime.asOf.toISOString(), dataSource: f.regime.dataSource }, duringTrade: null } : null,
    agentVersions: f.agentVersions ?? {}, evidenceRefs: [...new Set([...f.decision.evidenceRefs, `decision:${p.decisionId}`, `paper_position:${p.id}`, ...(closed ? [`trade_outcome:${f.outcome!.id}`] : [])])].sort(),
    predicted: { confidenceScore: f.confidence?.score ?? null, riskVerdict: f.risk?.verdict ?? null, plannedRewardToRisk: f.risk?.plannedRewardToRisk ?? null, plannedMaxLoss: f.risk?.maxLossAtStop ?? null, permittedLots: (f.decision.permittedSize as { lots?: number } | null)?.lots ?? null },
    confidenceScore: f.confidence?.score ?? null, confidenceAt: f.confidence?.createdAt ?? null, decidedAt: f.decision.createdAt, openedAt: p.openedAt, closedAt: closed ? f.outcome!.closedAt : null, dataQuality: quality, missing: [...new Set(missing)].sort(),
  };
  return out;
}
const same = (a: NewAttribution, p: AttributionRow): boolean => p.finality === a.finality && p.grossPnl === a.grossPnl && p.netPnl === a.netPnl && p.exitPrice === a.exitPrice && p.costs === a.costs && JSON.stringify([...p.dataQuality].sort()) === JSON.stringify([...a.dataQuality].sort());
/** The automatic path: a first record, or PARTIAL -> a newer PARTIAL / FINAL. A FINAL record is never silently rewritten, and an unchanged position adds nothing (idempotent). */
export function buildAttribution(f: AttributionFacts, prev: AttributionRow | null): NewAttribution | null {
  if (prev && prev.finality === "FINAL") return null;
  const out = compose(f, prev, null);
  return prev && same(out, prev) ? null : out;
}
/** The deliberate path: a correction of a FINAL record is a new, reasoned version (the previous one stays as history). Refused unless the previous record is FINAL, the position is closed and the reason is real. */
export function buildCorrection(f: AttributionFacts, prev: AttributionRow, reason: string): NewAttribution | null {
  if (prev.finality !== "FINAL") throw new RangeError("only a FINAL outcome is corrected; a PARTIAL one is superseded automatically");
  if (typeof reason !== "string" || reason.trim().length < 10) throw new RangeError("a correction needs a reason of at least 10 characters");
  if (f.position.status !== "CLOSED" || !f.outcome) throw new RangeError("the position is not closed");
  const out = compose(f, prev, `correction: ${reason.trim()}`);
  return same(out, prev) ? null : out;
}
