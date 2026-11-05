import { rMultiple } from "./pnl";
import type { PaperTrade } from "./types";

/**
 * The learning loop, first slice: every CLOSED paper trade becomes one immutable outcome record, and plain statistics are computed over outcomes. Nothing here changes a weight, a threshold or
 * an agent: it only measures. (Adaptive use of the numbers is a later, reviewed decision.)
 */
export type OutcomeClass = "WIN" | "LOSS" | "BREAKEVEN";
export interface OutcomeContext { sourceTrustTier: string | null; confidenceScore: number | null; researchAssessment: string | null }
export interface TradeOutcome {
  tradeId: string; riskDecisionId: string; symbol: string; side: string; outcome: OutcomeClass; pnl: number; rMultiple: number; closeReason: string; targetsHit: number; holdingSeconds: number;
  /** Maximum favourable / adverse excursion from the fill, in R. */
  mfeR: number; maeR: number; closedAt: string; context: OutcomeContext;
}

const BREAKEVEN_R = 0.05; // |R| below this counts as break-even
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function toOutcome(t: PaperTrade, context: OutcomeContext): TradeOutcome | null {
  if (t.state !== "CLOSED" || t.fillPrice === null || t.closeReason === null || t.closedAt === null || t.openedAt === null) return null;
  const risk = Math.abs(t.fillPrice - t.initialStop);
  const r = rMultiple(t, null);
  if (r === null || risk === 0) return null;
  const s = t.side === "BUY" ? 1 : -1;
  const mfe = t.extreme === null ? 0 : (s * (t.extreme - t.fillPrice)) / risk;
  const mae = t.worst === null ? 0 : (s * (t.fillPrice - t.worst)) / risk;
  return {
    tradeId: t.id, riskDecisionId: t.riskDecisionId, symbol: t.symbol, side: t.side, outcome: r > BREAKEVEN_R ? "WIN" : r < -BREAKEVEN_R ? "LOSS" : "BREAKEVEN", pnl: r2(t.realizedPnl), rMultiple: r,
    closeReason: t.closeReason, targetsHit: t.targetsHit, holdingSeconds: Math.max(0, Math.round((Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 1000)), mfeR: r2(Math.max(0, mfe)), maeR: r2(Math.max(0, mae)),
    closedAt: t.closedAt, context,
  };
}

export interface GroupStats { n: number; wins: number; losses: number; breakeven: number; winRate: number | null; avgR: number | null; totalR: number; totalPnl: number }
export interface OutcomeStats extends GroupStats {
  avgWinR: number | null; avgLossR: number | null; expectancyR: number | null; profitFactor: number | null; maxDrawdownR: number; avgHoldingSeconds: number | null;
  byCloseReason: Record<string, GroupStats>; bySourceTrustTier: Record<string, GroupStats>; byResearchAssessment: Record<string, GroupStats>;
  /** Fewer than this many outcomes: the numbers are noise and the UI should say so. */
  minSampleForMeaning: number; sampleIsMeaningful: boolean;
}
export const MIN_SAMPLE = 30;

function group(os: TradeOutcome[]): GroupStats {
  const wins = os.filter((o) => o.outcome === "WIN").length, losses = os.filter((o) => o.outcome === "LOSS").length;
  const totalR = os.reduce((a, o) => a + o.rMultiple, 0);
  return { n: os.length, wins, losses, breakeven: os.length - wins - losses, winRate: os.length ? r2(wins / os.length) : null, avgR: os.length ? r2(totalR / os.length) : null, totalR: r2(totalR), totalPnl: r2(os.reduce((a, o) => a + o.pnl, 0)) };
}
const by = (os: TradeOutcome[], key: (o: TradeOutcome) => string): Record<string, GroupStats> => {
  const m = new Map<string, TradeOutcome[]>();
  for (const o of os) { const k = key(o); (m.get(k) ?? m.set(k, []).get(k)!).push(o); }
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, group(v)]));
};

export function computeStats(outcomes: TradeOutcome[]): OutcomeStats {
  const ordered = [...outcomes].sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : 0));
  const g = group(ordered);
  const wins = ordered.filter((o) => o.outcome === "WIN"), losses = ordered.filter((o) => o.outcome === "LOSS");
  const grossWin = wins.reduce((a, o) => a + o.rMultiple, 0), grossLoss = Math.abs(losses.reduce((a, o) => a + o.rMultiple, 0));
  let peak = 0, cum = 0, dd = 0;
  for (const o of ordered) { cum += o.rMultiple; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return {
    ...g, avgWinR: wins.length ? r2(grossWin / wins.length) : null, avgLossR: losses.length ? r2(-grossLoss / losses.length) : null,
    expectancyR: g.n ? r2(g.totalR / g.n) : null, profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null, maxDrawdownR: r2(dd),
    avgHoldingSeconds: g.n ? Math.round(ordered.reduce((a, o) => a + o.holdingSeconds, 0) / g.n) : null,
    byCloseReason: by(ordered, (o) => o.closeReason), bySourceTrustTier: by(ordered, (o) => o.context.sourceTrustTier ?? "UNKNOWN"), byResearchAssessment: by(ordered, (o) => o.context.researchAssessment ?? "NONE"),
    minSampleForMeaning: MIN_SAMPLE, sampleIsMeaningful: g.n >= MIN_SAMPLE,
  };
}
