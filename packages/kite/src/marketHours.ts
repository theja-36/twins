import { KiteError } from "./errors";

/**
 * Market-hours validation for the Kite feed (P0-3). Pure functions of an instant and a holiday list; nothing here reads a clock or a file.
 * The cash / index-derivatives session of NSE and BSE is 09:15-15:30 IST on weekdays that are not exchange holidays. The pre-open auction runs from 09:00. IST has no daylight saving, so a
 * fixed +05:30 offset is exact. Holidays are CONFIGURATION (`TWINS_KITE_HOLIDAYS`, comma-separated YYYY-MM-DD from the exchange circular): there is no built-in calendar, and an unlisted holiday
 * simply yields a window in which no ticks arrive (the freshness checks then treat the feed as stale), which is safe. The padding around the session is an UNAPPROVED operational default.
 */
export type MarketState = "weekend" | "holiday" | "before_open" | "pre_open" | "open" | "after_close";
export interface MarketHoursConfig { holidays: ReadonlySet<string>; preOpenStart: string; open: string; close: string; connectBeforeMinutes: number; disconnectAfterMinutes: number }
export const DEFAULT_MARKET_HOURS = { preOpenStart: "09:00", open: "09:15", close: "15:30", connectBeforeMinutes: 5, disconnectAfterMinutes: 10 } as const;

const IST_OFFSET_MS = 5.5 * 3600_000;
const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const minutes = (hhmm: string): number => { const m = HHMM.exec(hhmm); if (!m) throw new KiteError("CONFIG"); return Number(m[1]) * 60 + Number(m[2]); };

export const HOLIDAYS_ENV = "TWINS_KITE_HOLIDAYS";
export function loadMarketHours(env: Record<string, string | undefined> = process.env): MarketHoursConfig {
  const raw = env[HOLIDAYS_ENV];
  const holidays = new Set<string>();
  if (raw !== undefined && raw.trim() !== "") for (const d of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new KiteError("CONFIG");
    holidays.add(d);
  }
  const before = env["TWINS_KITE_CONNECT_BEFORE_MINUTES"], after = env["TWINS_KITE_DISCONNECT_AFTER_MINUTES"];
  const num = (v: string | undefined, d: number): number => { if (v === undefined || v === "") return d; if (!/^[0-9]{1,3}$/.test(v) || Number(v) > 120) throw new KiteError("CONFIG"); return Number(v); };
  return { holidays, ...DEFAULT_MARKET_HOURS, connectBeforeMinutes: num(before, DEFAULT_MARKET_HOURS.connectBeforeMinutes), disconnectAfterMinutes: num(after, DEFAULT_MARKET_HOURS.disconnectAfterMinutes) };
}

/** The IST calendar date (YYYY-MM-DD), weekday (0 = Sunday) and minutes since midnight of an instant. */
export function istParts(at: Date): { date: string; weekday: number; minute: number } {
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  return { date: t.toISOString().slice(0, 10), weekday: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function marketState(at: Date, cfg: MarketHoursConfig): MarketState {
  if (Number.isNaN(at.getTime())) throw new KiteError("CONFIG");
  const p = istParts(at);
  if (p.weekday === 0 || p.weekday === 6) return "weekend";
  if (cfg.holidays.has(p.date)) return "holiday";
  const pre = minutes(cfg.preOpenStart), open = minutes(cfg.open), close = minutes(cfg.close);
  if (p.minute < pre) return "before_open";
  if (p.minute < open) return "pre_open";
  if (p.minute < close) return "open";
  return "after_close";
}

/** True while the feed should be connected: from `connectBeforeMinutes` before the pre-open to `disconnectAfterMinutes` after the close, on a trading day. */
export function feedWindowOpen(at: Date, cfg: MarketHoursConfig): boolean {
  const p = istParts(at);
  const state = marketState(at, cfg);
  if (state === "weekend" || state === "holiday") return false;
  const from = minutes(cfg.preOpenStart) - cfg.connectBeforeMinutes, to = minutes(cfg.close) + cfg.disconnectAfterMinutes;
  return p.minute >= from && p.minute < to;
}

/** Milliseconds until the feed window next opens (0 if it is open now). Looks at most 14 days ahead (holidays + weekends), else null. */
export function msUntilFeedWindow(at: Date, cfg: MarketHoursConfig): number | null {
  if (feedWindowOpen(at, cfg)) return 0;
  const startMin = minutes(cfg.preOpenStart) - cfg.connectBeforeMinutes;
  for (let d = 0; d <= 14; d += 1) {
    const day = new Date(at.getTime() + d * 86_400_000);
    const p = istParts(day);
    const startInstant = new Date(Date.parse(`${p.date}T00:00:00Z`) - IST_OFFSET_MS + startMin * 60_000);
    if (startInstant.getTime() <= at.getTime()) continue;
    if (feedWindowOpen(startInstant, cfg)) return startInstant.getTime() - at.getTime();
  }
  return null;
}
