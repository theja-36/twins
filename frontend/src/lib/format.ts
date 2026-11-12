/**
 * Display formatting. The frontend DISPLAYS backend values; it performs no financial or risk calculation.
 * Money arrives as decimal strings (or, for some fields, numbers); both are formatted by STRING handling only (grouping, sign), never by arithmetic.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;
export const isDecimalString = (v: unknown): v is string => typeof v === "string" && DECIMAL.test(v);

/** Indian digit grouping of an integer digit string: 1100920 -> 11,00,920. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3), tail = digits.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
}
/** "1100920.00" -> "11,00,920.00". Anything that is not a plain decimal is returned as the unavailable marker, never guessed. */
export function formatDecimal(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "number" ? String(v) : v;
  if (!isDecimalString(s)) return "—";
  const neg = s.startsWith("-"), body = neg ? s.slice(1) : s, [int = "0", frac] = body.split(".");
  return `${neg ? "−" : ""}${groupIndian(int)}${frac !== undefined ? `.${frac}` : ""}`;
}
export function formatMoney(v: string | number | null | undefined, currency = "INR"): string {
  const d = formatDecimal(v); if (d === "—") return d;
  const sym = currency === "INR" ? "₹" : currency;
  return d.startsWith("−") ? `−${sym} ${d.slice(1)}` : `${sym} ${d}`;
}
export type Sign = "gain" | "loss" | "flat";
/** Presentation sign of a decimal string (for the arrow and colour only): decided from the characters, never from a numeric value. */
export function signOf(v: string | null | undefined): Sign {
  if (!v || !isDecimalString(v)) return "flat";
  if (v.startsWith("-")) return /[1-9]/.test(v) ? "loss" : "flat";
  return /[1-9]/.test(v) ? "gain" : "flat";
}
/** An ISO timestamp shown in IST with the zone named. */
export function formatIst(iso: string | null | undefined): string {
  if (!iso) return "—"; const t = Date.parse(iso); if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t)) + " IST";
}
