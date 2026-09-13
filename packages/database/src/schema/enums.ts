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

/**
 * Phase 7 - Entity & Event Intelligence. Kept to the small set the spec
 * enumerates (company/sector/market/country/macro) rather than an
 * unrestricted taxonomy. `instrument` is deliberately excluded - the
 * existing `instruments` table already IS that concept; entities relate
 * to instruments via entity_relationships (ISSUED_BY / TRADED_ON), not by
 * duplicating instruments as entities.
 */
export const entityTypeEnum = pgEnum("entity_type", [
  "company",
  "sector",
  "market",
  "country",
  "macro",
]);

/** Controlled relationship vocabulary (spec: "avoid an unrestricted graph"). */
export const relationshipTypeEnum = pgEnum("relationship_type", [
  "ISSUED_BY",
  "BELONGS_TO",
  "TRADED_ON",
  "LOCATED_IN",
  "AFFECTS",
  "MENTIONS",
]);

/**
 * Distinguishes an explicitly-supported link from a merely plausible one
 * (spec: "Do not turn a potential relationship into a factual causal
 * claim"). `direct` = the source evidence itself states the link (e.g. a
 * news mention). `structural` = a fixed domain mapping TWINS was
 * configured with (e.g. instrument -> issuing company). `potential` is
 * reserved for a future analytical-validation step; nothing in Phase 7
 * currently emits it.
 */
export const relationshipStrengthEnum = pgEnum("relationship_strength", [
  "direct",
  "structural",
  "potential",
]);

/** Provenance: exactly how a relationship was established (spec: "why did TWINS associate..."). */
export const matchMethodEnum = pgEnum("match_method", [
  "exact_canonical",
  "exact_alias",
  "ticker_exchange",
  "structured_provider_id",
  "deterministic_rule",
]);

/**
 * A controlled, finite event-type set spanning the four categories the
 * spec names (corporate/market/macro/geopolitical) plus cross-asset. Not
 * exhaustive of every possible real-world event - unrecognized events
 * stay untyped (NULL) rather than being forced into the nearest category.
 */
export const newsEventTypeEnum = pgEnum("news_event_type", [
  "earnings",
  "merger_acquisition",
  "management_change",
  "dividend",
  "buyback",
  "bankruptcy",
  "regulatory_action",
  "exchange_halt",
  "index_rebalance",
  "major_price_event",
  "liquidity_event",
  "interest_rate_decision",
  "inflation_release",
  "employment_report",
  "gdp_release",
  "central_bank_statement",
  "sanctions",
  "conflict_escalation",
  "election",
  "trade_restriction",
  "tariff",
  "oil_supply_disruption",
  "commodity_move",
  "currency_event",
]);

/** Lightweight event-lifecycle state (spec: events evolve; never erase earlier evidence). */
export const newsEventStatusEnum = pgEnum("news_event_status", [
  "reported",
  "corrected",
  "confirmed",
  "developing",
]);

/**
 * Phase 9 - Decision Intelligence. Deliberately NOT reusing
 * `decision_outcome` (BUY/SELL/WAIT/REJECT) - that enum belongs to a
 * later trade-direction Decision Engine phase. This is an earlier,
 * distinct gate: whether the available evidence is even sufficient to
 * let a signal proceed toward that later decision, not what direction
 * to trade. There is deliberately no "always decide something" pressure -
 * INSUFFICIENT_EVIDENCE is a first-class, non-failure outcome.
 */
export const signalValidationOutcomeEnum = pgEnum("signal_validation_outcome", [
  "APPROVE",
  "REJECT",
  "INSUFFICIENT_EVIDENCE",
]);

/** Severity of a counter-thesis's strongest invalidating factor - a deterministic classification, never a probability. */
export const counterThesisSeverityEnum = pgEnum("counter_thesis_severity", [
  "low",
  "medium",
  "high",
]);

/**
 * Source reliability must never become a fabricated trust score (spec:
 * "Do not hardcode arbitrary real-world credibility claims"). Until a
 * future phase tracks actual historical outcomes, this is always
 * UNKNOWN - the enum exists now so that future phase has a column to
 * populate without a schema change, not so Phase 9 can invent a number.
 */
export const sourceReliabilityEnum = pgEnum("source_reliability", [
  "UNKNOWN",
  "LOW",
  "MODERATE",
  "HIGH",
]);
