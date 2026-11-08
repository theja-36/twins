import { dec, isDec, onTick } from "./decimal";

/**
 * Deterministic STRUCTURAL stop-loss checks used by sizing, risk and the simulator. This is NOT the mandatory stop-loss validation (packages/stop-loss, evidence-based): it only refuses stops that cannot be
 * evaluated safely. A stop that passes here is still `independentlyValidated: false`; Stage 07 must run the mandatory validation in the qualification path (G-18 stays open).
 */
export const STOP_CHECK_VERSION = "stop-structure-v1";
export type StopProblemCode = "STOP_MISSING" | "ENTRY_INVALID" | "STOP_INVALID" | "STOP_WRONG_SIDE" | "STOP_EQUALS_ENTRY" | "STOP_BASIS_INVALID" | "STOP_BASIS_MISMATCH" | "PRICE_OFF_TICK" | "SIDE_INVALID";
export interface StopCheckInput { side: string | null; entry: number | string | null; stop: number | string | null | undefined; stopBasis: string | null; instrumentType: "equity" | "future" | "option"; tick: string }
export type StopCheck = { ok: true } | { ok: false; code: StopProblemCode; detail: string };
export function checkStop(i: StopCheckInput): StopCheck {
  if (i.side !== "BUY" && i.side !== "SELL") return { ok: false, code: "SIDE_INVALID", detail: "the side is not BUY or SELL" };
  if (i.stop === null || i.stop === undefined) return { ok: false, code: "STOP_MISSING", detail: "no stop-loss is defined; missing is never safe" };
  if (i.entry === null || !isDec(i.entry) || dec(i.entry) <= 0n) return { ok: false, code: "ENTRY_INVALID", detail: "the entry price is missing or not positive" };
  if (!isDec(i.stop) || dec(i.stop) <= 0n) return { ok: false, code: "STOP_INVALID", detail: "the stop-loss is not a positive price" };
  if (i.stopBasis !== "price" && i.stopBasis !== "premium") return { ok: false, code: "STOP_BASIS_INVALID", detail: "the stop-loss basis must be price or premium" };
  // an option is bought/sold at a premium: a stop on the underlying price cannot size its loss
  if ((i.instrumentType === "option") !== (i.stopBasis === "premium")) return { ok: false, code: "STOP_BASIS_MISMATCH", detail: `a ${i.stopBasis} stop does not fit a ${i.instrumentType}` };
  const e = dec(i.entry), s = dec(i.stop), tick = dec(i.tick);
  if (s === e) return { ok: false, code: "STOP_EQUALS_ENTRY", detail: "the stop equals the entry: no risk distance" };
  if (i.side === "BUY" ? s > e : s < e) return { ok: false, code: "STOP_WRONG_SIDE", detail: i.side === "BUY" ? "a long needs the stop below the entry" : "a short needs the stop above the entry" };
  if (!onTick(e, tick) || !onTick(s, tick)) return { ok: false, code: "PRICE_OFF_TICK", detail: "the entry or stop is not a multiple of the tick size" };
  return { ok: true };
}
