import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkFile, hashFile, InputError } from "../readers";
import type { Bar, Dataset, DatasetRef, HistoricalDataProvider, Series, SeriesKey, SeriesMatch, SeriesQuery } from "./types";

/**
 * Pre-exported historical data (Stage 4 / Task 2), format `twins-historical-bars-v1` (JSON):
 *   { "format": "twins-historical-bars-v1", "provider": "<exporter id>", "dataset_id": "<id>", "dataset_version": "<version>",
 *     "series": [ { "kind": "equity_price" | "option_premium" | "underlying_price", "symbol": "RELIANCE", "market": "NSE",
 *                   "strike": 24500, "option_type": "CE", "expiry": "2031-10-29"   (option_premium only, all three required),
 *                   "interval_seconds": 60, "allowed_gap_seconds": 64800 (optional, default 1.5 x interval),
 *                   "bars": [ { "t": "<ISO with offset>", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100, "oi": 500, "iv": 0.18 } ] } ] }
 * `v`, `oi`, `iv` are optional. Malformed data is REJECTED at load (the whole dataset): non-finite or negative numbers, high < low, open / close outside [low, high], timestamps without an
 * offset, unsorted or duplicate timestamps, an option series without its contract fields. Nothing is repaired or interpolated.
 */
export const DATASET_FORMAT = "twins-historical-bars-v1";
export class DatasetError extends Error {
  constructor(readonly code: string, readonly where?: string) {
    super(code);
    this.name = "DatasetError";
  }
}
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const SYMBOL = /^[A-Za-z0-9&._-]{1,30}$/;
const MARKET = /^[A-Z0-9]{2,20}$/;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BARS_PER_SERIES = 2_000_000;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const canonicalBars = (bars: Bar[]): string => JSON.stringify(bars.map((b) => [b.ts.toISOString(), b.open, b.high, b.low, b.close, b.volume, b.openInterest, b.impliedVolatility]));

function parseSeries(raw: unknown, index: number): Series {
  const w = `series[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DatasetError("series_not_an_object", w);
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (kind !== "equity_price" && kind !== "option_premium" && kind !== "underlying_price") throw new DatasetError("series_kind_invalid", w);
  if (typeof r["symbol"] !== "string" || !SYMBOL.test(r["symbol"])) throw new DatasetError("series_symbol_invalid", w);
  const market = r["market"] === undefined || r["market"] === null ? null : r["market"];
  if (market !== null && (typeof market !== "string" || !MARKET.test(market))) throw new DatasetError("series_market_invalid", w);
  let strike: number | null = null, optionType: "CE" | "PE" | null = null, expiry: string | null = null;
  if (kind === "option_premium") {
    strike = num(r["strike"]) && (r["strike"] as number) > 0 ? (r["strike"] as number) : null;
    optionType = r["option_type"] === "CE" || r["option_type"] === "PE" ? r["option_type"] : null;
    expiry = typeof r["expiry"] === "string" && EXPIRY.test(r["expiry"]) ? r["expiry"] : null;
    if (strike === null || optionType === null || expiry === null) throw new DatasetError("option_series_contract_incomplete", w);
  } else if (r["strike"] !== undefined || r["option_type"] !== undefined || r["expiry"] !== undefined) throw new DatasetError("contract_fields_on_non_option_series", w);
  const interval = r["interval_seconds"];
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 7 * 86_400) throw new DatasetError("interval_invalid", w);
  const intervalSeconds = interval as number;
  const allowed = r["allowed_gap_seconds"] === undefined ? Math.ceil(intervalSeconds * 1.5) : r["allowed_gap_seconds"];
  if (!Number.isInteger(allowed) || (allowed as number) < intervalSeconds || (allowed as number) > 30 * 86_400) throw new DatasetError("allowed_gap_invalid", w);
  if (!Array.isArray(r["bars"])) throw new DatasetError("bars_not_an_array", w);
  if (r["bars"].length > MAX_BARS_PER_SERIES) throw new DatasetError("too_many_bars", w);
  const lowerBound = kind === "option_premium" ? 0 : Number.MIN_VALUE; // an option premium can reach 0; a price cannot
  const bars: Bar[] = [];
  let prev = -Infinity;
  for (let i = 0; i < r["bars"].length; i++) {
    const b = r["bars"][i] as Record<string, unknown> | null;
    const bw = `${w}.bars[${i}]`;
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new DatasetError("bar_not_an_object", bw);
    if (typeof b["t"] !== "string" || !ISO.test(b["t"])) throw new DatasetError("bar_timestamp_invalid", bw);
    const ms = Date.parse(b["t"].replace(" ", "T"));
    if (Number.isNaN(ms)) throw new DatasetError("bar_timestamp_invalid", bw);
    if (ms <= prev) throw new DatasetError("bar_timestamps_not_increasing", bw);
    prev = ms;
    const [o, h, l, c] = [b["o"], b["h"], b["l"], b["c"]];
    if (!num(o) || !num(h) || !num(l) || !num(c) || o < lowerBound || h < lowerBound || l < lowerBound || c < lowerBound) throw new DatasetError("bar_price_invalid", bw);
    if (h < l || h < o || h < c || l > o || l > c) throw new DatasetError("bar_ohlc_inconsistent", bw);
    const opt = (v: unknown, code: string): number | null => { if (v === undefined || v === null) return null; if (!num(v) || v < 0) throw new DatasetError(code, bw); return v; };
    bars.push({ ts: new Date(ms), open: o, high: h, low: l, close: c, volume: opt(b["v"], "bar_volume_invalid"), openInterest: opt(b["oi"], "bar_open_interest_invalid"), impliedVolatility: opt(b["iv"], "bar_implied_volatility_invalid") });
  }
  return { key: { kind, symbol: (r["symbol"] as string).toUpperCase(), market: market as string | null, strike, optionType, expiry } satisfies SeriesKey, intervalSeconds, allowedGapSeconds: allowed as number, bars, sha256: sha(canonicalBars(bars)) };
}

/** Validates a parsed dataset object (throws DatasetError). `contentSha256` is the hash of the file, or of the canonical JSON for an in-memory dataset. */
export function buildDataset(raw: unknown, contentSha256: string): Dataset {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DatasetError("dataset_not_an_object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== DATASET_FORMAT) throw new DatasetError("dataset_format_unsupported");
  for (const k of ["provider", "dataset_id", "dataset_version"] as const) if (typeof r[k] !== "string" || !ID.test(r[k] as string)) throw new DatasetError(`dataset_${k}_invalid`);
  if (!Array.isArray(r["series"]) || r["series"].length === 0) throw new DatasetError("dataset_series_missing");
  const series = r["series"].map(parseSeries);
  const seen = new Set<string>();
  for (const s of series) {
    const k = JSON.stringify(s.key);
    if (seen.has(k)) throw new DatasetError("duplicate_series");
    seen.add(k);
  }
  return { providerId: r["provider"] as string, datasetId: r["dataset_id"] as string, datasetVersion: r["dataset_version"] as string, contentSha256, series };
}

export const datasetRef = (d: Dataset): DatasetRef => ({ providerId: d.providerId, datasetId: d.datasetId, datasetVersion: d.datasetVersion, contentSha256: d.contentSha256 });

function matches(s: Series, q: SeriesQuery): boolean {
  const k = s.key;
  const marketOk = (qm: string | null): boolean => qm === null || k.market === null || qm === k.market;
  if (q.kind === "equity_price") return k.kind === "equity_price" && k.symbol === q.symbol.toUpperCase() && marketOk(q.market);
  return k.kind === "option_premium" && k.symbol === q.underlying.toUpperCase() && k.strike === q.strike && k.optionType === q.optionType && k.expiry === q.expiry && marketOk(q.market);
}

function providerOf(id: string, datasets: Dataset[]): HistoricalDataProvider {
  return {
    id,
    datasets: () => datasets,
    findSeries(q: SeriesQuery): SeriesMatch {
      for (const d of datasets) for (const s of d.series) if (matches(s, q)) return { found: { series: s, dataset: datasetRef(d) } };
      const underlyingAvailable = q.kind === "option_premium" && datasets.some((d) => d.series.some((s) => s.key.kind === "underlying_price" && s.key.symbol === q.underlying.toUpperCase()));
      return { found: null, underlyingAvailable };
    },
  };
}

/** Deterministic in-memory provider (tests): the same object shape as the file contract, validated the same way. */
export function memoryProvider(datasetObjects: unknown[], id = "memory"): HistoricalDataProvider {
  return providerOf(id, datasetObjects.map((o) => buildDataset(o, sha(JSON.stringify(o)))));
}

/** File provider: one or more pre-exported dataset files (`.json`). The files are hashed; credential / session-like names, symlinks, binary and oversized files are refused. */
export async function fileProvider(paths: string[], id = "file"): Promise<HistoricalDataProvider> {
  if (paths.length === 0) throw new DatasetError("no_dataset_files");
  const datasets: Dataset[] = [];
  for (const p of paths) {
    let info;
    try { info = checkFile(p); } catch (e) { throw new DatasetError(e instanceof InputError ? e.code : "dataset_file_unreadable", basename(p)); }
    if (info.format !== "json") throw new DatasetError("dataset_file_must_be_json", basename(p));
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { throw new DatasetError("dataset_json_malformed", basename(p)); }
    datasets.push(buildDataset(raw, await hashFile(p)));
  }
  return providerOf(id, datasets);
}
