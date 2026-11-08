import { add, ceilTo2, div, dec, mul, ZERO, type Dec } from "./decimal";
import type { FeeSchedule } from "./specs";

/** Transaction costs for ONE leg or a round trip, from a versioned fee schedule. Every figure rounds UP to the paisa (costs are never understated). */
export interface LegCosts { brokerage: Dec; exchange: Dec; sebi: Dec; stampDuty: Dec; stt: Dec; gst: Dec; other: Dec; total: Dec }
export const COST_MODEL_VERSION = "cost-model-v1";
const z: LegCosts = { brokerage: ZERO, exchange: ZERO, sebi: ZERO, stampDuty: ZERO, stt: ZERO, gst: ZERO, other: ZERO, total: ZERO };
export function legCosts(f: FeeSchedule, side: "BUY" | "SELL", price: Dec, quantity: bigint): LegCosts {
  if (quantity <= 0n || price <= 0n) return { ...z };
  const turnover = mul(price, dec(quantity), "up"), p = (rate: string): Dec => ceilTo2(mul(turnover, div(dec(rate), dec(100), "up"), "up"));
  const b = f.brokerage;
  const brokerage = b.kind === "NONE" ? ZERO : b.kind === "FLAT" ? ceilTo2(dec(b.perOrder)) : ((): Dec => { const v = p(b.percent); return b.capPerOrder !== null && v > dec(b.capPerOrder) ? ceilTo2(dec(b.capPerOrder)) : v; })();
  const exchange = p(f.exchangeChargePct), sebi = p(f.sebiPct), stampDuty = side === "BUY" ? p(f.stampDutyBuyPct) : ZERO, stt = side === "SELL" ? p(f.sttSellPct) : p(f.sttBuyPct);
  const gst = ceilTo2(mul(add(add(brokerage, exchange), sebi), div(dec(f.gstPctOnServices), dec(100), "up"), "up")), other = ceilTo2(dec(f.otherPerOrder));
  return { brokerage, exchange, sebi, stampDuty, stt, gst, other, total: brokerage + exchange + sebi + stampDuty + stt + gst + other };
}
export interface RoundTripCosts { entry: LegCosts; exit: LegCosts; total: Dec }
/** `side` is the ENTRY side; the exit leg is the opposite side. */
export function roundTripCosts(f: FeeSchedule, side: "BUY" | "SELL", entryPrice: Dec, exitPrice: Dec, quantity: bigint): RoundTripCosts {
  const entry = legCosts(f, side, entryPrice, quantity), exit = legCosts(f, side === "BUY" ? "SELL" : "BUY", exitPrice, quantity);
  return { entry, exit, total: entry.total + exit.total };
}
