import { describe, expect, it } from "vitest";
import { validateSignalStructure } from "../../../packages/decision-intelligence/src/structuralValidation";

const baseSignal = {
  id: "sig-1",
  sourceType: "telegram",
  telegramMessageId: "msg-1",
  instrumentId: "inst-1",
  direction: "buy" as const,
  entryPrice: "100",
  stopLoss: "95",
  targets: [110],
  timeframe: null,
  extractedConfidence: null,
  status: "analyzed" as const,
  signalTimestamp: new Date("2026-01-01T00:00:00Z"),
  receivedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const instrument = {
  id: "inst-1",
  symbol: "TEST",
  exchange: "NSE",
  instrumentType: "equity",
  name: null,
  isin: null,
  currency: "INR",
  lotSize: null,
  tickSize: null,
  isActive: true,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("validateSignalStructure (R0A / LOG-02)", () => {
  it("passes a well-formed, fresh, resolved signal with no issues", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const result = validateSignalStructure(baseSignal, instrument, now);
    expect(result.blocking).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when the instrument could not be resolved", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const result = validateSignalStructure(baseSignal, null, now);
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.ruleId === "structural.instrument_unresolved")).toBe(true);
  });

  it("blocks an invalid direction", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const invalidDirectionSignal = { ...baseSignal, direction: "hold" as never };
    const result = validateSignalStructure(invalidDirectionSignal, instrument, now);
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.ruleId === "structural.invalid_direction")).toBe(true);
  });

  it("blocks a signal timestamped in the future", () => {
    const now = new Date("2020-01-01T00:00:00Z"); // before the signal's own timestamp
    const result = validateSignalStructure(baseSignal, instrument, now);
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.ruleId === "structural.future_signal")).toBe(true);
  });

  it("blocks a signal with an invalid (NaN) timestamp", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const invalidTimeSignal = { ...baseSignal, signalTimestamp: new Date("invalid") };
    const result = validateSignalStructure(invalidTimeSignal, instrument, now);
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.ruleId === "structural.invalid_timestamp")).toBe(true);
  });

  it("blocks a stale signal beyond the freshness threshold (LOG-02)", () => {
    const maxSignalAgeMs = 1000 * 60 * 60 * 24 * 30; // 30 days
    const now = new Date(baseSignal.signalTimestamp.getTime() + maxSignalAgeMs + 1000); // 30 days + 1s
    const result = validateSignalStructure(baseSignal, instrument, now, { maxSignalAgeMs });
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.ruleId === "structural.stale_signal")).toBe(true);
  });

  it("respects exact staleness boundary: exactly at threshold is not stale, 1ms beyond is blocking", () => {
    const maxSignalAgeMs = 1000 * 60 * 60; // 1 hour
    const exactBoundaryNow = new Date(baseSignal.signalTimestamp.getTime() + maxSignalAgeMs);
    const exactResult = validateSignalStructure(baseSignal, instrument, exactBoundaryNow, { maxSignalAgeMs });
    expect(exactResult.blocking).toBe(false);
    expect(exactResult.issues.some((i) => i.ruleId === "structural.stale_signal")).toBe(false);

    const beyondBoundaryNow = new Date(baseSignal.signalTimestamp.getTime() + maxSignalAgeMs + 1);
    const beyondResult = validateSignalStructure(baseSignal, instrument, beyondBoundaryNow, { maxSignalAgeMs });
    expect(beyondResult.blocking).toBe(true);
    expect(beyondResult.issues.some((i) => i.ruleId === "structural.stale_signal")).toBe(true);
  });

  it("flags (non-blocking) a bare signal with no entry/stop/targets", () => {
    const bare = { ...baseSignal, entryPrice: null, stopLoss: null, targets: [] };
    const now = new Date(baseSignal.signalTimestamp.getTime() + 1000 * 60);
    const result = validateSignalStructure(bare, instrument, now);
    expect(result.blocking).toBe(false);
    expect(result.issues.some((i) => i.ruleId === "structural.bare_signal")).toBe(true);
  });
});
