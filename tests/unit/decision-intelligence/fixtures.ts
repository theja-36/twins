import type { SignalIntelligenceReport } from "../../../packages/signals/src/engine";
import type { QualityAssessmentResult } from "../../../packages/dataquality/src/types";

export function fixtureQuality(overrides: Partial<QualityAssessmentResult> = {}): QualityAssessmentResult {
  return {
    entityType: "market_observations",
    entityId: "obs-1",
    source: "fixture",
    overallStatus: "trusted",
    qualityScore: 1,
    dimensions: [],
    reasons: [],
    evaluatedAt: new Date(),
    ...overrides,
  };
}

export function failedDimensionQuality(dimension: string): QualityAssessmentResult {
  return fixtureQuality({
    overallStatus: "flagged",
    qualityScore: 0.5,
    dimensions: [{ dimension: dimension as never, ruleId: "fixture.rule", passed: false, applicable: true }],
    reasons: [`${dimension} failed`],
  });
}

export function fixtureReport(overrides: Partial<SignalIntelligenceReport> = {}): SignalIntelligenceReport {
  const now = new Date();
  const signal = {
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
    signalTimestamp: now,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const base: SignalIntelligenceReport = {
    contextWindow: { asOf: now, from: undefined },
    core: {
      signal,
      originalTelegramMessage: {
        id: "msg-1",
        telegramSourceId: "src-1",
        externalMessageId: "1",
        messageTimestamp: now,
        receivedAt: now,
        rawText: "BUY TEST @ 100 SL 95 TGT 110",
        rawPayload: null,
        createdAt: now,
      },
      telegramMessageQuality: fixtureQuality({ entityType: "telegram_messages", overallStatus: "flagged" }),
      marketContext: {
        observation: {
          id: "obs-1",
          instrumentId: "inst-1",
          source: "fixture-market",
          timeframe: "1d",
          observedAt: now,
          receivedAt: now,
          open: "99",
          high: "101",
          low: "98",
          close: "100",
          volume: null,
          openInterest: null,
          dataQualityStatus: "ok",
          rawPayload: null,
          createdAt: now,
        },
        quality: fixtureQuality(),
      },
      macroContext: [],
      newsContext: [],
      priorSignalStats: { totalPriorSignalsForInstrument: 0 },
      dataCompletenessNotes: [],
      generatedAt: now,
    },
    entityContext: {
      company: { entityId: "ent-1", entityType: "company", canonicalName: "Test Co", strength: "structural", matchMethod: "deterministic_rule" },
      sector: null,
      market: null,
      country: null,
      relevantEvents: [],
    },
    normalizedEvidence: [],
    conflicts: [],
    staleEvidence: [],
    generatedAt: now,
  };

  return { ...base, ...overrides, core: { ...base.core, ...overrides.core }, entityContext: { ...base.entityContext, ...overrides.entityContext } };
}
