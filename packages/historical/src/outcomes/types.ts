/**
 * Historical market-data model for outcome evaluation (Stage 4 / Task 2). Time-ordered OHLC bars (volume, open interest and implied volatility where available), grouped into SERIES
 * (an equity price series, an option PREMIUM series for one contract, or an UNDERLYING index series) inside versioned DATASETS. No live provider exists in this task: datasets come from
 * a deterministic in-memory provider (tests) or from pre-exported files.
 */
export interface Bar {
  /** Start of the bar. The bar covers [ts, ts + interval). */
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
}
export type SeriesKind = "equity_price" | "option_premium" | "underlying_price";
export interface SeriesKey {
  kind: SeriesKind;
  /** Equity symbol, or the underlying (NIFTY, ...) for option and underlying series. */
  symbol: string;
  market: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  /** YYYY-MM-DD, option series only. */
  expiry: string | null;
}
export interface Series {
  key: SeriesKey;
  intervalSeconds: number;
  /** The largest spacing between consecutive bar starts (and between a signal and the first bar) that is NOT a gap: overnight / weekend / holiday breaks the exporter declares as normal. */
  allowedGapSeconds: number;
  bars: Bar[];
  /** sha256 over the canonical bars of this series. */
  sha256: string;
}
export interface Dataset {
  providerId: string;
  datasetId: string;
  datasetVersion: string;
  /** sha256 of the exported file / canonical content. */
  contentSha256: string;
  series: Series[];
}
export interface DatasetRef { providerId: string; datasetId: string; datasetVersion: string; contentSha256: string }

export type SeriesQuery =
  | { kind: "equity_price"; symbol: string; market: string | null }
  | { kind: "option_premium"; underlying: string; market: string | null; strike: number; optionType: "CE" | "PE"; expiry: string };
export type SeriesMatch = { found: { series: Series; dataset: DatasetRef } } | { found: null; underlyingAvailable: boolean };

/** The provider seam. Implementations: `memoryProvider` (tests) and `fileProvider` (pre-exported files). No live provider is implemented. */
export interface HistoricalDataProvider {
  readonly id: string;
  datasets(): Dataset[];
  findSeries(q: SeriesQuery): SeriesMatch;
}
