/**
 * Yahoo Finance market-data adapter for Indian equities (spec section 11/43).
 *
 * Yahoo Finance is Tier B (professional/market-data provider, spec section 11)
 * and is the initial concrete MarketDataProvider implementation. NSE symbols
 * use the `.NS` suffix (e.g. RELIANCE.NS) and BSE use `.BO`.
 *
 * Key safety rules followed (spec section 2/45):
 * - Provider unavailability is surfaced as ProviderUnavailableError, never
 *   converted into an empty result (spec section 45).
 * - Malformed or missing fields in the response are surfaced as
 *   ProviderDataError, never silently coerced to zero/default values.
 * - Rate-limit responses (HTTP 429) surface as ProviderRateLimitError so the
 *   ingestion layer can back off correctly.
 * - No credential is required for Yahoo Finance public chart API; the adapter
 *   never stores credentials.
 */

import { withRetry } from "@twins/shared";
import {
  ProviderDataError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type InstrumentRef,
  type MarketBarRequest,
  type MarketDataProvider,
  type NormalizedMarketBar,
  type ProviderHealthSnapshot,
} from "@twins/types";

export const YAHOO_PROVIDER_NAME = "yahoo-finance";

/**
 * Converts a canonical InstrumentRef to the Yahoo Finance ticker suffix
 * format. NSE → `.NS`, BSE → `.BO`. Unsupported exchanges surface as a
 * ProviderDataError at fetch time rather than at construction time, so the
 * registry can still register the adapter without knowing every symbol it
 * will be asked for.
 */
function toYahooSymbol(instrument: InstrumentRef): string {
  const exchangeUpper = instrument.exchange.toUpperCase();
  if (exchangeUpper === "NSE") return `${instrument.symbol}.NS`;
  if (exchangeUpper === "BSE") return `${instrument.symbol}.BO`;
  // INDEX handles NIFTY 50 etc. when the caller passes exchange=INDEX and
  // a Yahoo-native ticker like ^NSEI directly.
  if (exchangeUpper === "INDEX") return instrument.symbol;
  throw new ProviderDataError(
    YAHOO_PROVIDER_NAME,
    `Unsupported exchange for Yahoo Finance adapter: "${instrument.exchange}". ` +
      `Use "NSE" (.NS suffix), "BSE" (.BO suffix), or "INDEX" (raw Yahoo ticker).`,
  );
}

/** Shape returned by Yahoo Finance chart v8 endpoint (only the fields we use). */
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketTime?: number;
        regularMarketPrice?: number;
        regularMarketVolume?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: {
      code?: string;
      description?: string;
    };
  };
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof ProviderUnavailableError ||
    error instanceof ProviderRateLimitError
  );
}

async function fetchYahooChart(
  yahooSymbol: string,
  from: Date,
  to: Date,
  interval: string,
  /** Injectable for tests — defaults to global fetch (Node 20+). */
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<NormalizedMarketBar[]> {
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000);

  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
  );
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", interval);
  url.searchParams.set("events", "");

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      headers: {
        // Identify the agent politely; Yahoo rejects empty User-Agents.
        "User-Agent": "TWINS/1.0 (market data ingestion; contact: ops@twins.internal)",
        Accept: "application/json",
      },
    });
  } catch (cause) {
    throw new ProviderUnavailableError(
      YAHOO_PROVIDER_NAME,
      `Network error fetching ${yahooSymbol}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : undefined;
    throw new ProviderRateLimitError(YAHOO_PROVIDER_NAME, retryAfterMs);
  }

  if (!response.ok) {
    throw new ProviderUnavailableError(
      YAHOO_PROVIDER_NAME,
      `Yahoo Finance returned HTTP ${response.status} for ${yahooSymbol}`,
    );
  }

  let data: YahooChartResponse;
  try {
    data = (await response.json()) as YahooChartResponse;
  } catch (cause) {
    throw new ProviderDataError(
      YAHOO_PROVIDER_NAME,
      `Non-JSON response from Yahoo Finance for ${yahooSymbol}`,
      cause,
    );
  }

  if (data.chart?.error) {
    throw new ProviderDataError(
      YAHOO_PROVIDER_NAME,
      `Yahoo Finance chart error for ${yahooSymbol}: ` +
        `${data.chart.error.code ?? "unknown"} – ${data.chart.error.description ?? ""}`,
    );
  }

  const result = data.chart?.result?.[0];
  if (!result) {
    throw new ProviderDataError(
      YAHOO_PROVIDER_NAME,
      `Empty chart result for ${yahooSymbol}`,
    );
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];

  // An empty timestamp array is a valid "no data in range" response — return
  // empty rather than throwing, so the ingestion layer handles it as 0 bars.
  if (timestamps.length === 0) return [];

  if (!quote) {
    throw new ProviderDataError(
      YAHOO_PROVIDER_NAME,
      `Chart result has timestamps but no quote indicators for ${yahooSymbol}`,
    );
  }

  return timestamps.map((ts, i): NormalizedMarketBar => {
    const observedAt = new Date(ts * 1000);
    // exactOptionalPropertyTypes: only include a key when its value is a real
    // number. Yahoo returns null for missing candle data — never coerce to 0
    // (spec section 21/45). We omit the key entirely so the type narrows
    // correctly at the call-site without an explicit `undefined`.
    const open   = quote.open?.[i]   != null ? quote.open[i]   : undefined;
    const high   = quote.high?.[i]   != null ? quote.high[i]   : undefined;
    const low    = quote.low?.[i]    != null ? quote.low[i]    : undefined;
    const close  = quote.close?.[i]  != null ? quote.close[i]  : undefined;
    const volume = quote.volume?.[i] != null ? quote.volume[i] : undefined;

    const bar: NormalizedMarketBar = {
      instrument: { symbol: yahooSymbol, exchange: "YAHOO" },
      source: YAHOO_PROVIDER_NAME,
      timeframe: interval,
      observedAt,
      rawPayload: { ts, o: open, h: high, l: low, c: close, v: volume },
    };
    if (open   !== undefined) bar.open   = open;
    if (high   !== undefined) bar.high   = high;
    if (low    !== undefined) bar.low    = low;
    if (close  !== undefined) bar.close  = close;
    if (volume !== undefined) bar.volume = volume;
    return bar;
  });
}

export interface YahooFinanceAdapterOptions {
  /**
   * Maps the spec's "1d" / "1w" / "1m" / "1h" vocabulary to Yahoo Finance
   * interval strings. Defaults cover daily ingestion; override for finer
   * resolution when a concrete ingestion job requests it.
   */
  intervalMap?: Record<string, string>;
  /** Injected for tests; defaults to globalThis.fetch (Node 20+). */
  fetchFn?: typeof fetch;
}

const DEFAULT_INTERVAL_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "60m",
  "1d": "1d",
  "1w": "1wk",
  "1mo": "1mo",
};

/**
 * Yahoo Finance implementation of MarketDataProvider (spec section 43).
 * Core code never imports this class directly; it always goes through the
 * `marketDataProviders` registry.
 */
export class YahooFinanceAdapter implements MarketDataProvider {
  readonly providerName = YAHOO_PROVIDER_NAME;

  private readonly intervalMap: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(options: YahooFinanceAdapterOptions = {}) {
    this.intervalMap = { ...DEFAULT_INTERVAL_MAP, ...options.intervalMap };
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private resolveInterval(timeframe: string): string {
    const mapped = this.intervalMap[timeframe];
    if (!mapped) {
      throw new ProviderDataError(
        YAHOO_PROVIDER_NAME,
        `Unsupported timeframe "${timeframe}" for Yahoo Finance adapter. ` +
          `Supported: ${Object.keys(this.intervalMap).join(", ")}`,
      );
    }
    return mapped;
  }

  async getHistoricalBars(request: MarketBarRequest): Promise<NormalizedMarketBar[]> {
    const yahooSymbol = toYahooSymbol(request.instrument);
    const interval = this.resolveInterval(request.timeframe);

    const { result } = await withRetry(
      () => fetchYahooChart(yahooSymbol, request.from, request.to, interval, this.fetchFn),
      { maxAttempts: 3, baseDelayMs: 500, isRetryable: isTransient },
    );

    // Re-stamp the instrument ref back to the canonical form the caller used,
    // not the Yahoo-suffixed symbol, so downstream storage is consistent.
    return result.map((bar) => ({ ...bar, instrument: request.instrument }));
  }

  async getLatestQuote(instrument: InstrumentRef): Promise<NormalizedMarketBar | null> {
    const yahooSymbol = toYahooSymbol(instrument);
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const { result: bars } = await withRetry(
      () => fetchYahooChart(yahooSymbol, oneDayAgo, now, "1d", this.fetchFn),
      { maxAttempts: 3, baseDelayMs: 500, isRetryable: isTransient },
    );

    if (bars.length === 0) return null;
    const latest = bars[bars.length - 1];
    if (!latest) return null;
    return { ...latest, instrument };
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    const checkedAt = new Date();
    const startMs = Date.now();

    try {
      // Probe with a tiny 1d window on a known-liquid NSE symbol; we only
      // care whether the endpoint responds, not about the data content.
      await withRetry(
        () =>
          fetchYahooChart(
            "RELIANCE.NS",
            new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
            new Date(),
            "1d",
            this.fetchFn,
          ),
        { maxAttempts: 1, isRetryable: () => false },
      );

      return {
        providerName: YAHOO_PROVIDER_NAME,
        providerType: "market",
        status: "healthy",
        latencyMs: Date.now() - startMs,
        lastSuccessAt: checkedAt,
        checkedAt,
      };
    } catch (err) {
      return {
        providerName: YAHOO_PROVIDER_NAME,
        providerType: "market",
        status: err instanceof ProviderRateLimitError ? "degraded" : "down",
        latencyMs: Date.now() - startMs,
        lastErrorAt: checkedAt,
        lastErrorMessage: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }
}
