/**
 * Shared enumerations and the status vocabulary. Each list names its backend source; parity is tested in tests/unit/api-contracts/vocabularyParity.test.ts.
 * Entries marked FRONTEND are interface vocabulary with no backend counterpart (they are not sent over the wire).
 */
/** `DECISION_STATES` in apps/api/src/userApi.ts (the workflow state a decision can be filtered by). */
export const DECISION_STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
export type DecisionState = (typeof DECISION_STATES)[number];
/**
 * Decision OUTCOME names are deliberately NOT mirrored here. `DecisionView.outcome` is a backend-supplied string that the interface DISPLAYS and never interprets:
 * whether a decision may be actioned is the server's verdict (`action.available`, `expired`), not something the browser derives from an outcome name.
 * (It also keeps approval-class vocabulary out of this package, so tests/unit/safety/stopLossCoverage.test.ts stays unchanged.)
 */
/** `PAPER_ORDER_STATES` in packages/database/src/schema/tradeExecution.ts. */
export const PAPER_ORDER_STATES = ["PROPOSED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type PaperOrderState = (typeof PAPER_ORDER_STATES)[number];
/** `POSITION_EVENT_KINDS` in packages/database/src/schema/tradeExecution.ts. */
export const POSITION_EVENT_KINDS = ["OPENED", "ENTRY_FILL", "PARTIAL_EXIT", "CLOSED", "STOP_MOVED", "TARGET_HIT", "STOP_HIT", "TIME_EXIT", "EXPIRY_EXIT", "RISK_BREACH", "PRICE_UNAVAILABLE", "RECONCILED", "RECONCILIATION_MISMATCH"] as const;
export type PositionEventKind = (typeof POSITION_EVENT_KINDS)[number];
export const POSITION_STATUSES = ["OPEN", "CLOSED"] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];
export const ORDER_PURPOSES = ["ENTRY", "EXIT"] as const;
export const SIDES = ["BUY", "SELL"] as const;
export type Side = (typeof SIDES)[number];

/** Provenance of an outcome attribution (`AttributionRow.dataSource`, packages/database/src/stores/outcomeStore.ts). */
export const DATA_SOURCES = ["FIXTURE", "LIVE", "HISTORICAL"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];
export const ATTRIBUTION_MODES = ["PAPER", "LIVE"] as const;
export const ATTRIBUTION_FINALITIES = ["PARTIAL", "FINAL"] as const;
/** Analytics `dataset` filter (overview only) and the `freshness` of a stored snapshot. */
export const ANALYTICS_DATASETS = ["ALL", "VALIDATED", "FIXTURE"] as const;
export type AnalyticsDataset = (typeof ANALYTICS_DATASETS)[number];
export const FRESHNESS = ["CURRENT", "STALE"] as const;
export type Freshness = (typeof FRESHNESS)[number];
/** The `state` field on analytics responses (`emptyState` in userApi.ts; insights use EMPTY or OK only). */
export const ANALYTICS_RESPONSE_STATES = ["EMPTY", "PARTIAL", "OK"] as const;
export type AnalyticsResponseState = (typeof ANALYTICS_RESPONSE_STATES)[number];
/** `liveStatus` on every analytics envelope: there is no live source, so the interface must never show a LIVE badge. */
export const LIVE_STATUS_UNAVAILABLE = "UNAVAILABLE" as const;
/** The one trading mode that exists (Paper Trading); every envelope reports it. */
export const PAPER_MODE = "PAPER" as const;
export const STRATEGY_DIMENSIONS = ["strategy", "version", "instrument", "timeframe", "regime", "exit", "stop", "target", "confidence", "risk", "plannedrr", "decision", "pattern"] as const;
export type StrategyDimension = (typeof STRATEGY_DIMENSIONS)[number];

/** FRONTEND vocabulary: the eight data states every region resolves to (docs/frontend/architecture.md §6). */
export const DATA_STATES = ["LOADING", "READY", "EMPTY", "STALE", "ERROR", "DENIED", "UNAVAILABLE", "PARTIAL"] as const;
export type DataState = (typeof DATA_STATES)[number];
/** FRONTEND vocabulary: how the interface labels where a figure comes from. LIVE exists in the vocabulary but is never rendered until a live source is verified. */
export const PROVENANCE_BADGES = ["FIXTURE", "PAPER", "LIVE", "UNAVAILABLE"] as const;
export type ProvenanceBadge = (typeof PROVENANCE_BADGES)[number];
/** FRONTEND vocabulary: availability of a capability. */
export const AVAILABILITY = ["AVAILABLE", "UNAVAILABLE", "PLANNED"] as const;
