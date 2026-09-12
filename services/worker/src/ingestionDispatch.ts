import type { MarketBarRequest, MacroSeriesRequest, NewsFetchParams, TelegramFetchParams } from "@twins/types";
import { marketDataProviders } from "@twins/adapter-market";
import { newsProviders } from "@twins/adapter-news";
import { macroProviders } from "@twins/adapter-macro";
import { telegramProviders } from "@twins/adapter-telegram";
import {
  ingestMacroObservations,
  ingestMarketBars,
  ingestNewsItems,
  ingestTelegramMessages,
  runIngestionJob,
  type Db,
} from "@twins/ingestion";

/**
 * Maps a `jobs.job_type` value to the matching ingestion pipeline + the
 * provider registered under `payload.providerName` (spec section 46:
 * "Create ingestion jobs only where necessary" - this is the dispatch
 * point a scheduler/queue consumer calls into; no queue transport is
 * wired yet because no concrete provider is registered to run against).
 *
 * This intentionally never runs automatically at worker startup - it is
 * only exercised once a real adapter registers itself with one of the
 * adapters/* registries and something (a future scheduler tick, a manual
 * trigger) invokes it with a concrete payload.
 */
export type IngestionJobType =
  | "market_bars"
  | "news_latest"
  | "macro_series"
  | "telegram_messages";

export interface IngestionJobPayload {
  providerName: string;
  market?: { request: MarketBarRequest; instrumentType: string; maxStalenessMs?: number };
  news?: { params: NewsFetchParams };
  macro?: { request: MacroSeriesRequest };
  telegram?: { params: TelegramFetchParams };
}

export async function dispatchIngestionJob(
  db: Db,
  jobType: IngestionJobType,
  payload: IngestionJobPayload,
) {
  switch (jobType) {
    case "market_bars": {
      if (!payload.market) throw new Error("market payload required for market_bars job");
      const provider = marketDataProviders.get(payload.providerName);
      return runIngestionJob(db, {
        jobType,
        queueName: "market_queue",
        providerName: payload.providerName,
        providerType: "market",
        payload,
        execute: () =>
          ingestMarketBars(db, provider, payload.market!.request, {
            instrumentType: payload.market!.instrumentType,
            maxStalenessMs: payload.market!.maxStalenessMs,
          }),
      });
    }
    case "news_latest": {
      if (!payload.news) throw new Error("news payload required for news_latest job");
      const provider = newsProviders.get(payload.providerName);
      return runIngestionJob(db, {
        jobType,
        queueName: "news_queue",
        providerName: payload.providerName,
        providerType: "news",
        payload,
        execute: () => ingestNewsItems(db, provider, payload.news!.params),
      });
    }
    case "macro_series": {
      if (!payload.macro) throw new Error("macro payload required for macro_series job");
      const provider = macroProviders.get(payload.providerName);
      return runIngestionJob(db, {
        jobType,
        queueName: "macro_queue",
        providerName: payload.providerName,
        providerType: "macro",
        payload,
        execute: () => ingestMacroObservations(db, provider, payload.macro!.request),
      });
    }
    case "telegram_messages": {
      if (!payload.telegram) {
        throw new Error("telegram payload required for telegram_messages job");
      }
      const provider = telegramProviders.get(payload.providerName);
      return runIngestionJob(db, {
        jobType,
        queueName: "signal_queue",
        providerName: payload.providerName,
        providerType: "telegram",
        payload,
        execute: () => ingestTelegramMessages(db, provider, payload.telegram!.params),
      });
    }
    default: {
      const exhaustive: never = jobType;
      throw new Error(`unknown ingestion job type: ${exhaustive}`);
    }
  }
}
