import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Shared enums. Kept intentionally small and closed only where the spec
 * defines a fixed vocabulary (trading modes, decision outputs, etc).
 * Provider/source identifiers stay as free text (`text`) since new
 * providers are added via adapters, not schema migrations (spec section 43).
 */

export const tradingModeEnum = pgEnum("trading_mode", [
  "paper",
  "shadow",
  "live",
]);

export const sourceTierEnum = pgEnum("source_tier", [
  "A", // primary/authoritative (NSE, BSE, RBI, SEBI, MOSPI, filings)
  "B", // professional/market-data providers, broker APIs
  "C", // established financial news
  "D", // aggregation/discovery (GDELT, secondary news APIs)
  "E", // community signals (Telegram) - never a source of truth
]);

export const dataQualityStatusEnum = pgEnum("data_quality_status", [
  "ok",
  "stale",
  "incomplete",
  "conflicting",
  "invalid",
]);

export const signalDirectionEnum = pgEnum("signal_direction", [
  "buy",
  "sell",
]);

export const signalStatusEnum = pgEnum("signal_status", [
  "pending", // ingested, not yet analyzed
  "analyzed", // analysis complete, awaiting decision
  "decided", // a decision has been recorded
  "expired", // signal timed out / no longer actionable
  "invalid", // failed structural validation
]);

/** Evidence linked into signal_evidence must be one of these kinds. */
export const evidenceKindEnum = pgEnum("evidence_kind", [
  "market_observation",
  "macro_observation",
  "news_evidence",
]);

export const decisionOutcomeEnum = pgEnum("decision_outcome", [
  "BUY",
  "SELL",
  "WAIT",
  "REJECT",
]);

export const orderSideEnum = pgEnum("order_side", ["buy", "sell"]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "submitted",
  "partially_filled",
  "filled",
  "cancelled",
  "rejected",
]);

export const providerTypeEnum = pgEnum("provider_type", [
  "market",
  "broker",
  "news",
  "macro",
  "telegram",
  "ai",
]);

export const providerHealthStatusEnum = pgEnum("provider_health_status", [
  "healthy",
  "degraded",
  "down",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const backtestStatusEnum = pgEnum("backtest_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "ai"]);
