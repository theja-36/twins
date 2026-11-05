import type { PaperTrade } from "./types";

const round = (x: number): number => Math.round(x * 100) / 100;
const sgn = (t: PaperTrade): 1 | -1 => (t.side === "BUY" ? 1 : -1);

/** Unrealised P&L of the still-open quantity at `price`. Zero when the trade holds nothing. */
export function unrealizedPnl(t: PaperTrade, price: number | null): number {
  if (t.state !== "OPEN" || price === null || t.fillPrice === null) return 0;
  return round(sgn(t) * (price - t.fillPrice) * t.remainingQuantity);
}
/** Risk per unit at entry (distance to the initial stop); the unit of an R multiple. */
export function riskPerUnit(t: PaperTrade): number | null {
  return t.fillPrice === null ? null : Math.abs(t.fillPrice - t.initialStop);
}
/** Total P&L (realised + unrealised) in R multiples of the initial risk; null before the fill. */
export function rMultiple(t: PaperTrade, price: number | null): number | null {
  const risk = riskPerUnit(t);
  if (risk === null || risk === 0) return null;
  return Math.round(((t.realizedPnl + unrealizedPnl(t, price)) / (risk * t.quantity)) * 100) / 100;
}

export interface PositionView {
  tradeId: string; riskDecisionId: string; symbol: string; side: string; state: string; quantity: number; remainingQuantity: number; entryPrice: number; fillPrice: number | null;
  stop: number; targets: number[]; targetsHit: number; trailingActive: boolean; lastPrice: number | null;
  realizedPnl: number; unrealizedPnl: number; totalPnl: number; rMultiple: number | null; openedAt: string | null;
}
export function positionView(t: PaperTrade, price: number | null): PositionView {
  const un = unrealizedPnl(t, price);
  return {
    tradeId: t.id, riskDecisionId: t.riskDecisionId, symbol: t.symbol, side: t.side, state: t.state, quantity: t.quantity, remainingQuantity: t.remainingQuantity, entryPrice: t.entryPrice,
    fillPrice: t.fillPrice, stop: t.stop, targets: t.targets, targetsHit: t.targetsHit, trailingActive: t.trailingActive, lastPrice: price, realizedPnl: round(t.realizedPnl), unrealizedPnl: un,
    totalPnl: round(t.realizedPnl + un), rMultiple: rMultiple(t, price), openedAt: t.openedAt,
  };
}

export interface PnlSummary { openPositions: number; pendingEntries: number; closedTrades: number; cancelledTrades: number; exposure: number; realizedPnl: number; unrealizedPnl: number; totalPnl: number }
export function summarize(trades: PaperTrade[], priceOf: (symbol: string) => number | null): PnlSummary {
  let open = 0, pending = 0, closed = 0, cancelled = 0, exposure = 0, realized = 0, unreal = 0;
  for (const t of trades) {
    realized += t.realizedPnl;
    if (t.state === "OPEN") { open += 1; const p = priceOf(t.symbol); unreal += unrealizedPnl(t, p); exposure += (p ?? t.fillPrice ?? 0) * t.remainingQuantity; }
    else if (t.state === "PENDING_ENTRY") pending += 1;
    else if (t.state === "CLOSED") closed += 1;
    else cancelled += 1;
  }
  return { openPositions: open, pendingEntries: pending, closedTrades: closed, cancelledTrades: cancelled, exposure: round(exposure), realizedPnl: round(realized), unrealizedPnl: round(unreal), totalPnl: round(realized + unreal) };
}
