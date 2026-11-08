/**
 * Fixed-point decimal arithmetic for money, prices and rates (Module 08). A value is a BigInt scaled by 10^8: no binary floating point is ever used for a monetary result.
 * Rounding is always explicit and CONSERVATIVE at the call site: amounts at risk and costs round UP, profits round DOWN, quantities round DOWN.
 */
export type Dec = bigint;
export const SCALE_DP = 8;
export const S: Dec = 100_000_000n;
export const ZERO: Dec = 0n;
const RE = /^-?\d+(\.\d+)?$/;
/** Exact parse of a decimal string (at most 8 decimals) or of a finite number (rendered to 8 decimals, which is exact for any price/rate with up to 8 decimals). */
export function dec(v: string | number | bigint): Dec {
  if (typeof v === "bigint") return v * S;
  let s: string;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new RangeError("not a finite number"); s = v.toFixed(SCALE_DP); } else s = v.trim();
  if (!RE.test(s)) throw new RangeError(`not a decimal: ${s.slice(0, 24)}`);
  const neg = s.startsWith("-"); if (neg) s = s.slice(1);
  const [i, f = ""] = s.split("."); if (f.length > SCALE_DP && /[1-9]/.test(f.slice(SCALE_DP))) throw new RangeError("more than 8 decimals");
  const r = BigInt(i as string) * S + BigInt((f + "00000000").slice(0, SCALE_DP));
  return neg ? -r : r;
}
export const isDec = (v: unknown): v is string | number => { try { dec(v as never); return true; } catch { return false; } };
export const add = (a: Dec, b: Dec): Dec => a + b;
export const sub = (a: Dec, b: Dec): Dec => a - b;
const divRound = (n: bigint, d: bigint, mode: "up" | "down"): bigint => {
  if (d === 0n) throw new RangeError("division by zero");
  const neg = (n < 0n) !== (d < 0n), an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
  const q = an / ad, r = an % ad;
  // "up" = away from zero for positive results (conservative for losses and costs); "down" = toward zero
  const up = mode === "up" && r > 0n ? 1n : 0n;
  const m = q + up;
  return neg ? -m : m;
};
export const mul = (a: Dec, b: Dec, mode: "up" | "down" = "down"): Dec => divRound(a * b, S, mode);
export const div = (a: Dec, b: Dec, mode: "up" | "down" = "down"): Dec => divRound(a * S, b, mode);
export const min = (...xs: Dec[]): Dec => xs.reduce((a, b) => (b < a ? b : a));
export const max = (...xs: Dec[]): Dec => xs.reduce((a, b) => (b > a ? b : a));
export const abs = (a: Dec): Dec => (a < 0n ? -a : a);
/** Whole number of `unit`s that fit in `a` (rounded down). Both must be positive. */
export const wholeUnits = (a: Dec, unit: Dec): bigint => { if (unit <= 0n) throw new RangeError("unit must be positive"); return a <= 0n ? 0n : a / unit; };
/** Rounds to `dp` decimals, UP (away from zero) or DOWN (toward zero). */
export function roundTo(a: Dec, dp: number, mode: "up" | "down"): Dec {
  const unit = 10n ** BigInt(SCALE_DP - dp);
  return divRound(a, unit, mode) * unit;
}
export function str(a: Dec, dp = 2): string {
  const neg = a < 0n, v = neg ? -a : a, r = roundTo(v, dp, "down");
  const i = r / S, f = (r % S).toString().padStart(SCALE_DP, "0").slice(0, dp);
  return `${neg && r !== 0n ? "-" : ""}${i}${dp > 0 ? "." + f : ""}`;
}
/** Is `price` an exact multiple of `tick`? */
export const onTick = (price: Dec, tick: Dec): boolean => tick > 0n && price % tick === 0n;
/** percent (as a decimal like 1.5 meaning 1.5%) of an amount. */
export const pct = (amount: Dec, percent: Dec, mode: "up" | "down" = "down"): Dec => mul(amount, div(percent, dec(100)), mode);
/** Rounds a monetary amount UP to the paisa. */
export const ceilTo2 = (a: Dec): Dec => roundTo(a, 2, "up");
export const floorTo2 = (a: Dec): Dec => roundTo(a, 2, "down");
