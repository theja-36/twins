import type { KiteInstrument } from "./instruments";
import type { MappedCandles } from "./historical";

/**
 * Pure: turns already-fetched, already-mapped Kite candles into a `twins-historical-bars-v1` document, the file format the outcome evaluator's file provider loads. It makes no request and writes no file.
 * Only index (underlying) and option-premium series exist in that format; a future is refused rather than mislabelled. Candles carry only bar start times, so a possibly-open last bar is dropped here
 * (an evaluator must not read a still-forming bar as final). The consumer's own strict parser re-validates the document.
 */
export const BARS_DATASET_FORMAT = "twins-historical-bars-v1";
/** Longest gap that is NOT a data gap: a weekend plus a market holiday (Friday close to Tuesday open). */
export const ALLOWED_GAP_SECONDS = 4 * 86_400;

export class BarsDatasetError extends Error { constructor(readonly code: string) { super(code); this.name = "BarsDatasetError"; } }
export interface BarsInput { instrument: KiteInstrument; mapped: MappedCandles }

const marketOf = (exchange: string): string => (exchange === "BSE" || exchange === "BFO" ? "BSE" : "NSE");

export function buildBarsDataset(o: { providerId: string; datasetId: string; datasetVersion: string; inputs: readonly BarsInput[] }): Record<string, unknown> {
  if (o.inputs.length === 0) throw new BarsDatasetError("no_series");
  const series = o.inputs.map(({ instrument, mapped }) => {
    if (instrument.kind === "future") throw new BarsDatasetError("future_series_not_supported");
    const keep = mapped.lastBarMayBeOpen ? mapped.series.bars.length - 1 : mapped.series.bars.length;
    const bars = mapped.series.bars.slice(0, Math.max(0, keep)).map((b, i) => ({
      t: b.t, o: b.open, h: b.high, l: b.low, c: b.close,
      ...(b.volume !== null ? { v: b.volume } : {}),
      ...(mapped.openInterest?.[i] != null ? { oi: mapped.openInterest[i] } : {}),
    }));
    if (bars.length === 0) throw new BarsDatasetError("empty_series");
    const base = { symbol: instrument.underlying, market: marketOf(instrument.exchange), interval_seconds: mapped.series.intervalSeconds, allowed_gap_seconds: ALLOWED_GAP_SECONDS, bars };
    if (instrument.kind === "option") {
      if (instrument.strike === null || instrument.optionType === null || instrument.expiry === null) throw new BarsDatasetError("option_contract_incomplete");
      return { kind: "option_premium", ...base, strike: instrument.strike, option_type: instrument.optionType, expiry: instrument.expiry };
    }
    return { kind: "underlying_price", ...base };
  });
  return { format: BARS_DATASET_FORMAT, provider: o.providerId, dataset_id: o.datasetId, dataset_version: o.datasetVersion, series };
}
