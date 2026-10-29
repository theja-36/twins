/**
 * Pattern features (Stage 4 / Task 4): a deterministic function of the PARSED, normalized fields of a signal and its timestamp. No free text, no hidden intent, no generated names. Every
 * feature is a small closed set of values; anything the signal does not state is the explicit value UNKNOWN (or NA when the feature does not apply), never a guess.
 */
export const FEATURE_VERSION = "pattern-features-v1";
const TZ_OF_MARKET: Record<string, number> = { NSE: 330, BSE: 330, NFO: 330, BFO: 330 };
const DAY = 86_400_000;

export interface FeatureInput {
  market: string | null;
  instrumentType: string | null;
  underlying: string | null;
  optionType: string | null;
  side: string | null;
  entry: { type?: string; price?: number; low?: number; high?: number } | null;
  stopLoss: number | null;
  targets: number[];
  /** YYYY-MM-DD, only when the message stated a complete date. */
  expiryDate: string | null;
  /** When the signal was sent (the message time). */
  timestamp: Date;
}
export interface Features {
  market: string; instrumentType: string; underlying: string; optionType: string; side: string;
  timeOfDay: string; dayOfWeek: string; expiryProximity: string; entryType: string; stopDistance: string; rewardRisk: string; targetStructure: string;
}
const up = (v: string | null, empty = "UNKNOWN"): string => (v && v.trim() ? v.trim().toUpperCase() : empty);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function local(ts: Date, market: string): { minutes: number; dow: string; dayIndex: number } | null {
  const tz = TZ_OF_MARKET[market];
  if (tz === undefined) return null;
  const ms = ts.getTime() + tz * 60_000;
  const dayIndex = Math.floor(ms / DAY);
  const dow = ["THU", "FRI", "SAT", "SUN", "MON", "TUE", "WED"][((dayIndex % 7) + 7) % 7] as string; // 1970-01-01 was a Thursday
  return { minutes: Math.floor((ms - dayIndex * DAY) / 60_000), dow, dayIndex };
}
export function timeOfDayBucket(ts: Date, market: string): string {
  const l = local(ts, market);
  if (!l) return "UNKNOWN_TZ";
  return l.minutes < 555 ? "PRE_MARKET" : l.minutes < 630 ? "OPENING" : l.minutes < 840 ? "MIDDAY" : l.minutes < 930 ? "CLOSING" : "AFTER_HOURS";
}
export function expiryProximityBucket(expiryDate: string | null, ts: Date, market: string, isOption: boolean): string {
  if (!isOption) return "NA";
  if (!expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return "UNSTATED";
  const [y, m, d] = expiryDate.split("-").map(Number) as [number, number, number];
  const expiryDay = Date.UTC(y, m - 1, d) / DAY;
  const l = local(ts, market);
  const today = l ? l.dayIndex : Math.floor(ts.getTime() / DAY);
  const days = expiryDay - today;
  return days < 0 ? "EXPIRED" : days === 0 ? "SAME_DAY" : days <= 2 ? "D1_2" : days <= 7 ? "D3_7" : days <= 30 ? "D8_30" : "GT_30";
}
export function entryTypeBucket(entry: FeatureInput["entry"], side: string): string {
  const t = entry?.type;
  if ((t === "above" && side === "BUY") || (t === "below" && side === "SELL")) return "breakout";
  if ((t === "below" && side === "BUY") || (t === "above" && side === "SELL")) return "pullback";
  if (t === "at" || t === "range" || t === "near") return "level";
  return "unspecified"; // market, unspecified, or a direction that cannot be read
}
function entryRef(e: FeatureInput["entry"]): number | null {
  if (!e) return null;
  if (e.type === "range") return fin(e.low) && fin(e.high) && e.low > 0 && e.high >= e.low ? (e.low + e.high) / 2 : null;
  if (e.type === "at" || e.type === "above" || e.type === "below" || e.type === "near") return fin(e.price) && e.price > 0 ? e.price : null;
  return null;
}
export function stopDistanceBucket(ref: number | null, stop: number | null, side: string): string {
  if (ref === null || stop === null || !fin(stop) || stop <= 0 || (side !== "BUY" && side !== "SELL")) return "UNKNOWN";
  if (side === "BUY" ? !(stop < ref) : !(stop > ref)) return "INVALID";
  const pct = (Math.abs(ref - stop) / ref) * 100;
  return pct < 1 ? "LT_1PCT" : pct < 2 ? "1_2PCT" : pct < 5 ? "2_5PCT" : pct < 10 ? "5_10PCT" : "GTE_10PCT";
}
export function rewardRiskBucket(ref: number | null, stop: number | null, t1: number | undefined, side: string): string {
  if (ref === null || stop === null || t1 === undefined || !fin(t1) || t1 <= 0 || (side !== "BUY" && side !== "SELL")) return "UNKNOWN";
  if (side === "BUY" ? !(stop < ref && t1 > ref) : !(stop > ref && t1 < ref)) return "INVALID";
  const rr = Math.abs(t1 - ref) / Math.abs(ref - stop);
  return rr < 1 ? "LT_1" : rr < 2 ? "1_2" : rr < 3 ? "2_3" : "GTE_3";
}
export const targetStructure = (n: number): string => (n <= 0 ? "NONE" : n === 1 ? "T1" : n === 2 ? "T1_T2" : "T1_T2_T3");

export function deriveFeatures(i: FeatureInput): Features {
  const market = up(i.market);
  const side = up(i.side);
  const isOption = (i.instrumentType ?? "").toLowerCase() === "option";
  const ref = entryRef(i.entry);
  const l = local(i.timestamp, market);
  return {
    market, instrumentType: up(i.instrumentType), underlying: up(i.underlying), optionType: isOption ? up(i.optionType) : "NA", side,
    timeOfDay: timeOfDayBucket(i.timestamp, market), dayOfWeek: l ? l.dow : "UNKNOWN_TZ", expiryProximity: expiryProximityBucket(i.expiryDate, i.timestamp, market, isOption),
    entryType: entryTypeBucket(i.entry, side), stopDistance: stopDistanceBucket(ref, i.stopLoss, side), rewardRisk: rewardRiskBucket(ref, i.stopLoss, i.targets[0], side), targetStructure: targetStructure(i.targets.length),
  };
}

/** Level definitions: each level adds features to the previous one. Exact key match only - a signal never borrows from a "similar" pattern. */
export const PATTERN_LEVELS: ReadonlyArray<ReadonlyArray<keyof Features>> = [
  ["market", "instrumentType", "side"],
  ["market", "instrumentType", "side", "underlying"],
  ["market", "instrumentType", "side", "underlying", "timeOfDay", "expiryProximity"],
  ["market", "instrumentType", "side", "underlying", "timeOfDay", "expiryProximity", "stopDistance", "rewardRisk"],
];
export interface PatternKey { level: number; keyText: string; features: Record<string, string> }
export function patternKeys(f: Features): PatternKey[] {
  return PATTERN_LEVELS.map((names, i) => ({
    level: i + 1,
    keyText: `L${i + 1}|${names.map((n) => `${n}=${f[n]}`).join("|")}`,
    features: Object.fromEntries(names.map((n) => [n, f[n]])),
  }));
}
