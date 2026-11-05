import type { PaperConfig } from "./config";
import type { CloseReason, PaperExit, PaperTrade, Side, Tick, TradeEvent } from "./types";

/**
 * Trade management for PAPER trades: simulated entry fill, stop loss, up to three partial targets, break-even stop and trailing stop. Pure functions over a JSON value: no clock, no
 * database, no network, no broker. Conservative on a single price: the stop is checked before targets, fills are never better than the limit, and slippage is always adverse.
 */
export class PaperTradeError extends Error {
  constructor(readonly code: string) { super(`invalid paper trade: ${code}`); }
}
const sgn = (s: Side): 1 | -1 => (s === "BUY" ? 1 : -1);
const round = (x: number): number => Math.round(x * 1e6) / 1e6;
const posNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

export interface NewTrade { id: string; riskDecisionId: string; symbol: string; side: Side; quantity: number; entryPrice: number; stop: number; targets: number[]; now: string }

export function createTrade(i: NewTrade): { trade: PaperTrade; events: TradeEvent[] } {
  if (!/^[A-Za-z0-9 _&.:-]{1,64}$/.test(i.symbol)) throw new PaperTradeError("symbol");
  if (i.side !== "BUY" && i.side !== "SELL") throw new PaperTradeError("side");
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10_000_000) throw new PaperTradeError("quantity");
  if (![i.entryPrice, i.stop, ...i.targets].every(posNum)) throw new PaperTradeError("price");
  if (i.targets.length < 1 || i.targets.length > 3) throw new PaperTradeError("targets");
  const s = sgn(i.side);
  if (s * (i.entryPrice - i.stop) <= 0) throw new PaperTradeError("stop_side");
  let prev = i.entryPrice;
  for (const t of i.targets) { if (s * (t - prev) <= 0) throw new PaperTradeError("target_order"); prev = t; }
  const trade: PaperTrade = {
    id: i.id, riskDecisionId: i.riskDecisionId, symbol: i.symbol, side: i.side, quantity: i.quantity, entryPrice: i.entryPrice, initialStop: i.stop, stop: i.stop, targets: [...i.targets],
    state: "PENDING_ENTRY", fillPrice: null, remainingQuantity: i.quantity, targetsHit: 0, trailingActive: false, extreme: null, worst: null, realizedPnl: 0, exits: [], createdAt: i.now,
    openedAt: null, closedAt: null, closeReason: null, cancelReason: null,
  };
  return { trade, events: [{ type: "CREATED", at: i.now, price: i.entryPrice, quantity: i.quantity, detail: { side: i.side, stop: i.stop, targets: i.targets.length } }] };
}

/** Quantity closed at target index `i` (0-based) of `n` targets: the configured fraction of the original quantity, the last target takes everything that remains. */
function exitQuantity(t: PaperTrade, i: number, cfg: PaperConfig): number {
  const n = t.targets.length;
  if (i === n - 1) return t.remainingQuantity;
  const share = cfg.exitFractions.slice(0, n).reduce((a, b) => a + b, 0) || 1;
  const q = Math.max(1, Math.floor((t.quantity * cfg.exitFractions[i]!) / share));
  return q >= t.remainingQuantity ? t.remainingQuantity : q;
}

function applyExit(t: PaperTrade, kind: PaperExit["kind"], price: number, quantity: number, at: string, targetIndex?: number): PaperTrade {
  const pnl = sgn(t.side) * (price - (t.fillPrice as number)) * quantity;
  const exit: PaperExit = { kind, price: round(price), quantity, at, ...(targetIndex !== undefined ? { targetIndex } : {}) };
  return { ...t, remainingQuantity: t.remainingQuantity - quantity, realizedPnl: round(t.realizedPnl + pnl), exits: [...t.exits, exit] };
}

const closeWith = (t: PaperTrade, reason: CloseReason, at: string): PaperTrade => ({ ...t, state: "CLOSED", closeReason: reason, closedAt: at });

function stopReason(t: PaperTrade): CloseReason {
  if (t.stop === t.initialStop) return "STOP_LOSS";
  return t.trailingActive ? "TRAILING_STOP" : "BREAKEVEN_STOP";
}

export function step(trade: PaperTrade, tick: Tick, cfg: PaperConfig): { trade: PaperTrade; events: TradeEvent[] } {
  if (!Number.isFinite(tick.price) || tick.price <= 0 || Number.isNaN(Date.parse(tick.at))) return { trade, events: [] }; // a bad tick changes nothing
  if (trade.state === "CLOSED" || trade.state === "CANCELLED") return { trade, events: [] };
  const s = sgn(trade.side);
  const bps = cfg.slippageBps / 10_000;
  const events: TradeEvent[] = [];
  let t: PaperTrade = trade;

  if (t.state === "PENDING_ENTRY") {
    if (Date.parse(tick.at) - Date.parse(t.createdAt) >= cfg.entryExpiryMinutes * 60_000) {
      t = { ...t, state: "CANCELLED", cancelReason: "ENTRY_EXPIRED", closedAt: tick.at };
      return { trade: t, events: [{ type: "CANCELLED", at: tick.at, price: tick.price, quantity: null, detail: { reason: "ENTRY_EXPIRED" } }] };
    }
    if (s * (tick.price - t.initialStop) <= 0) {
      t = { ...t, state: "CANCELLED", cancelReason: "STOP_BREACHED_BEFORE_ENTRY", closedAt: tick.at };
      return { trade: t, events: [{ type: "CANCELLED", at: tick.at, price: tick.price, quantity: null, detail: { reason: "STOP_BREACHED_BEFORE_ENTRY" } }] };
    }
    if (s * (t.entryPrice - tick.price) >= 0) { // BUY: price at or below the limit; SELL: at or above
      const fill = round(s === 1 ? Math.min(t.entryPrice, tick.price * (1 + bps)) : Math.max(t.entryPrice, tick.price * (1 - bps))); // never worse than the limit
      t = { ...t, state: "OPEN", fillPrice: fill, openedAt: tick.at, extreme: fill, worst: fill };
      events.push({ type: "ENTRY_FILLED", at: tick.at, price: fill, quantity: t.quantity, detail: { limit: t.entryPrice } });
    }
    return { trade: t, events };
  }

  // OPEN
  const extreme = s === 1 ? Math.max(t.extreme as number, tick.price) : Math.min(t.extreme as number, tick.price);
  const worst = s === 1 ? Math.min(t.worst as number, tick.price) : Math.max(t.worst as number, tick.price);
  t = { ...t, extreme, worst };

  if (s * (tick.price - t.stop) <= 0) { // stop first (conservative)
    const base = s === 1 ? Math.min(t.stop, tick.price) : Math.max(t.stop, tick.price); // a gap through the stop fills at the gap price
    const px = round(base * (1 - s * bps));
    const reason = stopReason(t);
    const qty = t.remainingQuantity;
    t = closeWith(applyExit(t, "STOP", px, qty, tick.at), reason, tick.at);
    events.push({ type: "STOPPED_OUT", at: tick.at, price: px, quantity: qty, detail: { reason, stop: t.stop } }, { type: "CLOSED", at: tick.at, price: px, quantity: null, detail: { reason, realizedPnl: t.realizedPnl } });
    return { trade: t, events };
  }

  while (t.targetsHit < t.targets.length && s * (tick.price - t.targets[t.targetsHit]!) >= 0) {
    const i = t.targetsHit;
    const price = t.targets[i]!;
    const qty = exitQuantity(t, i, cfg);
    t = { ...applyExit(t, "TARGET", price, qty, tick.at, i), targetsHit: i + 1 };
    events.push({ type: "TARGET_HIT", at: tick.at, price, quantity: qty, detail: { target: i + 1 } });
    if (t.remainingQuantity === 0) {
      t = closeWith(t, "TARGET", tick.at);
      events.push({ type: "CLOSED", at: tick.at, price, quantity: null, detail: { reason: "TARGET", realizedPnl: t.realizedPnl } });
      return { trade: t, events };
    }
    if (i === 0 && cfg.breakevenAfterTarget1) {
      const be = t.fillPrice as number;
      if (s * (be - t.stop) > 0) { t = { ...t, stop: be }; events.push({ type: "STOP_MOVED", at: tick.at, price: be, quantity: null, detail: { kind: "BREAKEVEN" } }); }
    }
  }

  if (!t.trailingActive && cfg.trail.kind !== "none" && t.targetsHit >= cfg.trailAfterTargets) t = { ...t, trailingActive: true };
  if (t.trailingActive && cfg.trail.kind !== "none") {
    const dist = cfg.trail.kind === "percent" ? (extreme * cfg.trail.value) / 100 : cfg.trail.value;
    const candidate = round(s === 1 ? extreme - dist : extreme + dist);
    if (s * (candidate - t.stop) > 0 && s * (tick.price - candidate) > 0) { // tighten only, and never to a level the price has already crossed
      t = { ...t, stop: candidate };
      events.push({ type: "STOP_MOVED", at: tick.at, price: candidate, quantity: null, detail: { kind: "TRAILING" } });
    }
  }
  return { trade: t, events };
}

/** End of session / manual exit at the given price: closes an open trade (adverse slippage) or cancels a pending one. */
export function exitNow(trade: PaperTrade, tick: Tick, cfg: PaperConfig, kind: "SQUARE_OFF" | "MANUAL"): { trade: PaperTrade; events: TradeEvent[] } {
  if (trade.state === "CLOSED" || trade.state === "CANCELLED") return { trade, events: [] };
  if (trade.state === "PENDING_ENTRY") {
    return { trade: { ...trade, state: "CANCELLED", cancelReason: "SESSION_END", closedAt: tick.at }, events: [{ type: "CANCELLED", at: tick.at, price: tick.price, quantity: null, detail: { reason: "SESSION_END" } }] };
  }
  const s = sgn(trade.side);
  const px = round(tick.price * (1 - s * (cfg.slippageBps / 10_000)));
  const qty = trade.remainingQuantity;
  const t = closeWith(applyExit(trade, kind, px, qty, tick.at), kind === "MANUAL" ? "MANUAL" : "SQUARE_OFF", tick.at);
  return { trade: t, events: [{ type: "SQUARED_OFF", at: tick.at, price: px, quantity: qty, detail: { kind } }, { type: "CLOSED", at: tick.at, price: px, quantity: null, detail: { reason: t.closeReason, realizedPnl: t.realizedPnl } }] };
}

/** Cancels a pending entry that has outlived its expiry even when no price is available (so an unmonitorable trade cannot stay pending forever). */
export function expirePending(trade: PaperTrade, nowIso: string, cfg: PaperConfig): { trade: PaperTrade; events: TradeEvent[] } {
  if (trade.state !== "PENDING_ENTRY" || Number.isNaN(Date.parse(nowIso)) || Date.parse(nowIso) - Date.parse(trade.createdAt) < cfg.entryExpiryMinutes * 60_000) return { trade, events: [] };
  return { trade: { ...trade, state: "CANCELLED", cancelReason: "ENTRY_EXPIRED", closedAt: nowIso }, events: [{ type: "CANCELLED", at: nowIso, price: null, quantity: null, detail: { reason: "ENTRY_EXPIRED" } }] };
}
