import { DEFAULT_EVAL_CONFIG, type EvalConfig, type EvalSignal } from "../../packages/historical/src/outcomes/evaluate";

/** SYNTHETIC, deterministic market data only: flat daily bars with explicit overrides. No real price history is used anywhere. */
export const T0 = new Date("2030-01-01T00:00:00Z");
export const day = (n: number, start: Date = T0): string => new Date(start.getTime() + n * 86_400_000).toISOString();
export type Ohlc = [number, number, number, number];

export interface BarSpec { start?: Date; days: number; from?: number; base: number; at?: Record<number, Ohlc>; skip?: number[] }
export function dailyBars(spec: BarSpec): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let d = spec.from ?? 1; d <= spec.days; d++) {
    if (spec.skip?.includes(d)) continue;
    const o = spec.at?.[d] ?? [spec.base, spec.base, spec.base, spec.base];
    out.push({ t: day(d, spec.start), o: o[0], h: o[1], l: o[2], c: o[3], v: 1000 });
  }
  return out;
}
export const equitySeries = (symbol: string, bars: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "equity_price", symbol, market: "NSE", interval_seconds: 86_400, allowed_gap_seconds: 4 * 86_400, bars, ...over });
export const optionSeries = (underlying: string, strike: number, optionType: "CE" | "PE", expiry: string, bars: Array<Record<string, unknown>>): Record<string, unknown> => ({ kind: "option_premium", symbol: underlying, market: "NSE", strike, option_type: optionType, expiry, interval_seconds: 86_400, allowed_gap_seconds: 4 * 86_400, bars });
export const underlyingSeries = (symbol: string, bars: Array<Record<string, unknown>>): Record<string, unknown> => ({ kind: "underlying_price", symbol, market: "NSE", interval_seconds: 86_400, allowed_gap_seconds: 4 * 86_400, bars });
export const datasetOf = (series: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> => ({ format: "twins-historical-bars-v1", provider: "synthetic", dataset_id: "synthetic-eod", dataset_version: "v1", series, ...over });

export const signal = (over: Partial<EvalSignal> = {}): EvalSignal => ({
  side: "buy", instrumentType: "equity", underlying: "ACME", market: "NSE", entry: { type: "at", price: 100 }, stopLoss: 95, targets: [105, 110, 115], optionType: null, strike: null, expiryDate: null, levelBasis: null, intent: null, timeValidity: null,
  signalTime: T0, ...over,
});
export const optionSignal = (over: Partial<EvalSignal> = {}): EvalSignal => signal({
  instrumentType: "option", underlying: "NIFTY", entry: { type: "at", price: 100 }, stopLoss: 80, targets: [120, 140, 160], optionType: "CE", strike: 24500, expiryDate: "2030-01-25", levelBasis: "premium", intent: "open", ...over,
});
export const config = (over: Partial<EvalConfig> = {}): EvalConfig => ({ ...DEFAULT_EVAL_CONFIG, evaluatedAt: new Date("2031-01-01T00:00:00Z"), ...over });
