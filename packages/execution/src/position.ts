import { validateStopLoss } from "@twins/stop-loss";
import { abs, ceilTo2, dec, div, floorTo2, mul, str, ZERO, type Dec, type FeeSchedule } from "@twins/planning";

/**
 * Position arithmetic and exit rules (Module 14), PURE and in fixed-point decimals. An ORDER is an instruction, a FILL is what happened, a POSITION is the net result: this file only turns fills into position figures and
 * decides what a price observation requires. It never reads a clock or a price itself.
 */
export const POSITION_RULES_VERSION = "position-rules-v1";
export interface PositionRules {
  version: string; instrumentKind: "equity" | "option"; lotSize: string; stopBasis: "price" | "premium";
  /** Share of the INITIAL quantity to exit at each target (decimal fractions); the last target exits everything that remains. */
  ladder: string[];
  /** After target index N is taken, move the stop to the average entry (breakeven). null = never. */
  breakevenAfterTarget: number | null;
  /** Once price has moved this many initial-risk distances in favour, trail the stop one risk distance behind price. null = no trailing. */
  trailAfterR: string | null;
  /** IST minutes since midnight at which any remaining quantity is exited (intraday discipline). null = none. */
  sessionCloseExitMinutes: number | null;
  /** The instrument's expiry date (YYYY-MM-DD) for derivatives; exits on the expiry day at/after expiryExitMinutes, immediately after it. */
  expiry: string | null; expiryExitMinutes: number;
  maxHoldMinutes: number | null;
  /** An open loss larger than this multiple of the planned stop-out loss is a risk breach (recorded and escalated). */
  riskBreachMultiple: string;
  fees: FeeSchedule | null;
}
export const DEFAULT_RULES_BASE = { version: POSITION_RULES_VERSION, ladder: ["0.5"], breakevenAfterTarget: 0 as number | null, trailAfterR: "1" as string | null, sessionCloseExitMinutes: 15 * 60 + 15 as number | null, expiryExitMinutes: 15 * 60, maxHoldMinutes: null as number | null, riskBreachMultiple: "1.5" };
const dir = (side: "BUY" | "SELL"): Dec => (side === "BUY" ? dec(1) : dec(-1));

export const applyEntryFill = (pos: { quantity: Dec; avg: Dec }, fillQty: Dec, price: Dec): { quantity: Dec; avg: Dec } => {
  const q = pos.quantity + fillQty;
  return { quantity: q, avg: q === ZERO ? ZERO : div(mul(pos.avg, pos.quantity) + mul(price, fillQty), q, "up") };
};
/** Realised P&L of an exit fill, gross of costs: positive is a gain for the position's direction. Rounded toward the conservative side (gains down, losses up). */
export function exitPnl(side: "BUY" | "SELL", avgEntry: Dec, exitPrice: Dec, qty: Dec): Dec {
  const raw = mul(mul(exitPrice - avgEntry, dir(side)), qty, "down");
  return raw >= ZERO ? floorTo2(raw) : -ceilTo2(-raw);
}
export const unrealizedPnl = (side: "BUY" | "SELL", avg: Dec, qty: Dec, price: Dec): Dec => exitPnl(side, avg, price, qty);

export type PositionAction =
  | { kind: "EXIT"; quantity: Dec; reason: "STOP_HIT" | "TARGET_HIT" | "TIME_EXIT" | "EXPIRY_EXIT"; detail: string; targetIndex?: number }
  | { kind: "MOVE_STOP"; stop: Dec; reason: "BREAKEVEN" | "TRAIL"; validation: "VALID" }
  | { kind: "STOP_MOVE_REFUSED"; proposed: Dec; reason: string }
  | { kind: "RISK_BREACH"; detail: string };
export interface PositionView { side: "BUY" | "SELL"; quantity: Dec; initialQuantity: Dec; avgEntry: Dec; initialStop: Dec; stop: Dec; targets: Dec[]; openedAt: Date; plannedMaxLoss: Dec | null }
const ist = (d: Date): { minutes: number; date: string } => { const t = new Date(d.getTime() + 330 * 60_000); return { minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), date: t.toISOString().slice(0, 10) }; };
const wholeLots = (q: Dec, lot: Dec): Dec => (lot <= ZERO ? q : (q / lot) * lot);

/**
 * What a price observation requires of a position, in priority order: a stop breach (exit everything, at the observed price: a gap fills worse than the stop, never better), a time or expiry exit, target exits along the ladder,
 * then protective stop moves (each validated by the mandatory stop-loss rule against the CURRENT price, and only ever tightening), and a risk-breach flag. Missing prices never reach this function.
 */
export function evaluatePosition(p: PositionView, price: Dec, now: Date, r: PositionRules): PositionAction[] {
  const out: PositionAction[] = [], buy = p.side === "BUY", lot = dec(r.lotSize), remaining = p.quantity;
  if (remaining <= ZERO) return out;
  if (buy ? price <= p.stop : price >= p.stop) return [{ kind: "EXIT", quantity: remaining, reason: "STOP_HIT", detail: `price ${str(price, 4)} reached the stop ${str(p.stop, 4)}` }];
  const t = ist(now);
  if (r.expiry !== null && (r.expiry < t.date || (r.expiry === t.date && t.minutes >= r.expiryExitMinutes))) return [{ kind: "EXIT", quantity: remaining, reason: "EXPIRY_EXIT", detail: `instrument expiry ${r.expiry}` }];
  if (r.sessionCloseExitMinutes !== null && t.minutes >= r.sessionCloseExitMinutes) return [{ kind: "EXIT", quantity: remaining, reason: "TIME_EXIT", detail: "session-close exit" }];
  if (r.maxHoldMinutes !== null && now.getTime() - p.openedAt.getTime() >= r.maxHoldMinutes * 60_000) return [{ kind: "EXIT", quantity: remaining, reason: "TIME_EXIT", detail: `held ${r.maxHoldMinutes} minutes` }];
  // targets: the ladder is cumulative on the INITIAL quantity; what has already been exited tells which rungs are done
  const exited = p.initialQuantity - remaining, n = p.targets.length;
  const cumTarget = (i: number): Dec => { if (i >= n - 1) return p.initialQuantity; let c = ZERO; for (let k = 0; k <= i; k++) c += mul(p.initialQuantity, dec(r.ladder[k] ?? "0"), "down"); return wholeLots(c, lot); };
  let best: { i: number; q: Dec } | null = null;
  for (let i = 0; i < n; i++) {
    if (!(buy ? price >= (p.targets[i] as Dec) : price <= (p.targets[i] as Dec))) break;
    const tq = cumTarget(i);
    if (exited < tq) best = { i, q: i === n - 1 ? remaining : (tq - exited > remaining ? remaining : tq - exited) };
  }
  if (best && best.q > ZERO) return [{ kind: "EXIT", quantity: best.q, reason: "TARGET_HIT", detail: `target ${best.i + 1} (${str(p.targets[best.i] as Dec, 4)}) reached`, targetIndex: best.i }];
  // protective stop moves (never loosen; validated against the current price by the shared stop-loss rule)
  const risk = abs(p.avgEntry - p.initialStop), kind = r.instrumentKind;
  const tryMove = (stop: Dec, reason: "BREAKEVEN" | "TRAIL"): void => {
    if (buy ? stop <= p.stop : stop >= p.stop) return; // not tighter
    const v = validateStopLoss({ instrumentType: kind, side: buy ? "buy" : "sell", stopLoss: str(stop, 4), entryPrice: str(price, 4), levelBasis: r.stopBasis });
    out.push(v.result === "VALID" ? { kind: "MOVE_STOP", stop, reason, validation: "VALID" } : { kind: "STOP_MOVE_REFUSED", proposed: stop, reason: `${v.result}${v.reasonCode ? `:${v.reasonCode}` : ""}` });
  };
  if (r.breakevenAfterTarget !== null && exited > ZERO) {
    if (exited >= cumTarget(Math.min(r.breakevenAfterTarget, n - 1))) tryMove(p.avgEntry, "BREAKEVEN");
  }
  if (r.trailAfterR !== null && risk > ZERO) {
    const favourable = buy ? price - p.avgEntry : p.avgEntry - price;
    if (favourable >= mul(risk, dec(r.trailAfterR), "up")) tryMove(buy ? price - risk : price + risk, "TRAIL");
  }
  // risk breach: an open loss beyond the planned stop-out loss times the multiple (a gap or a missed stop)
  if (p.plannedMaxLoss !== null && p.plannedMaxLoss > ZERO) {
    const open = unrealizedPnl(p.side, p.avgEntry, remaining, price);
    if (open < ZERO && -open > mul(p.plannedMaxLoss, dec(r.riskBreachMultiple), "up")) out.push({ kind: "RISK_BREACH", detail: `open loss ${str(-open)} exceeds ${r.riskBreachMultiple}x the planned ${str(p.plannedMaxLoss)}` });
  }
  return out;
}
