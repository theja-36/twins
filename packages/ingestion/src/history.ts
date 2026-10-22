import {
  ProviderError,
  type InstrumentRef,
  type MarketBarRequest,
  type MarketDataProvider,
  type NormalizedMarketBar,
} from "@twins/types";

/**
 * Connector-independent historical UNDERLYING (equity / index-level) bar retrieval. It wraps any MarketDataProvider,
 * so no vendor is named here. It validates an explicit request, checks what came back against that request, and reports
 * honestly - it never invents, fills, interpolates or reorders-away problems silently.
 *
 * Timestamp contract: every instant is a UTC `Date`. A bar's `observedAt` is the provider's bar timestamp exactly as
 * returned (for Yahoo, epoch seconds); this layer does NOT convert it to exchange-local time or derive a session date,
 * and does not verify that the provider stamps bar OPEN rather than CLOSE time (provider convention, unverified).
 * Request bounds are half-open: `from <= observedAt < to`.
 *
 * Provenance: `retrievedAt` is when this process obtained the data. Data retrieved now is KNOWN only from `retrievedAt`
 * onward (see `barsKnownAsOf`) even if its `observedAt` is years earlier - a later download is never presented as having
 * been received earlier.
 *
 * Option-premium history is out of scope: a series here is the UNDERLYING only. Index-level candles are never
 * option-premium candles, and expired-option premium data is not available through this layer.
 */
export const SUPPORTED_HISTORY_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d", "1w", "1mo"] as const;
export type HistoryTimeframe = (typeof SUPPORTED_HISTORY_TIMEFRAMES)[number];
export type UnderlyingSeriesKind = "equity" | "index_level";

export interface HistoryRequest {
  instrument: InstrumentRef;
  seriesKind: UnderlyingSeriesKind;
  timeframe: HistoryTimeframe;
  from: Date;
  to: Date;
}

export class HistoryRequestError extends Error {
  constructor(message: string) {
    super(`invalid history request: ${message}`);
    this.name = "HistoryRequestError";
  }
}

/** Symbols that look like an option contract (e.g. NIFTY24500CE, NIFTY-Nov2026-24500-CE, "... 24500 CALL"). Refused, never mapped to an underlying. */
const OPTION_SHAPED = /(\d{3,}\s*[-_ ]?(CE|PE|CALL|PUT)\b)|([-_ ](CE|PE)$)/i;

export function validateHistoryRequest(req: HistoryRequest): void {
  if (!req.instrument.symbol.trim() || !req.instrument.exchange.trim()) throw new HistoryRequestError("instrument symbol and exchange are required");
  if (req.seriesKind !== "equity" && req.seriesKind !== "index_level") throw new HistoryRequestError('seriesKind must be "equity" or "index_level"; option-premium history is not supported here');
  if (OPTION_SHAPED.test(req.instrument.symbol)) throw new HistoryRequestError("the symbol looks like an option contract; option-premium history is unsupported and index/equity candles are never substituted for it");
  if (!(SUPPORTED_HISTORY_TIMEFRAMES as readonly string[]).includes(req.timeframe)) throw new HistoryRequestError(`unsupported timeframe "${String(req.timeframe)}"`);
  if (!(req.from instanceof Date) || Number.isNaN(req.from.getTime()) || !(req.to instanceof Date) || Number.isNaN(req.to.getTime())) throw new HistoryRequestError("from and to must be valid instants");
  if (req.from.getTime() >= req.to.getTime()) throw new HistoryRequestError("from must be earlier than to");
}

export type HistoryStatus = "complete" | "partial" | "no_data" | "failed";

export interface HistoryReport {
  returned: number;
  kept: number;
  droppedOutOfBounds: number;
  droppedDuplicateTimestamp: number;
  droppedMissingSourceOrTimeframe: number;
  /** Kept bars missing at least one of open/high/low/close. Kept as-is, flagged, never filled. */
  incompleteBars: number;
  /** Kept bars with no volume (volume is not required for index levels). */
  barsWithoutVolume: number;
  returnedOutOfOrder: boolean;
  firstObservedAt?: string;
  lastObservedAt?: string;
  /** Calendar gap detection needs a trading calendar, which this system does not have; gaps are therefore NOT detected. */
  gapDetection: "not_performed_no_trading_calendar";
  notes: string[];
}

export interface HistoryResult {
  status: HistoryStatus;
  request: HistoryRequest;
  provider: string;
  retrievedAt: Date;
  seriesKind: UnderlyingSeriesKind;
  bars: NormalizedMarketBar[];
  report: HistoryReport;
  /** Present only when status is "failed". The provider's typed failure; never converted into an empty success. */
  failure?: { name: string; message: string };
  /** Option-premium history is never produced by this layer. */
  optionPremiumHistory: "not_supported";
}

/** Fetches, checks and reports one explicit underlying series. Provider failures become status "failed", never empty data. */
export async function retrieveHistory(provider: MarketDataProvider, req: HistoryRequest, now: () => Date = () => new Date()): Promise<HistoryResult> {
  validateHistoryRequest(req);
  const base = { request: req, provider: provider.providerName, seriesKind: req.seriesKind, optionPremiumHistory: "not_supported" as const };
  const empty = (): HistoryReport => ({ returned: 0, kept: 0, droppedOutOfBounds: 0, droppedDuplicateTimestamp: 0, droppedMissingSourceOrTimeframe: 0, incompleteBars: 0, barsWithoutVolume: 0, returnedOutOfOrder: false, gapDetection: "not_performed_no_trading_calendar", notes: [] });
  let raw: NormalizedMarketBar[];
  const mreq: MarketBarRequest = { instrument: req.instrument, timeframe: req.timeframe, from: req.from, to: req.to };
  try {
    raw = await provider.getHistoricalBars(mreq);
  } catch (err) {
    const retrievedAt = now();
    const e = err instanceof Error ? err : new Error(String(err));
    const known = err instanceof ProviderError;
    return { ...base, status: "failed", retrievedAt, bars: [], report: { ...empty(), notes: ["provider call failed; no data was substituted"] }, failure: { name: known ? e.name : "UnexpectedError", message: e.message } };
  }
  const retrievedAt = now();
  const report = empty();
  report.returned = raw.length;
  let prev = Number.NEGATIVE_INFINITY;
  const seen = new Set<number>();
  const kept: NormalizedMarketBar[] = [];
  for (const bar of raw) {
    const t = bar.observedAt instanceof Date ? bar.observedAt.getTime() : Number.NaN;
    if (Number.isNaN(t)) { report.droppedOutOfBounds += 1; report.notes.push("a bar with an invalid timestamp was dropped"); continue; }
    if (t < prev) report.returnedOutOfOrder = true;
    prev = Math.max(prev, t);
    if (!bar.timeframe || !bar.source) { report.droppedMissingSourceOrTimeframe += 1; continue; }
    if (t < req.from.getTime() || t >= req.to.getTime()) { report.droppedOutOfBounds += 1; continue; }
    if (seen.has(t)) { report.droppedDuplicateTimestamp += 1; continue; }
    seen.add(t);
    kept.push(bar);
  }
  const providerFrames = [...new Set(kept.map((b) => b.timeframe))].filter((f) => f !== req.timeframe);
  if (providerFrames.length > 0) report.notes.push(`bars carry the provider's own interval label (${providerFrames.join(", ")}) for requested ${req.timeframe}; labels are kept as returned, not rewritten`);
  kept.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  report.kept = kept.length;
  report.incompleteBars = kept.filter((b) => [b.open, b.high, b.low, b.close].some((v) => v === undefined)).length;
  report.barsWithoutVolume = kept.filter((b) => b.volume === undefined).length;
  const first = kept[0], last = kept[kept.length - 1];
  if (first && last) { report.firstObservedAt = first.observedAt.toISOString(); report.lastObservedAt = last.observedAt.toISOString(); }
  if (report.returnedOutOfOrder) report.notes.push("the provider returned bars out of order; they were sorted, not altered");
  if (req.seriesKind === "index_level") report.notes.push("index-level series: not tradable premium data; volume may be absent or not meaningful");
  report.notes.push("bar timestamps are the provider's, in UTC; whether they mark bar open or close is a provider convention that is not verified here");
  const degraded = report.droppedOutOfBounds + report.droppedDuplicateTimestamp + report.droppedMissingSourceOrTimeframe + report.incompleteBars > 0 || report.returnedOutOfOrder;
  const status: HistoryStatus = kept.length === 0 ? "no_data" : degraded ? "partial" : "complete";
  if (status === "no_data") report.notes.push("no usable bars in the requested range; this is reported as no data, not as zero-valued candles");
  return { ...base, status, retrievedAt, bars: kept, report };
}

/**
 * Replay view. Data obtained at `retrievedAt` was not known before it, regardless of how old its bars are. Returns
 * only bars observed at or before `asOf`, and none at all if `asOf` precedes `retrievedAt`.
 */
export function barsKnownAsOf(result: HistoryResult, asOf: Date): NormalizedMarketBar[] {
  if (asOf.getTime() < result.retrievedAt.getTime()) return [];
  return result.bars.filter((b) => b.observedAt.getTime() <= asOf.getTime());
}

/** Adapts a checked result back into the existing MarketDataProvider contract so the existing ingestMarketBars path (which stamps receivedAt at insert time) can persist it. */
export function providerFromHistoryResult(result: HistoryResult): MarketDataProvider {
  return {
    providerName: result.provider,
    getHistoricalBars: async () => result.bars,
    getLatestQuote: async () => null,
    getHealth: async () => ({ providerName: result.provider, providerType: "market", status: "healthy", checkedAt: result.retrievedAt }),
  };
}
