/**
 * TWINS scheduler — cron-driven market data ingestion (spec section 46/59).
 *
 * Periodically enqueues `market_bars` jobs for a configurable watchlist of
 * NSE/BSE symbols so the worker process keeps market context fresh. The
 * worker (services/worker) consumes these jobs and calls the Yahoo Finance
 * adapter.
 *
 * Configuration (all environment variables, no hard-coded values):
 *   MARKET_WATCHLIST          — comma-separated "SYMBOL:EXCHANGE" pairs
 *                               e.g. "RELIANCE:NSE,INFY:NSE,^NSEI:INDEX"
 *                               Defaults to the four most-traded NSE stocks
 *                               plus the NIFTY 50 index for development.
 *   MARKET_CRON_EXPRESSION    — standard 5-field cron (default: every day at
 *                               9:30 IST = 04:00 UTC "30 4 * * 1-5")
 *   MARKET_LOOKBACK_DAYS      — how many days of history to request each run
 *                               (default: 7, keeps context windows fresh
 *                               without redundant backfills)
 *   MARKET_DATA_PROVIDER      — provider name registered in the worker's
 *                               marketDataProviders registry (default: "yahoo-finance")
 *
 * Redis is used only as ephemeral queue transport (spec section 47);
 * authoritative state lives in PostgreSQL.
 */

import cron from "node-cron";
import { Queue } from "bullmq";
import { loadConfig } from "@twins/config";
import { YAHOO_PROVIDER_NAME } from "@twins/adapter-market";

const config = loadConfig();

if (config.liveTradingEnabled) {
  console.error("[scheduler] FATAL: LIVE_TRADING=true is not permitted in the scheduler process.");
  process.exit(1);
}

console.log(
  `[scheduler] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
);

// ─── Watchlist parsing ──────────────────────────────────────────────────────

interface WatchlistEntry {
  symbol: string;
  exchange: string;
}

const DEFAULT_WATCHLIST = "RELIANCE:NSE,INFY:NSE,TCS:NSE,HDFCBANK:NSE,^NSEI:INDEX";

function parseWatchlist(raw: string | undefined): WatchlistEntry[] {
  const source = raw ?? DEFAULT_WATCHLIST;
  return source
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx === -1) {
        throw new Error(
          `MARKET_WATCHLIST entry "${entry}" is malformed. Expected "SYMBOL:EXCHANGE" e.g. "RELIANCE:NSE".`,
        );
      }
      return {
        symbol: entry.slice(0, colonIdx),
        exchange: entry.slice(colonIdx + 1),
      };
    });
}

const watchlist = parseWatchlist(process.env["MARKET_WATCHLIST"]);
const lookbackDays = Number(process.env["MARKET_LOOKBACK_DAYS"] ?? "7");
const providerName = process.env["MARKET_DATA_PROVIDER"] ?? YAHOO_PROVIDER_NAME;
const cronExpression = process.env["MARKET_CRON_EXPRESSION"] ?? "0 4 * * 1-5";
const instrumentType = process.env["MARKET_INSTRUMENT_TYPE"] ?? "equity";

if (!cron.validate(cronExpression)) {
  throw new Error(`MARKET_CRON_EXPRESSION "${cronExpression}" is not a valid cron expression.`);
}

console.log(
  `[scheduler] watchlist: ${watchlist.map((w) => `${w.symbol}:${w.exchange}`).join(", ")}`,
);
console.log(`[scheduler] schedule: "${cronExpression}" (provider: ${providerName}, lookback: ${lookbackDays}d)`);

// ─── Queue ──────────────────────────────────────────────────────────────────

const marketQueue = new Queue("market_queue", {
  connection: { url: config.redisUrl },
});

// ─── Enqueue helpers ────────────────────────────────────────────────────────

async function enqueueMarketBarsForWatchlist(): Promise<void> {
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  console.log(
    `[scheduler] enqueuing market_bars for ${watchlist.length} symbols (from=${from.toISOString()})`,
  );

  for (const entry of watchlist) {
    const jobId = `market-${entry.exchange}-${entry.symbol}-${now.toISOString().slice(0, 10)}`;
    await marketQueue.add(
      "market_bars",
      {
        jobType: "market_bars",
        providerName,
        market: {
          request: {
            instrument: { symbol: entry.symbol, exchange: entry.exchange },
            timeframe: "1d",
            from: from.toISOString(),
            to: now.toISOString(),
          },
          instrumentType,
          maxStalenessMs: 24 * 60 * 60 * 1000,
        },
      },
      {
        // Deduplicate: one fetch per symbol per calendar day.
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    );
    console.log(`[scheduler] enqueued market_bars job jobId=${jobId}`);
  }
}

// ─── Cron schedule ──────────────────────────────────────────────────────────

cron.schedule(cronExpression, () => {
  void enqueueMarketBarsForWatchlist().catch((err: unknown) => {
    console.error(
      `[scheduler] failed to enqueue market_bars jobs: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[scheduler] received ${signal}, shutting down gracefully`);
  await marketQueue.close();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

console.log(`[scheduler] running. Next tick at cron: "${cronExpression}"`);
