import type { AttributionFacts, AttributionRow } from "../../../packages/database/src/index";

let n = 0;
export const T0 = Date.parse("2031-01-06T05:00:00Z");
/** A FINAL, PAPER attribution row. Defaults describe a non-fixture winner; every test overrides what it cares about. */
export function rec(o: Partial<AttributionRow> = {}): AttributionRow {
  n++;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, userId: "u1", accountId: "a1", paperPositionId: `p-${n}`, outcomeId: `o-${n}`, decisionId: `d-${n}`, candidateId: `c-${n}`, version: 1, supersedesId: null, correctionReason: null, finality: "FINAL", mode: "PAPER", dataSource: "LIVE", candidateSource: "INDEPENDENT",
    setup: "BREAKOUT", detectorVersion: "opportunity-setups-v1", channelId: null, playbookRef: null, instrument: "ACME", timeframeSeconds: 900, side: "BUY", quantity: "100", entryPrice: "100", exitPrice: "102", grossPnl: "200.00", costs: "20.00", netPnl: "180.00", riskAmount: "200.00", rMultiple: "0.9",
    holdingSeconds: 3600, exitReason: "TARGET_HIT", trade: { stopMoves: 0, targetsHit: 1, partialExits: 1, stopHit: false }, regime: null, agentVersions: {}, evidenceRefs: [], predicted: {}, confidenceScore: 60, confidenceAt: new Date(T0 - 7_200_000), decidedAt: new Date(T0 - 3_600_000), openedAt: new Date(T0 - 3_600_000 + n * 1000),
    closedAt: new Date(T0 + n * 60_000), dataQuality: [], missing: [], createdAt: new Date(T0), ...o };
}
export const win = (o: Partial<AttributionRow> = {}) => rec({ netPnl: "180.00", grossPnl: "200.00", rMultiple: "0.9", ...o });
export const loss = (o: Partial<AttributionRow> = {}) => rec({ netPnl: "-220.00", grossPnl: "-200.00", rMultiple: "-1.1", exitReason: "STOP_HIT", exitPrice: "98", trade: { stopMoves: 0, targetsHit: 0, stopHit: true, partialExits: 0 }, ...o });
export const many = (k: number, make: () => AttributionRow): AttributionRow[] => Array.from({ length: k }, make);

export function facts(o: { status?: "OPEN" | "CLOSED"; outcome?: boolean; sources?: string[]; candidateData?: "FIXTURE" | "LIVE" | "HISTORICAL"; confidenceAfterOpen?: boolean; pnl?: string; events?: Record<string, number>; noConfidence?: boolean } = {}): AttributionFacts {
  const closed = (o.status ?? "CLOSED") === "CLOSED";
  const opened = new Date(T0), closedAt = new Date(T0 + 3_600_000);
  return {
    position: { id: "pos1", userId: "u1", accountId: "a1", decisionId: "dec1", instrument: "ACME", exchange: "NSE", side: "BUY", quantity: closed ? "0" : "50", initialQuantity: "100", avgEntryPrice: "100", initialStop: "98", stopLoss: closed ? "100" : "98", targets: ["104", "108"], realizedPnl: "180.00", realizedCosts: "20.00", status: closed ? "CLOSED" : "OPEN", exitReason: closed ? "TARGET_HIT" : null, openedAt: opened, closedAt: closed ? closedAt : null },
    outcome: closed && o.outcome !== false ? { id: "out1", pnl: o.pnl ?? "160.00", rMultiple: "0.8", exitPrice: "102", exitReason: "TARGET_HIT", closedAt } : null,
    decision: { candidateId: "cand1", createdAt: new Date(T0 - 60_000), riskAssessmentId: "ra1", confidenceAssessmentId: "ca1", researchPackageId: "rp1", evidenceRefs: ["ev:1"], versions: {}, permittedSize: { lots: 4 } },
    candidate: { source: "INDEPENDENT", setup: "BREAKOUT", dataSource: o.candidateData ?? "LIVE", evidence: [{ kind: "setup", detector: "opportunity-setups-v1", timeframeSeconds: 900 }], claimId: null, channelId: null, stopLoss: "98", targets: ["104", "108"] },
    confidence: o.noConfidence ? null : { score: 62, createdAt: new Date(o.confidenceAfterOpen ? T0 + 1000 : T0 - 120_000), provenance: null },
    risk: { verdict: "PASS", plannedRewardToRisk: "2.00", maxLossAtStop: "210.00" }, agentVersions: { "technical-structure-v1": "technical-structure-v1.1" },
    fills: { priceSources: o.sources ?? ["LIVE"], entryFills: 1, exitFills: closed ? 2 : 1, costs: "20.00", entryValue: "10000", entryQty: "100", exitValue: "10200", exitQty: "100" },
    events: o.events ?? { STOP_MOVED: 1, TARGET_HIT: 1, PARTIAL_EXIT: 1 }, regime: null,
  };
}
