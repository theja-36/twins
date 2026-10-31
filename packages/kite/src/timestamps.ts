/** Kite reports exchange time in IST (UTC+05:30) with no zone marker in quotes, and with a "+0530" offset in candles. Nothing here ever falls back to the local clock. */
const IST_OFFSET_MIN = 330;
const QUOTE_TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const CANDLE_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):?(\d{2})$/;

const n = (m: RegExpExecArray, i: number): number => Number(m[i]);

function utcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, offsetMin: number): number | null {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null; // rejects 2026-02-31, 25:00:00
  return ms - offsetMin * 60_000;
}

/** "2021-06-08 15:45:56" (IST) -> ISO instant (UTC, `Z`). The "0000-00-00 00:00:00" placeholder, other formats and impossible dates -> null. */
export function parseQuoteTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = QUOTE_TS.exec(value);
  if (!m) return null;
  const ms = utcMs(n(m, 1), n(m, 2), n(m, 3), n(m, 4), n(m, 5), n(m, 6), IST_OFFSET_MIN);
  return ms === null || n(m, 1) < 2000 ? null : new Date(ms).toISOString();
}

/** "2017-12-15T09:15:00+0530" (or +05:30) -> { instant, iso with the ORIGINAL offset written as +HH:MM }. */
export function parseCandleTimestamp(value: unknown): { instant: number; iso: string } | null {
  if (typeof value !== "string") return null;
  const m = CANDLE_TS.exec(value);
  if (!m) return null;
  const offset = (m[7] === "-" ? -1 : 1) * (n(m, 8) * 60 + n(m, 9));
  if (n(m, 8) > 14 || n(m, 9) > 59) return null;
  const ms = utcMs(n(m, 1), n(m, 2), n(m, 3), n(m, 4), n(m, 5), n(m, 6), offset);
  return ms === null ? null : { instant: ms, iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}` };
}

/** A Date -> "yyyy-mm-dd hh:mm:ss" in IST, the format the historical endpoint expects for from/to. */
export function toKiteParam(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("invalid date");
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(ist.getUTCFullYear(), 4)}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}

/** Today's date in IST (yyyy-mm-dd), for the expired-contract guard. */
export const istDate = (now: Date): string => toKiteParam(now).slice(0, 10);
