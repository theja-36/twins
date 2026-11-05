export type Side = "BUY" | "SELL";
export type TradeState = "PENDING_ENTRY" | "OPEN" | "CLOSED" | "CANCELLED";
export type CloseReason = "STOP_LOSS" | "TRAILING_STOP" | "BREAKEVEN_STOP" | "TARGET" | "SQUARE_OFF" | "MANUAL";
export type CancelReason = "ENTRY_EXPIRED" | "STOP_BREACHED_BEFORE_ENTRY" | "SESSION_END";

export interface Tick { price: number; at: string } // ISO timestamp of the price

export interface PaperExit { kind: "TARGET" | "STOP" | "SQUARE_OFF" | "MANUAL"; targetIndex?: number; price: number; quantity: number; at: string }

/** One simulated trade. A plain JSON-serialisable value: it is persisted as-is and stepped by pure functions. */
export interface PaperTrade {
  id: string;
  riskDecisionId: string;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number; // the planned (limit) entry
  initialStop: number;
  stop: number; // the CURRENT stop (moves to breakeven / trails)
  targets: number[]; // 1..3 prices, ascending for BUY, descending for SELL
  state: TradeState;
  fillPrice: number | null;
  remainingQuantity: number;
  targetsHit: number;
  trailingActive: boolean;
  extreme: number | null; // best price seen since the fill (high for BUY, low for SELL)
  worst: number | null; // worst price seen since the fill
  realizedPnl: number;
  exits: PaperExit[];
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: CloseReason | null;
  cancelReason: CancelReason | null;
}

export type TradeEventType = "CREATED" | "ENTRY_FILLED" | "STOP_MOVED" | "TARGET_HIT" | "STOPPED_OUT" | "SQUARED_OFF" | "CLOSED" | "CANCELLED";
export interface TradeEvent { type: TradeEventType; at: string; price: number | null; quantity: number | null; detail: Record<string, string | number | boolean | null> }
