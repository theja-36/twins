import type { QualityAssessmentResult } from "@twins/dataquality";
import type { SignalIntelligenceReport } from "@twins/signals";
import type { Thesis, ThesisFactor } from "./types";

/**
 * Event types treated as structurally negative/positive by financial
 * convention (spec section 8/9: deterministic rules are preferred over
 * AI; this is a fixed domain mapping over an event's own classified
 * TYPE - set deterministically by Phase 7's keyword rules - never
 * sentiment analysis of article text). Earnings/mergers/macro releases
 * are deliberately excluded: their directional implication depends on
 * "beat vs miss" / deal terms this system cannot determine without
 * fabricating an interpretation, so they stay neutral/contextual only.
 */
const NEGATIVE_CONVENTION_EVENT_TYPES = new Set([
  "bankruptcy",
  "regulatory_action",
  "sanctions",
  "conflict_escalation",
  "management_change",
  "major_price_event",
  "liquidity_event",
  "exchange_halt",
  "trade_restriction",
  "tariff",
]);

const POSITIVE_CONVENTION_EVENT_TYPES = new Set(["dividend", "buyback"]);

function dimensionFailed(quality: QualityAssessmentResult | undefined, dimension: string): boolean {
  if (!quality) return false;
  return quality.dimensions.some((d) => d.dimension === dimension && d.applicable && !d.passed);
}

function strengthOf(factorCount: number): Thesis["strength"] {
  if (factorCount >= 4) return "strong";
  if (factorCount >= 2) return "moderate";
  return "weak";
}

/**
 * Upward (bull) thesis. Only ever cites a positive-convention event
 * actually present in the evidence (spec: "Never invent supporting
 * facts") - there is no other deterministic, non-sentiment signal for
 * upward price movement available from this system's current evidence.
 */
export function buildBullThesis(report: SignalIntelligenceReport): Thesis {
  const factors: ThesisFactor[] = [];
  for (const event of report.entityContext.relevantEvents) {
    if (event.eventType && POSITIVE_CONVENTION_EVENT_TYPES.has(event.eventType)) {
      factors.push({
        ruleId: "bull.positive_convention_event",
        description: `a ${event.eventType} event ("${event.title}") is structurally associated with positive investor sentiment`,
        evidenceId: event.id,
      });
    }
  }

  return {
    stance: "supporting",
    factors,
    evidenceIds: factors.map((f) => f.evidenceId).filter((id): id is string => Boolean(id)),
    strength: strengthOf(factors.length),
  };
}

/**
 * Downward (bear) thesis, generated unconditionally and independently of
 * whatever the Telegram signal claims (spec section 9: "must not be
 * confirmation-biased"). Explicitly includes data-quality problems as
 * valid contradicting factors (spec's own example: "stale market data",
 * "unusual uncertainty") - this is not padding, it is spec-mandated.
 */
export function buildBearThesis(report: SignalIntelligenceReport): Thesis {
  const factors: ThesisFactor[] = [];

  for (const event of report.entityContext.relevantEvents) {
    if (event.eventType && NEGATIVE_CONVENTION_EVENT_TYPES.has(event.eventType)) {
      factors.push({
        ruleId: "bear.negative_convention_event",
        description: `a ${event.eventType} event ("${event.title}") is structurally associated with negative investor sentiment`,
        evidenceId: event.id,
      });
    }
  }

  if (!report.core.marketContext) {
    factors.push({ ruleId: "bear.no_market_data", description: "no market observation is available for this instrument" });
  } else {
    if (dimensionFailed(report.core.marketContext.quality, "freshness")) {
      factors.push({
        ruleId: "bear.stale_market_data",
        description: "the most recent market observation is stale relative to the expected freshness threshold",
        evidenceId: report.core.marketContext.observation.id,
      });
    }
    if (dimensionFailed(report.core.marketContext.quality, "cross_source_conflict")) {
      factors.push({
        ruleId: "bear.market_data_conflict",
        description: "independent sources disagree on this instrument's current price",
        evidenceId: report.core.marketContext.observation.id,
      });
    }
    if (dimensionFailed(report.core.marketContext.quality, "anomaly")) {
      factors.push({
        ruleId: "bear.market_data_anomaly",
        description: "the most recent price move is an unexplained statistical outlier versus prior observations",
        evidenceId: report.core.marketContext.observation.id,
      });
    }
  }

  if (report.core.telegramMessageQuality && report.core.telegramMessageQuality.overallStatus !== "trusted") {
    factors.push({
      ruleId: "bear.untrusted_source",
      description: "the originating Telegram source is never treated as a trusted source of truth on its own",
      evidenceId: report.core.originalTelegramMessage?.id,
    });
  }

  if (!report.entityContext.company) {
    factors.push({ ruleId: "bear.unresolved_entity", description: "the instrument has no configured company/entity mapping, limiting corroboration" });
  }

  if (report.core.macroContext.length === 0 && report.core.newsContext.length === 0) {
    factors.push({ ruleId: "bear.no_corroborating_context", description: "no macro or news evidence exists to corroborate this signal" });
  }

  return {
    stance: "contradicting",
    factors,
    evidenceIds: factors.map((f) => f.evidenceId).filter((id): id is string => Boolean(id)),
    strength: strengthOf(factors.length),
  };
}
