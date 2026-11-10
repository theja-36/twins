import { swings, type OhlcSeries } from "@twins/agents";
import type { SetupSignal } from "./setups";

/**
 * Opportunity screens (Module 16). Both are PURE and deterministic; neither invents data and neither can approve anything.
 *  1. Reward:risk against STRUCTURE (M16-08): the setups' targets are R multiples by construction, so on their own they say nothing about whether price has room to reach them. This screen finds the nearest OPPOSING swing
 *     level between the entry and the reference target (the second target, else the first) and measures the reward that is actually open: if a swing high (long) or swing low (short) sits closer than the minimum reward:risk
 *     allows, the candidate is screened out with the level named. No opposing level inside the lookback means the path is clear and the target's own multiple is used.
 *  2. Calendar gate (M16-06): a closed market or an imminent high-impact event stops the scan with an explicit status; an unavailable or unknown calendar never blocks AND never counts as "all clear": it is recorded as missing evidence.
 */
export const REWARD_RISK_SCREEN_VERSION = "reward-risk-screen-v1";
export type RewardRiskReason = "OK" | "DISABLED" | "NO_TARGET" | "INVALID_RISK" | "BARRIER_TOO_CLOSE" | "TARGET_REWARD_RISK_TOO_LOW";
export interface RewardRiskScreen {
  version: typeof REWARD_RISK_SCREEN_VERSION; passed: boolean; reason: RewardRiskReason; minRewardRisk: number; riskPerUnit: number; targetRewardRisk: number | null;
  barrier: { level: number; distanceR: number; swingAt: string } | null; structuralRewardRisk: number | null;
}
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function screenRewardRisk(s: Pick<SetupSignal, "side" | "entry" | "stop" | "targets" | "riskPerUnit">, series: OhlcSeries, o: { minRewardRisk: number; lookbackBars: number; swingK: number }): RewardRiskScreen {
  const base = { version: REWARD_RISK_SCREEN_VERSION, minRewardRisk: o.minRewardRisk, riskPerUnit: s.riskPerUnit, barrier: null, structuralRewardRisk: null, targetRewardRisk: null } as const;
  if (!(o.minRewardRisk > 0)) return { ...base, passed: true, reason: "DISABLED" };
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0) || !Number.isFinite(risk)) return { ...base, passed: false, reason: "INVALID_RISK" };
  const ref = s.targets[1] ?? s.targets[0];
  if (ref === undefined || !Number.isFinite(ref)) return { ...base, passed: false, reason: "NO_TARGET" };
  const long = s.side === "BUY", reach = long ? ref - s.entry : s.entry - ref;
  if (!(reach > 0)) return { ...base, passed: false, reason: "NO_TARGET" }; // the reference target is not on the profit side
  const targetRR = reach / risk;
  const bars = series.bars.slice(-Math.max(o.lookbackBars, 2 * o.swingK + 1)), sw = swings(bars.map((b) => b.high), bars.map((b) => b.low), o.swingK);
  // the nearest OPPOSING swing level strictly beyond the entry on the profit side and short of the reference target
  const levels = (long ? sw.highs : sw.lows).map((x) => ({ level: x.v, at: bars[x.i]!.t })).filter((x) => (long ? x.level > s.entry && x.level < ref : x.level < s.entry && x.level > ref));
  const nearest = levels.sort((a, b) => (long ? a.level - b.level : b.level - a.level) || (a.at < b.at ? -1 : 1))[0];
  const barrier = nearest ? { level: nearest.level, distanceR: r2(Math.abs(nearest.level - s.entry) / risk), swingAt: nearest.at } : null;
  const structural = barrier ? barrier.distanceR : r2(targetRR);
  const out = { ...base, targetRewardRisk: r2(targetRR), barrier, structuralRewardRisk: structural };
  if (structural + 1e-9 < o.minRewardRisk) return { ...out, passed: false, reason: barrier ? "BARRIER_TOO_CLOSE" : "TARGET_REWARD_RISK_TOO_LOW" };
  return { ...out, passed: true, reason: "OK" };
}

export type CalendarGateStatus = "PROCEED" | "MARKET_CLOSED" | "EVENT_WINDOW" | "CALENDAR_UNAVAILABLE";
/** What a calendar source can say at an instant. `unknown` means it could not tell; it is never read as open or as clear. */
export interface ScanCalendarState { market: "OPEN" | "CLOSED" | "UNKNOWN"; minutesToHighImpactEvent: number | null }
export interface ScanCalendar { readonly name: string; stateAt(now: Date): Promise<ScanCalendarState> }
export interface CalendarGate { status: CalendarGateStatus; detail?: string }
export async function gateScan(now: Date, calendar: ScanCalendar | null | undefined, o: { eventBlockMinutes: number }): Promise<CalendarGate> {
  if (!calendar) return { status: "CALENDAR_UNAVAILABLE", detail: "no calendar source is configured" };
  let st: ScanCalendarState;
  try { st = await calendar.stateAt(now); } catch { return { status: "CALENDAR_UNAVAILABLE", detail: "the calendar source failed" }; }
  if (st.market === "CLOSED") return { status: "MARKET_CLOSED" };
  if (st.market === "UNKNOWN") return { status: "CALENDAR_UNAVAILABLE", detail: "the calendar could not say whether the market is open" };
  if (st.minutesToHighImpactEvent !== null && Number.isFinite(st.minutesToHighImpactEvent) && st.minutesToHighImpactEvent >= 0 && st.minutesToHighImpactEvent <= o.eventBlockMinutes) return { status: "EVENT_WINDOW", detail: `${Math.round(st.minutesToHighImpactEvent)} minutes` };
  return { status: "PROCEED" };
}
