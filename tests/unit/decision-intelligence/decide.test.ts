import { describe, expect, it } from "vitest";
import { decide } from "../../../packages/decision-intelligence/src/decide";
import { fixtureQuality, fixtureReport } from "./fixtures";

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

function cleanReport() {
  return fixtureReport({
    core: {
      telegramMessageQuality: fixtureQuality({ entityType: "telegram_messages", overallStatus: "trusted" }),
      macroContext: [
        { id: "m1", source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), receivedAt: new Date(), value: "6.5", unit: null, dataQualityStatus: "ok", rawPayload: null, createdAt: new Date() },
      ],
      newsContext: [
        { id: "n1", newsSourceId: "s1", newsEventId: null, sourceUrl: "https://x.invalid", headline: "headline", bodyExcerpt: null, sourceTimestamp: new Date(), receivedAt: new Date(), dedupeHash: "h", rawPayload: null, createdAt: new Date() },
      ],
    } as never,
  });
}

describe("decide", () => {
  it("APPROVEs when structure is valid, no high/medium contradiction exists, and evidence is reasonably complete", () => {
    const report = cleanReport();
    const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
    expect(result.outcome).toBe("APPROVE");
    expect(result.confidenceLabel).toMatch(/not a probability of profit/i);
    expect(result.structuralIssues).toHaveLength(0);
  });

  it("REJECTs outright on a blocking structural issue, before any evidence is considered", () => {
    const report = cleanReport();
    const result = decide(report.core.signal, null, report, { now: report.core.signal.signalTimestamp });
    expect(result.outcome).toBe("REJECT");
    expect(result.decisionConfidence).toBe(1);
    expect(result.rationale).toMatch(/structurally invalid/i);
  });

  it("REJECTs when a high-severity counter-thesis exists (a real negative-convention event opposing the trade)", () => {
    const report = cleanReport();
    report.entityContext.relevantEvents = [{ id: "evt-1", title: "Company files for bankruptcy", eventType: "bankruptcy", firstSeenAt: new Date() }];
    const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
    expect(result.outcome).toBe("REJECT");
    expect(result.counterThesis.severity).toBe("high");
    expect(result.rationale).toMatch(/bankruptcy/i);
  });

  it("returns INSUFFICIENT_EVIDENCE when essentially no evidence exists at all", () => {
    const report = fixtureReport({
      core: {
        marketContext: null,
        macroContext: [],
        newsContext: [],
        telegramMessageQuality: fixtureQuality({ entityType: "telegram_messages", overallStatus: "flagged" }),
      } as never,
      entityContext: { company: null, sector: null, market: null, country: null, relevantEvents: [] },
    });
    const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decisionConfidence).toBe(0.5);
  });

  it("never claims a chance of making/earning money anywhere in the result, and states the confidence caveat explicitly", () => {
    const report = cleanReport();
    const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
    expect(JSON.stringify(result)).not.toMatch(/chance of (making|earning) money/i);
    expect(result.confidenceLabel).toContain("not a probability of profit");
  });

  it("always includes source reliability as UNKNOWN with a reason, never a fabricated score", () => {
    const report = cleanReport();
    const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
    expect(result.sourceReliability.level).toBe("UNKNOWN");
    expect(result.sourceReliability.reason.length).toBeGreaterThan(0);
  });

  it("bounds decisionConfidence within [0, 1] across every outcome branch", () => {
    const reports = [cleanReport(), cleanReport(), cleanReport()];
    reports[1]!.entityContext.relevantEvents = [{ id: "e1", title: "bankruptcy", eventType: "bankruptcy", firstSeenAt: new Date() }];
    reports[2]!.core.marketContext = null;
    reports[2]!.core.macroContext = [];
    reports[2]!.core.newsContext = [];
    reports[2]!.entityContext = { company: null, sector: null, market: null, country: null, relevantEvents: [] };

    for (const report of reports) {
      const result = decide(report.core.signal, instrument, report, { now: report.core.signal.signalTimestamp });
      expect(result.decisionConfidence).toBeGreaterThanOrEqual(0);
      expect(result.decisionConfidence).toBeLessThanOrEqual(1);
    }
  });
});
