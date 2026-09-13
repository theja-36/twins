import { describe, expect, it } from "vitest";
import {
  normalizeMacroObservations,
  normalizeMarketContext,
  normalizeNewsEvidence,
  normalizeRelevantEvents,
  normalizeTelegramMessage,
} from "../../../packages/signals/src/evidence";
import type { MarketContext } from "../../../packages/signals/src/context/market";

function fixtureQuality() {
  return {
    entityType: "market_observations",
    entityId: "obs-1",
    source: "fixture",
    overallStatus: "trusted" as const,
    qualityScore: 1,
    dimensions: [],
    reasons: [],
    evaluatedAt: new Date(),
  };
}

describe("evidence normalization", () => {
  it("normalizes a null market context to an empty list", () => {
    expect(normalizeMarketContext(null)).toEqual([]);
  });

  it("normalizes a market context into one item carrying its quality", () => {
    const context: MarketContext = {
      observation: {
        id: "obs-1",
        instrumentId: "inst-1",
        source: "fixture-market",
        timeframe: "1d",
        observedAt: new Date("2026-01-01"),
        receivedAt: new Date("2026-01-01"),
        open: "1",
        high: "2",
        low: "0.5",
        close: "1.5",
        volume: null,
        openInterest: null,
        dataQualityStatus: "ok",
        rawPayload: null,
        createdAt: new Date(),
      },
      quality: fixtureQuality(),
    };
    const items = normalizeMarketContext(context);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("market_observation");
    expect(items[0]?.quality?.overallStatus).toBe("trusted");
  });

  it("normalizes macro observations, attaching quality only when present in the map", () => {
    const observations = [
      { id: "m1", source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), receivedAt: new Date(), value: "6.5", unit: null, dataQualityStatus: "ok" as const, rawPayload: null, createdAt: new Date() },
      { id: "m2", source: "RBI", region: "IN", seriesCode: "CPI", observedAt: new Date(), receivedAt: new Date(), value: "5.0", unit: null, dataQualityStatus: "ok" as const, rawPayload: null, createdAt: new Date() },
    ];
    const qualityMap = new Map([["m1", fixtureQuality()]]);
    const items = normalizeMacroObservations(observations, qualityMap);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === "m1")?.quality).toBeDefined();
    expect(items.find((i) => i.id === "m2")?.quality).toBeUndefined();
  });

  it("normalizes news evidence using headline as summary", () => {
    const items = normalizeNewsEvidence(
      [
        {
          id: "n1",
          newsSourceId: "s1",
          newsEventId: null,
          sourceUrl: "https://example.invalid/a",
          headline: "Some headline",
          bodyExcerpt: null,
          sourceTimestamp: new Date(),
          receivedAt: new Date(),
          dedupeHash: "hash",
          rawPayload: null,
          createdAt: new Date(),
        },
      ],
      new Map(),
    );
    expect(items[0]?.summary).toBe("Some headline");
    expect(items[0]?.kind).toBe("news_evidence");
  });

  it("normalizes a telegram message, and an undefined message to an empty list", () => {
    expect(normalizeTelegramMessage(undefined, undefined)).toEqual([]);
    const items = normalizeTelegramMessage(
      {
        id: "t1",
        telegramSourceId: "src1",
        externalMessageId: "1",
        messageTimestamp: new Date(),
        receivedAt: new Date(),
        rawText: "BUY RELIANCE",
        rawPayload: null,
        createdAt: new Date(),
      },
      fixtureQuality(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("telegram_message");
    expect(items[0]?.summary).toBe("BUY RELIANCE");
  });

  it("normalizes relevant events, prefixing the event type when known", () => {
    const items = normalizeRelevantEvents([
      { id: "e1", title: "Company reports earnings", eventType: "earnings", firstSeenAt: new Date() },
      { id: "e2", title: "Something unclassified happened", eventType: null, firstSeenAt: new Date() },
    ]);
    expect(items[0]?.summary).toBe("[earnings] Company reports earnings");
    expect(items[1]?.summary).toBe("Something unclassified happened");
    expect(items.every((i) => i.quality === undefined)).toBe(true);
  });
});
