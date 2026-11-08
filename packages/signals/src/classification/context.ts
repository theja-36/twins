import type { OptionsClaim } from "../options/types";
import type { SessionBucket, SignalContext } from "./types";

const IST_MIN = 330;
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

/** IST wall-clock parts of a UTC instant (no DST in India). */
export function istParts(t: Date): { weekday: number; minutes: number; y: number; m: number; d: number } {
  const s = new Date(t.getTime() + IST_MIN * 60_000);
  return { weekday: s.getUTCDay(), minutes: s.getUTCHours() * 60 + s.getUTCMinutes(), y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}
/** Exchange-session bucket by IST time. Holidays are not modelled here (the market-calendar agent owns that). */
export function sessionBucket(weekday: number, minutes: number): SessionBucket {
  if (weekday === 0 || weekday === 6) return "WEEKEND";
  if (minutes < 9 * 60 + 15 || minutes >= 15 * 60 + 30) return "OUTSIDE_SESSION";
  if (minutes < 9 * 60 + 45) return "OPENING";
  if (minutes < 11 * 60 + 30) return "MORNING";
  if (minutes < 13 * 60 + 30) return "MIDDAY";
  if (minutes < 15 * 60) return "AFTERNOON";
  return "CLOSING";
}

function daysToStatedExpiry(claim: OptionsClaim, t: Date): { days: number | null; assumed: boolean; stated: boolean } {
  const e = claim.expiry;
  if (e.status !== "full" && e.status !== "day_month" && e.status !== "year_two_digit" && e.status !== "year_dependent") return { days: null, assumed: false, stated: e.status !== "missing" };
  const p = istParts(t); const today = Date.UTC(p.y, p.m - 1, p.d);
  const fixedYear = e.status === "full" ? e.year : e.status === "year_two_digit" ? null : null;
  const tryYear = (y: number): number => Date.UTC(y, e.month - 1, e.day);
  const valid = (ms: number, y: number): boolean => { const d = new Date(ms); return d.getUTCFullYear() === y && d.getUTCMonth() === e.month - 1 && d.getUTCDate() === e.day; };
  if (fixedYear !== null) { const ms = tryYear(fixedYear); return valid(ms, fixedYear) ? { days: Math.round((ms - today) / 86_400_000), assumed: false, stated: true } : { days: null, assumed: false, stated: true }; }
  for (const y of [p.y, p.y + 1, p.y + 2]) { const ms = tryYear(y); if (valid(ms, y) && ms >= today) return { days: Math.round((ms - today) / 86_400_000), assumed: true, stated: true }; }
  return { days: null, assumed: true, stated: true };
}

/** Entry reference price for distance maths: the entry level, or the middle of a range. Null when the entry has no price. */
export function entryReference(claim: OptionsClaim): number | null {
  const e = claim.entry;
  if (e.type === "range") return round((e.low + e.high) / 2, 4);
  if (e.type === "at" || e.type === "above" || e.type === "below" || e.type === "near") return e.price;
  return null;
}

/** Setup-context reconstruction (Module 02): time, expiry proximity, entry condition and level geometry, from the parsed claim and the message time only. */
export function reconstructContext(claim: OptionsClaim, messageTimestamp: Date): SignalContext {
  const p = istParts(messageTimestamp); const ref = entryReference(claim); const e = claim.entry;
  const long = claim.action !== "sell";
  const stopDistancePct = ref !== null && ref > 0 && claim.stopLoss !== null ? round((Math.abs(ref - claim.stopLoss) / ref) * 100) : null;
  const firstTarget = claim.targets[0];
  const firstTargetDistancePct = ref !== null && ref > 0 && firstTarget !== undefined ? round((Math.abs(firstTarget - ref) / ref) * 100) : null;
  const risk = ref !== null && claim.stopLoss !== null ? Math.abs(ref - claim.stopLoss) : null;
  const rewardToRisk = risk !== null && risk > 0 && ref !== null ? claim.targets.filter((t) => (long ? t > ref : t < ref)).map((t) => round(Math.abs(t - ref) / risk)) : [];
  const exp = daysToStatedExpiry(claim, messageTimestamp);
  return {
    sessionBucket: sessionBucket(p.weekday, p.minutes), istWeekday: p.weekday, minutesSinceMidnightIst: p.minutes,
    daysToExpiry: exp.days, expiryYearAssumed: exp.assumed, expiryStated: exp.stated,
    entry: { kind: e.type, low: e.type === "range" ? e.low : ref, high: e.type === "range" ? e.high : ref, conditional: e.type === "above" || e.type === "below" || e.type === "near" },
    stopDistancePct, firstTargetDistancePct, rewardToRisk, levelBasis: claim.levelBasis, basisStated: claim.levelBasis !== "unspecified",
  };
}
