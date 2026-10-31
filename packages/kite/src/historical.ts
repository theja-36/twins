import type { Candle, OhlcSeries } from "@twins/agents/src/agents/ohlcProviders";
import { ohlcProblem } from "@twins/agents/src/agents/ohlcProviders";
import type { KiteClient } from "./client";
import { KiteError } from "./errors";
import type { KiteInstrument } from "./instruments";
import type { Mapped } from "./marketData";
import { istDate, parseCandleTimestamp, toKiteParam } from "./timestamps";

export type KiteInterval = "minute" | "3minute" | "5minute" | "10minute" | "15minute" | "30minute" | "60minute" | "day";
export const INTERVAL_SECONDS: Record<KiteInterval, number> = { minute: 60, "3minute": 180, "5minute": 300, "10minute": 600, "15minute": 900, "30minute": 1800, "60minute": 3600, day: 86_400 };
/** Documented maximum span per request (days). Requests beyond it are refused before sending; split them. */
export const MAX_SPAN_DAYS: Record<KiteInterval, number> = { minute: 60, "3minute": 100, "5minute": 100, "10minute": 100, "15minute": 200, "30minute": 200, "60minute": 400, day: 2000 };

export interface CandleRequest { interval: KiteInterval; from: Date; to: Date }

export interface RawCandles { instrument: KiteInstrument; interval: KiteInterval; candles: unknown[]; fetchedAt: string; withOi: boolean }

/**
 * GET /instruments/historical/:token/:interval for ONE listed instrument. Only currently listed contracts (from the catalog) are accepted: an expired contract,
 * or a request for continuous data, is refused; expired-option history and continuous options are NOT supported. `oi=1` is requested for futures/options only.
 */
export async function getCandles(client: KiteClient, instrument: KiteInstrument, req: CandleRequest, now: () => Date = () => new Date()): Promise<RawCandles> {
  if (!(req.interval in INTERVAL_SECONDS)) throw new KiteError("INVALID_REQUEST");
  if (Number.isNaN(req.from.getTime()) || Number.isNaN(req.to.getTime()) || req.to <= req.from) throw new KiteError("INVALID_REQUEST");
  if ((req.to.getTime() - req.from.getTime()) / 86_400_000 > MAX_SPAN_DAYS[req.interval]) throw new KiteError("INVALID_REQUEST");
  if (instrument.expiry && instrument.expiry < istDate(now())) throw new KiteError("INVALID_REQUEST"); // expired contract
  const derivative = instrument.kind === "future" || instrument.kind === "option";
  const data = await client.getJson<{ candles?: unknown }>(`/instruments/historical/${instrument.token}/${req.interval}`, {
    from: toKiteParam(req.from), to: toKiteParam(req.to), continuous: 0, oi: derivative ? 1 : 0,
  });
  if (!data || typeof data !== "object" || !Array.isArray((data as { candles?: unknown }).candles)) throw new KiteError("MALFORMED_RESPONSE");
  return { instrument, interval: req.interval, candles: (data as { candles: unknown[] }).candles, fetchedAt: now().toISOString(), withOi: derivative };
}

export interface MappedCandles {
  series: OhlcSeries;
  /** Open interest per bar (same order), or null for instruments without it. Absent values are null, never 0. */
  openInterest: Array<number | null> | null;
  duplicatesRemoved: number;
  fetchedAt: string;
  /**
   * True when the last bar's period had not ended at fetch time, i.e. its OHLC/volume were still changing. Reported, never dropped or smoothed.
   * Says nothing about upstream freshness: Kite candles carry only bar start times.
   */
  lastBarMayBeOpen: boolean;
}

/**
 * Pure. Strict: ANY malformed candle fails the whole series (nothing is skipped, sorted or repaired). Candles must arrive oldest-first;
 * byte-identical repeats are removed and counted, conflicting repeats fail. Volume is null for indices (no traded volume), otherwise the reported number
 * (0 is a real zero). The result is checked with the existing `ohlcProblem` validator.
 */
export function mapCandles(raw: RawCandles): Mapped<MappedCandles> {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  const index = raw.instrument.kind === "index";
  const bars: Candle[] = [];
  const oi: Array<number | null> = [];
  let duplicatesRemoved = 0;
  let prev = -Infinity;
  let prevKey = "";
  for (const row of raw.candles) {
    if (!Array.isArray(row) || row.length < 6 || row.length > 7) return fail("bad_candle_shape");
    const ts = parseCandleTimestamp(row[0]);
    if (!ts) return fail("bad_candle_time");
    const [o, h, l, c, v] = [row[1], row[2], row[3], row[4], row[5]] as unknown[];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) return fail("bad_candle_price");
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return fail("bad_candle_volume");
    const extra = row.length === 7 ? row[6] : undefined;
    if (extra !== undefined && extra !== null && (typeof extra !== "number" || !Number.isFinite(extra) || extra < 0)) return fail("bad_candle_oi");
    const key = JSON.stringify(row);
    if (ts.instant === prev) {
      if (key === prevKey) { duplicatesRemoved += 1; continue; }
      return fail("conflicting_duplicate");
    }
    if (ts.instant < prev) return fail("candles_out_of_order");
    prev = ts.instant; prevKey = key;
    bars.push({ t: ts.iso, open: o as number, high: h as number, low: l as number, close: c as number, volume: index ? null : (v as number | null) });
    oi.push(raw.withOi && typeof extra === "number" ? extra : null);
  }
  const series: OhlcSeries = { symbol: raw.instrument.tradingSymbol, intervalSeconds: INTERVAL_SECONDS[raw.interval], bars };
  const problem = ohlcProblem(series); // the existing validator, unchanged (positive prices, high/low coherence, ordering)
  if (problem) return fail(`series_${problem}`);
  const last = bars[bars.length - 1];
  const lastBarMayBeOpen = !!last && Date.parse(last.t) + series.intervalSeconds * 1000 > Date.parse(raw.fetchedAt);
  return { ok: true, value: { series, openInterest: raw.withOi ? oi : null, duplicatesRemoved, fetchedAt: raw.fetchedAt, lastBarMayBeOpen } };
}
