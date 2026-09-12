import { describe, expect, it } from "vitest";
import {
  checkMacroObservationQuality,
  checkMarketBarQuality,
  checkNewsItemQuality,
  checkTelegramMessageQuality,
} from "../../../packages/ingestion/src/dataQuality";
import { computeNewsDedupeHash } from "../../../packages/ingestion/src/dedupe";

describe("checkMarketBarQuality", () => {
  const receivedAt = new Date("2026-01-02T00:00:00Z");

  it("accepts a complete, fresh bar as ok", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      timeframe: "1d",
      receivedAt,
    });
    expect(result).toMatchObject({ valid: true, status: "ok" });
  });

  it("rejects a missing observedAt", () => {
    const result = checkMarketBarQuality({
      observedAt: undefined,
      close: 1,
      timeframe: "1d",
      receivedAt,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an invalid Date", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date(NaN),
      close: 1,
      timeframe: "1d",
      receivedAt,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects high < low", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      high: 1,
      low: 2,
      timeframe: "1d",
      receivedAt,
    });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("high is less than low");
  });

  it("rejects negative volume", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      close: 1,
      volume: -10,
      timeframe: "1d",
      receivedAt,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a bar with no OHLCV fields at all", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      timeframe: "1d",
      receivedAt,
    });
    expect(result.valid).toBe(false);
  });

  it("marks a partial bar as incomplete but still valid", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      close: 1,
      timeframe: "1d",
      receivedAt,
    });
    expect(result).toMatchObject({ valid: true, status: "incomplete" });
  });

  it("marks a bar older than maxStalenessMs as stale", () => {
    const result = checkMarketBarQuality({
      observedAt: new Date("2020-01-01T00:00:00Z"),
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      timeframe: "1d",
      receivedAt,
      maxStalenessMs: 1000 * 60 * 60,
    });
    expect(result).toMatchObject({ valid: true, status: "stale" });
  });
});

describe("checkMacroObservationQuality", () => {
  it("accepts a valid observation", () => {
    const result = checkMacroObservationQuality({
      observedAt: new Date("2026-01-01"),
      value: 6.5,
      region: "IN",
      seriesCode: "REPO_RATE",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a non-finite value", () => {
    const result = checkMacroObservationQuality({
      observedAt: new Date("2026-01-01"),
      value: Number.NaN,
      region: "IN",
      seriesCode: "REPO_RATE",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a missing region", () => {
    const result = checkMacroObservationQuality({
      observedAt: new Date("2026-01-01"),
      value: 1,
      region: "",
      seriesCode: "REPO_RATE",
    });
    expect(result.valid).toBe(false);
  });
});

describe("checkNewsItemQuality", () => {
  it("accepts a valid item", () => {
    const result = checkNewsItemQuality({
      headline: "headline",
      sourceUrl: "https://example.invalid/x",
      sourceTimestamp: new Date("2026-01-01"),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an invalid URL", () => {
    const result = checkNewsItemQuality({
      headline: "headline",
      sourceUrl: "not a url",
      sourceTimestamp: new Date("2026-01-01"),
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a missing headline", () => {
    const result = checkNewsItemQuality({
      headline: "",
      sourceUrl: "https://example.invalid/x",
      sourceTimestamp: new Date("2026-01-01"),
    });
    expect(result.valid).toBe(false);
  });
});

describe("checkTelegramMessageQuality", () => {
  it("accepts a valid message", () => {
    const result = checkTelegramMessageQuality({
      externalMessageId: "1",
      messageTimestamp: new Date("2026-01-01"),
      rawText: "BUY RELIANCE",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects empty rawText", () => {
    const result = checkTelegramMessageQuality({
      externalMessageId: "1",
      messageTimestamp: new Date("2026-01-01"),
      rawText: "",
    });
    expect(result.valid).toBe(false);
  });
});

describe("computeNewsDedupeHash", () => {
  it("normalizes case and a trailing slash to the same hash", () => {
    const a = computeNewsDedupeHash("https://Example.com/Article/1/");
    const b = computeNewsDedupeHash("https://example.com/article/1");
    expect(a).toBe(b);
  });

  it("produces the same hash for exact duplicates", () => {
    const a = computeNewsDedupeHash("https://example.com/article/1");
    const b = computeNewsDedupeHash("https://example.com/article/1");
    expect(a).toBe(b);
  });

  it("treats a trailing slash as equivalent", () => {
    const a = computeNewsDedupeHash("https://example.com/article/1");
    const b = computeNewsDedupeHash("https://example.com/article/1/");
    expect(a).toBe(b);
  });
});
