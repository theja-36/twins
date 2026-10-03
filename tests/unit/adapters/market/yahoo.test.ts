/**
 * Unit tests for the Yahoo Finance market-data adapter.
 * No real network calls — all HTTP is mocked via the injectable fetchFn.
 */

import { describe, expect, it, vi } from "vitest";
import {
  YahooFinanceAdapter,
  YAHOO_PROVIDER_NAME,
} from "../../../../adapters/market/src/yahoo";
import {
  ProviderDataError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "../../../../packages/types/src/providers/common";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal valid Yahoo chart v8 JSON for one daily bar. */
function makeYahooResponse(symbol = "RELIANCE.NS", overrides: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { symbol, regularMarketTime: 1700000000, regularMarketPrice: 2800 },
          timestamp: [1699920000],
          indicators: {
            quote: [
              {
                open: [2750],
                high: [2850],
                low: [2700],
                close: [2800],
                volume: [1000000],
              },
            ],
          },
          ...overrides,
        },
      ],
      error: null,
    },
  };
}

function makeFetch(body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as Response);
}

const BASE_REQUEST = {
  instrument: { symbol: "RELIANCE", exchange: "NSE" },
  timeframe: "1d",
  from: new Date("2023-11-01"),
  to: new Date("2023-11-15"),
};

// ─── Symbol mapping ──────────────────────────────────────────────────────────

describe("YahooFinanceAdapter – symbol mapping", () => {
  it("maps NSE exchange to .NS suffix", async () => {
    const fetchFn = makeFetch(makeYahooResponse("RELIANCE.NS"));
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await adapter.getHistoricalBars({ ...BASE_REQUEST, instrument: { symbol: "RELIANCE", exchange: "NSE" } });
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("RELIANCE.NS");
  });

  it("maps BSE exchange to .BO suffix", async () => {
    const fetchFn = makeFetch(makeYahooResponse("RELIANCE.BO"));
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await adapter.getHistoricalBars({ ...BASE_REQUEST, instrument: { symbol: "RELIANCE", exchange: "BSE" } });
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("RELIANCE.BO");
  });

  it("passes INDEX symbols through unmodified", async () => {
    const fetchFn = makeFetch(makeYahooResponse("^NSEI"));
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await adapter.getHistoricalBars({ ...BASE_REQUEST, instrument: { symbol: "^NSEI", exchange: "INDEX" } });
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("%5ENSEI"); // ^ → %5E in URL
  });

  it("throws ProviderDataError for unsupported exchange", async () => {
    const adapter = new YahooFinanceAdapter();
    await expect(
      adapter.getHistoricalBars({ ...BASE_REQUEST, instrument: { symbol: "X", exchange: "NASDAQ" } }),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });
});

// ─── Successful responses ───────────────────────────────────────────────────

describe("YahooFinanceAdapter – successful responses", () => {
  it("returns normalized bars with the original instrument ref (not Yahoo symbol)", async () => {
    const adapter = new YahooFinanceAdapter({ fetchFn: makeFetch(makeYahooResponse()) });
    const bars = await adapter.getHistoricalBars(BASE_REQUEST);
    expect(bars).toHaveLength(1);
    // Instrument ref should be the canonical one, not the Yahoo-suffixed one.
    expect(bars[0]?.instrument.symbol).toBe("RELIANCE");
    expect(bars[0]?.instrument.exchange).toBe("NSE");
    expect(bars[0]?.source).toBe(YAHOO_PROVIDER_NAME);
    expect(bars[0]?.close).toBe(2800);
    expect(bars[0]?.volume).toBe(1000000);
    expect(bars[0]?.timeframe).toBe("1d");
  });

  it("returns empty array when Yahoo returns no timestamps", async () => {
    const response = { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [] } }], error: null } };
    const adapter = new YahooFinanceAdapter({ fetchFn: makeFetch(response) });
    const bars = await adapter.getHistoricalBars(BASE_REQUEST);
    expect(bars).toHaveLength(0);
  });

  it("maps null quote values to undefined (never coerced to 0)", async () => {
    const response = makeYahooResponse("RELIANCE.NS");
    // Yahoo sometimes returns null for missing candle data.
    (response.chart.result[0]!.indicators.quote[0]! as Record<string, unknown>)["open"] = [null];
    const adapter = new YahooFinanceAdapter({ fetchFn: makeFetch(response) });
    const bars = await adapter.getHistoricalBars(BASE_REQUEST);
    expect(bars[0]?.open).toBeUndefined();
  });

  it("getLatestQuote returns null for empty result", async () => {
    const response = { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [] } }], error: null } };
    const adapter = new YahooFinanceAdapter({ fetchFn: makeFetch(response) });
    const quote = await adapter.getLatestQuote({ symbol: "RELIANCE", exchange: "NSE" });
    expect(quote).toBeNull();
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe("YahooFinanceAdapter – error handling", () => {
  it("throws ProviderRateLimitError on HTTP 429", async () => {
    const fetchFn = makeFetch({}, 429, { "Retry-After": "60" });
    const adapter = new YahooFinanceAdapter({ fetchFn, intervalMap: { "1d": "1d" } });
    await expect(adapter.getHistoricalBars(BASE_REQUEST)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it("includes retryAfterMs from Retry-After header", async () => {
    const fetchFn = makeFetch({}, 429, { "Retry-After": "30" });
    const adapter = new YahooFinanceAdapter({ fetchFn });
    const err = await adapter.getHistoricalBars(BASE_REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(30000);
  });

  it("throws ProviderUnavailableError on HTTP 500", async () => {
    const fetchFn = makeFetch({}, 500);
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await expect(adapter.getHistoricalBars(BASE_REQUEST)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("throws ProviderUnavailableError on network error", async () => {
    const fetchFn: typeof fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await expect(adapter.getHistoricalBars(BASE_REQUEST)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("throws ProviderDataError when chart.error is set", async () => {
    const response = { chart: { result: null, error: { code: "Not Found", description: "no data" } } };
    const fetchFn = makeFetch(response);
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await expect(adapter.getHistoricalBars(BASE_REQUEST)).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("throws ProviderDataError on non-JSON response", async () => {
    const fetchFn: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new SyntaxError("Unexpected token"); },
    } as Response);
    const adapter = new YahooFinanceAdapter({ fetchFn });
    await expect(adapter.getHistoricalBars(BASE_REQUEST)).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("throws ProviderDataError for unsupported timeframe", async () => {
    const adapter = new YahooFinanceAdapter();
    await expect(
      adapter.getHistoricalBars({ ...BASE_REQUEST, timeframe: "tick" }),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });
});

// ─── Health check ────────────────────────────────────────────────────────────

describe("YahooFinanceAdapter – getHealth", () => {
  it("returns healthy status on success", async () => {
    const adapter = new YahooFinanceAdapter({ fetchFn: makeFetch(makeYahooResponse()) });
    const health = await adapter.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.providerType).toBe("market");
    expect(health.providerName).toBe(YAHOO_PROVIDER_NAME);
  });

  it("returns degraded status on rate limit", async () => {
    const fetchFn = makeFetch({}, 429);
    const adapter = new YahooFinanceAdapter({ fetchFn });
    const health = await adapter.getHealth();
    expect(health.status).toBe("degraded");
  });

  it("returns down status on network error", async () => {
    const fetchFn: typeof fetch = vi.fn().mockRejectedValue(new Error("timeout"));
    const adapter = new YahooFinanceAdapter({ fetchFn });
    const health = await adapter.getHealth();
    expect(health.status).toBe("down");
    expect(health.lastErrorMessage).toContain("timeout");
  });
});
