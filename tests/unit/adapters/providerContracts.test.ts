import { describe, expect, it } from "vitest";
import { marketDataProviders } from "../../../adapters/market/src/index";
import { newsProviders } from "../../../adapters/news/src/index";
import { macroProviders } from "../../../adapters/macro/src/index";
import { telegramProviders } from "../../../adapters/telegram/src/index";
import {
  brokerConnections,
  executionProviders,
} from "../../../adapters/broker/src/index";
import { aiProviders } from "../../../packages/ai/src/index";
import { configureRuntimeState, inMemoryStateSource } from "../../../packages/runtime-state/src/index";
import type {
  AIAnalysisRequest,
  AIAnalysisResponse,
  AIProvider,
  BrokerProvider,
  ExecutionProvider,
  MacroProvider,
  MacroSeriesRequest,
  MarketBarRequest,
  MarketDataProvider,
  NewsFetchParams,
  NewsProvider,
  NormalizedAccountSnapshot,
  NormalizedMacroObservation,
  NormalizedMarketBar,
  NormalizedNewsItem,
  NormalizedOrderAck,
  NormalizedOrderStatus,
  NormalizedTelegramMessage,
  PlaceOrderRequest,
  ProviderHealthSnapshot,
  TelegramFetchParams,
  TelegramProvider,
} from "../../../packages/types/src/index";

/**
 * These are test-only fixtures that prove each provider contract is
 * genuinely implementable end-to-end through its registry - they return
 * clearly-synthetic, deterministic values and are never exported from
 * any production package (spec section 55: "do not create fake provider
 * data" refers to production code, not test doubles).
 */

function healthy(providerName: string, providerType: ProviderHealthSnapshot["providerType"]): ProviderHealthSnapshot {
  return {
    providerName,
    providerType,
    status: "healthy",
    checkedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName = "fixture-market";

  async getHistoricalBars(request: MarketBarRequest): Promise<NormalizedMarketBar[]> {
    return [
      {
        instrument: request.instrument,
        source: this.providerName,
        timeframe: request.timeframe,
        observedAt: request.from,
        close: 100,
      },
    ];
  }

  async getLatestQuote(): Promise<NormalizedMarketBar | null> {
    return null;
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "market");
  }
}

class FixtureNewsProvider implements NewsProvider {
  readonly providerName = "fixture-news";
  readonly sourceTier = "C" as const;

  async fetchLatest(_params: NewsFetchParams): Promise<NormalizedNewsItem[]> {
    return [
      {
        sourceName: this.providerName,
        sourceTier: this.sourceTier,
        sourceUrl: "https://example.invalid/article",
        headline: "fixture headline",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "news");
  }
}

class FixtureMacroProvider implements MacroProvider {
  readonly providerName = "fixture-macro";

  async fetchSeries(request: MacroSeriesRequest): Promise<NormalizedMacroObservation[]> {
    return [
      {
        source: this.providerName,
        region: request.region,
        seriesCode: request.seriesCode,
        observedAt: new Date("2026-01-01T00:00:00Z"),
        value: 6.5,
      },
    ];
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "macro");
  }
}

class FixtureTelegramProvider implements TelegramProvider {
  readonly providerName = "fixture-telegram";

  async fetchMessages(params: TelegramFetchParams): Promise<NormalizedTelegramMessage[]> {
    return [
      {
        channelIdentifier: params.channelIdentifier,
        externalMessageId: "1",
        messageTimestamp: new Date("2026-01-01T00:00:00Z"),
        rawText: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
      },
    ];
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "telegram");
  }
}

class FixtureBrokerProvider implements BrokerProvider {
  readonly providerName = "fixture-broker";

  async connect(): Promise<void> {}

  async getAccountSnapshot(): Promise<NormalizedAccountSnapshot> {
    return {
      providerAccountId: "ACC-1",
      cash: 100000,
      equity: 100000,
      currency: "INR",
    };
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "broker");
  }
}

class FixtureExecutionProvider implements ExecutionProvider {
  readonly providerName = "fixture-execution";

  async placeOrder(request: PlaceOrderRequest): Promise<NormalizedOrderAck> {
    return { brokerOrderId: `broker-${request.idempotencyKey}`, status: "submitted" };
  }

  async cancelOrder(): Promise<void> {}

  async getOrderStatus(brokerOrderId: string): Promise<NormalizedOrderStatus> {
    return { brokerOrderId, status: "filled", filledQuantity: 10 };
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "broker");
  }
}

class FixtureAIProvider implements AIProvider {
  readonly providerName = "fixture-ai";
  readonly modelId = "fixture-model";

  async analyzeSignal(request: AIAnalysisRequest): Promise<AIAnalysisResponse> {
    return {
      bullThesis: "fixture bull thesis",
      bearThesis: "fixture bear thesis",
      supportingEvidenceIds: request.evidence.map((e) => e.id),
      contradictingEvidenceIds: [],
      confidenceLabel: "model self-reported, not calibrated",
      raw: null,
    };
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    return healthy(this.providerName, "ai");
  }
}

describe("provider contracts wire through their registries", () => {
  it("MarketDataProvider", async () => {
    const provider = new FixtureMarketDataProvider();
    marketDataProviders.register(provider.providerName, provider);
    const resolved = marketDataProviders.get(provider.providerName);
    const bars = await resolved.getHistoricalBars({
      instrument: { symbol: "RELIANCE", exchange: "NSE" },
      timeframe: "1d",
      from: new Date("2026-01-01"),
      to: new Date("2026-01-02"),
    });
    expect(bars[0]?.source).toBe("fixture-market");
    expect((await resolved.getHealth()).status).toBe("healthy");
  });

  it("NewsProvider", async () => {
    const provider = new FixtureNewsProvider();
    newsProviders.register(provider.providerName, provider);
    const items = await newsProviders.get(provider.providerName).fetchLatest({});
    expect(items[0]?.sourceTier).toBe("C");
  });

  it("MacroProvider", async () => {
    const provider = new FixtureMacroProvider();
    macroProviders.register(provider.providerName, provider);
    const obs = await macroProviders
      .get(provider.providerName)
      .fetchSeries({ region: "IN", seriesCode: "REPO_RATE" });
    expect(obs[0]?.seriesCode).toBe("REPO_RATE");
  });

  it("TelegramProvider", async () => {
    const provider = new FixtureTelegramProvider();
    telegramProviders.register(provider.providerName, provider);
    const messages = await telegramProviders
      .get(provider.providerName)
      .fetchMessages({ channelIdentifier: "chan-1" });
    expect(messages[0]?.rawText).toContain("BUY");
  });

  it("BrokerProvider and ExecutionProvider are distinct registries", async () => {
    const broker = new FixtureBrokerProvider();
    const execution = new FixtureExecutionProvider();
    brokerConnections.register(broker.providerName, broker);
    executionProviders.register(execution.providerName, execution);

    expect(brokerConnections.has(execution.providerName)).toBe(false);
    expect(executionProviders.has(broker.providerName)).toBe(false);

    // Order creation is behind the runtime safety boundary: this test turns trading ON in its own explicit in-memory state
    // (the seeded default is OFF); refusal behaviour is covered in tests/unit/safety/executionBoundary.test.ts.
    configureRuntimeState({ source: inMemoryStateSource({ TRADING_ENABLED: true }), ttlMs: 0, failureTtlMs: 0 });
    const ack = await executionProviders.get(execution.providerName).placeOrder({
      instrument: { symbol: "RELIANCE", exchange: "NSE" },
      side: "buy",
      orderType: "market",
      quantity: 10,
      idempotencyKey: "idem-1",
    });
    expect(ack.status).toBe("submitted");
  });

  it("AIProvider always returns a confidenceLabel", async () => {
    const provider = new FixtureAIProvider();
    aiProviders.register(provider.providerName, provider);
    const result = await aiProviders.get(provider.providerName).analyzeSignal({
      signalId: "sig-1",
      instrument: { symbol: "RELIANCE", exchange: "NSE" },
      evidence: [{ kind: "news_evidence", id: "ev-1", summary: "test evidence" }],
    });
    expect(result.confidenceLabel).toBeTruthy();
    expect(result.supportingEvidenceIds).toEqual(["ev-1"]);
  });
});
