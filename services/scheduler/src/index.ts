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
import { Redis } from "ioredis";
import { enforceLiveTradingGuard, loadConfig } from "@twins/config";
import { YAHOO_PROVIDER_NAME } from "@twins/adapter-market";
import { configureRuntimeState, createPooledStateSource } from "@twins/runtime-state";
import { createBoundedDb } from "@twins/database";
import { alerterFromEnv } from "@twins/alerting";
import { createStructuredLogger } from "@twins/shared";
import { breakerAlert, evaluateCircuitBreakers, expireStaleRiskDecisions, loadBreakerConfig, loadExpiryConfig, loadSizingConfig } from "@twins/risk";
import { loadOpportunityConfig } from "@twins/opportunity";
import { runScheduledJob } from "./scheduledJob.js";

enforceLiveTradingGuard("scheduler");
const config = loadConfig();

console.log(
  `[scheduler] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
);

// ─── Runtime safety state (Stage 1 / Task 2) ───────────────────────────────
// The scheduler reads the database-backed controls through its own small lazy pool; an unreadable state fails closed for every
// trade_state job (see ./scheduledJob.ts). Not configured under NODE_ENV=test, where the vitest setup installs an explicit test source.
const runtimeStatePool = process.env["NODE_ENV"] === "test" ? undefined : createPooledStateSource(config.databaseUrl);
if (runtimeStatePool) configureRuntimeState({ source: runtimeStatePool.source });

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

// Explicit ioredis client: BullMQ cannot lazily load ioredis under native ESM.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
const marketQueue = new Queue("market_queue", { connection: redis });

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
  void runScheduledJob({ name: "market_bars_enqueue", effect: "market_data" }, enqueueMarketBarsForWatchlist, {
    log: (event, fields) => console.warn(`[scheduler] ${event} ${JSON.stringify(fields)}`),
  }).catch((err: unknown) => {
    console.error(
      `[scheduler] failed to enqueue market_bars jobs: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
});

// ─── Risk housekeeping (Stage 3 / Task 4) ───────────────────────────────────
// Expires stale risk decisions (appends EXPIRED versions) and records / alerts the daily and weekly loss circuit breakers. Both only remove exposure or record
// state ("risk_housekeeping"), so they keep running under the kill switch. Not started under NODE_ENV=test.
//   TWINS_RISK_EXPIRY_CRON (default every minute)   TWINS_BREAKER_CRON (default every minute)
const riskDb = process.env["NODE_ENV"] === "test" ? undefined : createBoundedDb(config.databaseUrl, { max: 3, idleTimeoutMillis: 10_000 });
if (riskDb) {
  const expiryCron = process.env["TWINS_RISK_EXPIRY_CRON"] ?? "* * * * *";
  const breakerCron = process.env["TWINS_BREAKER_CRON"] ?? "* * * * *";
  for (const [name, expr] of [["TWINS_RISK_EXPIRY_CRON", expiryCron], ["TWINS_BREAKER_CRON", breakerCron]] as const) {
    if (!cron.validate(expr)) throw new Error(`${name} "${expr}" is not a valid cron expression.`);
  }
  const riskLog = createStructuredLogger((r) => console.log(JSON.stringify(r)));
  // the breaker alerts are specified at INFO/WARNING/CRITICAL, so this alerter delivers INFO too (the destination is still the configured relay/webhook)
  const breakerAlerter = alerterFromEnv({ ...process.env, TWINS_ALERT_MIN_SEVERITY: "INFO" }, "scheduler", riskLog);
  const expiryConfig = loadExpiryConfig();
  const breakerConfig = loadBreakerConfig();
  cron.schedule(expiryCron, () => {
    void runScheduledJob({ name: "risk_decision_expiry", effect: "risk_housekeeping" }, async () => {
      const run = await expireStaleRiskDecisions(riskDb.db, { config: expiryConfig });
      if (run.examined > 0) riskLog.info("scheduler.risk_expiry.run", { examined: run.examined, expired: run.expired.length, alreadyExpired: run.alreadyExpired, skipped: run.skipped.length });
    }, { log: (event, fields) => console.warn(`[scheduler] ${event} ${JSON.stringify(fields)}`) }).catch((err: unknown) => {
      console.error(`[scheduler] risk expiry failed: ${err instanceof Error ? err.name : "Error"}`);
    });
  });
  cron.schedule(breakerCron, () => {
    void runScheduledJob({ name: "circuit_breaker_evaluation", effect: "risk_housekeeping" }, async () => {
      const capital = loadSizingConfig().availableCapital;
      if (capital === null) return; // nothing is sized without configured capital, so there is no loss limit to evaluate
      await evaluateCircuitBreakers(riskDb.db, { capital, breakers: breakerConfig, expiry: expiryConfig, onBreakerEvent: (e) => breakerAlerter.alert({ ...breakerAlert(e), dedupeKey: e.id }) });
      await breakerAlerter.flush();
    }, { log: (event, fields) => console.warn(`[scheduler] ${event} ${JSON.stringify(fields)}`) }).catch((err: unknown) => {
      console.error(`[scheduler] circuit breaker evaluation failed: ${err instanceof Error ? err.name : "Error"}`);
    });
  });
  console.log(`[scheduler] risk housekeeping: expiry "${expiryCron}", circuit breakers "${breakerCron}"`);
}

// ─── Independent Opportunity Engine (Stage 05) ──────────────────────────────
// Enqueues ONE cycle job per cron slot (scan -> revalidate -> research). OFF unless TWINS_OPPORTUNITY_ENABLED=true; the slot is the job id, so a double fire or a restart enqueues the same job once.
// Creates research candidates only ("research_intake": skipped under the kill switch or while intake is off). TWINS_OPPORTUNITY_CRON (default every 15 minutes, 03:45-10:00 UTC Mon-Fri = 09:15-15:30 IST).
const opportunityConfig = loadOpportunityConfig();
const opportunityQueue = opportunityConfig.enabled && process.env["NODE_ENV"] !== "test" ? new Queue("opportunity_queue", { connection: redis }) : null;
if (opportunityQueue) {
  const oppCron = process.env["TWINS_OPPORTUNITY_CRON"] ?? "*/15 3-10 * * 1-5";
  if (!cron.validate(oppCron)) throw new Error(`TWINS_OPPORTUNITY_CRON "${oppCron}" is not a valid cron expression.`);
  cron.schedule(oppCron, () => {
    void runScheduledJob({ name: "opportunity_cycle_enqueue", effect: "research_intake" }, async () => {
      const slot = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString().slice(0, 16) + "Z"; // minute resolution: the same fire is the same slot
      await opportunityQueue.add("opportunity_cycle", { jobType: "opportunity_cycle", slotKey: slot }, { jobId: `opportunity-${slot}`, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 500 });
    }, { log: (event, fields) => console.warn(`[scheduler] ${event} ${JSON.stringify(fields)}`) }).catch((err: unknown) => {
      console.error(`[scheduler] opportunity enqueue failed: ${err instanceof Error ? err.name : "Error"}`);
    });
  });
  console.log(`[scheduler] opportunity engine: "${oppCron}" (universe ${opportunityConfig.universe.length}, data source ${opportunityConfig.dataSource})`);
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[scheduler] received ${signal}, shutting down gracefully`);
  try {
    await marketQueue.close();
    await opportunityQueue?.close();
  } catch (err) {
    console.error(`[scheduler] queue close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await redis.quit().catch(() => redis.disconnect());
  await runtimeStatePool?.close().catch(() => undefined);
  await riskDb?.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

console.log(`[scheduler] running. Next tick at cron: "${cronExpression}"`);
