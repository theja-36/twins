import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { optionsClaims } from "./optionsClaims";
import { telegramSources } from "./telegram";

/**
 * Shared platform intelligence (no user_id): classifications, market regimes, playbooks, opportunity candidates and research packages (Master Build Stage 02).
 * Both pipelines write the SAME candidate table: a candidate is either TELEGRAM (references a stored claim) or INDEPENDENT (references the scan that found it), never both.
 * `data_source` records FIXTURE / LIVE / HISTORICAL so simulated data can never be mistaken for real data downstream.
 */
export const SIGNAL_TYPES = ["OPTIONS_BUY", "OPTIONS_SELL", "FUTURES", "EQUITY", "UPDATE", "UNKNOWN"] as const;
export const HORIZONS = ["INTRADAY", "POSITIONAL", "SCALPING", "UNKNOWN"] as const;
export const SETUPS = ["BREAKOUT", "REVERSAL", "MOMENTUM", "GAP", "SCALP", "OTHER", "UNKNOWN"] as const;
export const RISK_PROFILES = ["CONSERVATIVE", "MODERATE", "AGGRESSIVE", "UNKNOWN"] as const;
export const DATA_SOURCES = ["FIXTURE", "LIVE", "HISTORICAL"] as const;

export const signalClassifications = pgTable("signal_classifications", {
  id: idColumn(),
  claimId: uuid("claim_id").notNull().references(() => optionsClaims.id, { onDelete: "restrict" }),
  signalType: text("signal_type").notNull(),
  horizon: text("horizon").notNull(),
  setup: text("setup").notNull(),
  riskProfile: text("risk_profile").notNull().default("UNKNOWN"),
  entryCondition: jsonb("entry_condition"),
  exitPattern: jsonb("exit_pattern"),
  structureValid: boolean("structure_valid").notNull(),
  confidence: numeric("confidence"),
  classifierVersion: text("classifier_version").notNull(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perVersion: uniqueIndex("signal_classifications_claim_version_unique").on(t.claimId, t.classifierVersion),
  typeCheck: check("signal_classifications_type_check", oneOf(t.signalType, SIGNAL_TYPES)),
  horizonCheck: check("signal_classifications_horizon_check", oneOf(t.horizon, HORIZONS)),
  setupCheck: check("signal_classifications_setup_check", oneOf(t.setup, SETUPS)),
  riskCheck: check("signal_classifications_risk_check", oneOf(t.riskProfile, RISK_PROFILES)),
  confidenceCheck: check("signal_classifications_confidence_check", sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`),
}));

export const REGIMES = ["TRENDING_UP", "TRENDING_DOWN", "RANGE_BOUND", "HIGH_VOLATILITY", "LOW_VOLATILITY", "RISK_OFF", "UNKNOWN"] as const;
export const marketRegimes = pgTable("market_regimes", {
  id: idColumn(),
  underlying: text("underlying").notNull(),
  timeframe: text("timeframe").notNull(),
  direction: text("direction").notNull(),
  regime: text("regime").notNull(),
  volatilityRegime: text("volatility_regime").notNull().default("UNKNOWN"),
  impliedVolatility: numeric("implied_volatility"),
  eventRisk: text("event_risk").notNull().default("UNKNOWN"),
  evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
  detectorVersion: text("detector_version").notNull(),
  dataSource: text("data_source").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  perObservation: uniqueIndex("market_regimes_observation_unique").on(t.underlying, t.timeframe, t.asOf, t.detectorVersion, t.dataSource),
  latestIdx: index("market_regimes_latest_idx").on(t.underlying, t.timeframe, t.asOf),
  timeframeCheck: check("market_regimes_timeframe_check", oneOf(t.timeframe, ["5m", "15m", "1h", "1d"])),
  directionCheck: check("market_regimes_direction_check", oneOf(t.direction, ["BULLISH", "BEARISH", "NEUTRAL", "UNKNOWN"])),
  regimeCheck: check("market_regimes_regime_check", oneOf(t.regime, REGIMES)),
  volCheck: check("market_regimes_vol_check", oneOf(t.volatilityRegime, ["LOW", "NORMAL", "HIGH", "EXTREME", "UNKNOWN"])),
  eventCheck: check("market_regimes_event_check", oneOf(t.eventRisk, ["NONE", "LOW", "ELEVATED", "HIGH", "UNKNOWN"])),
  sourceCheck: check("market_regimes_source_check", oneOf(t.dataSource, DATA_SOURCES)),
}));

export const PLAYBOOK_STATES = ["DRAFT", "EVALUATING", "ACTIVE", "RETIRED", "ROLLED_BACK"] as const;
/** A playbook belongs to a Telegram channel or is platform-owned (independent). Its content lives in append-only-style numbered versions; only a version's `state` moves. */
export const strategyPlaybooks = pgTable("strategy_playbooks", {
  id: idColumn(),
  sourceKind: text("source_kind").notNull(),
  telegramSourceId: uuid("telegram_source_id").references(() => telegramSources.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  perSource: uniqueIndex("strategy_playbooks_source_name_unique").on(t.telegramSourceId, t.name),
  independentName: uniqueIndex("strategy_playbooks_independent_name_unique").on(t.name).where(sql`${t.telegramSourceId} is null`),
  kindCheck: check("strategy_playbooks_kind_check", oneOf(t.sourceKind, ["TELEGRAM_CHANNEL", "INDEPENDENT"])),
  ownerCheck: check("strategy_playbooks_owner_check", sql`(${t.sourceKind} = 'TELEGRAM_CHANNEL' and ${t.telegramSourceId} is not null) or (${t.sourceKind} = 'INDEPENDENT' and ${t.telegramSourceId} is null)`),
}));

export const playbookVersions = pgTable("playbook_versions", {
  id: idColumn(),
  playbookId: uuid("playbook_id").notNull().references(() => strategyPlaybooks.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  state: text("state").notNull().default("DRAFT"),
  /** description, entry context, entry/exit/stop/target/risk rules, preferred instruments and regimes, limitations (spec Module 06). */
  content: jsonb("content").notNull(),
  performance: jsonb("performance"),
  sampleSize: integer("sample_size").notNull().default(0),
  confidence: numeric("confidence"),
  limitations: text("limitations").notNull().default(""),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  versionUnique: uniqueIndex("playbook_versions_unique").on(t.playbookId, t.version),
  /** At most one ACTIVE version per playbook (migration 0034): activating a new version retires the previous one in the same transaction. */
  oneActive: uniqueIndex("playbook_versions_one_active").on(t.playbookId).where(sql`${t.state} = 'ACTIVE'`),
  stateCheck: check("playbook_versions_state_check", oneOf(t.state, PLAYBOOK_STATES)),
  versionCheck: check("playbook_versions_version_check", sql`${t.version} >= 1 and ${t.sampleSize} >= 0`),
  /** Learning must be evaluated before it can influence live policy: ACTIVE requires recorded performance and a sample. */
  activeNeedsEvidence: check("playbook_versions_active_evidence_check", sql`${t.state} <> 'ACTIVE' or (${t.performance} is not null and ${t.sampleSize} > 0)`),
}));

export const strategyDriftEvents = pgTable("strategy_drift_events", {
  id: idColumn(),
  playbookId: uuid("playbook_id").notNull().references(() => strategyPlaybooks.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  kind: text("kind").notNull(),
  metric: text("metric").notNull(),
  baseline: numeric("baseline").notNull(),
  observed: numeric("observed").notNull(),
  details: jsonb("details"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindCheck: check("strategy_drift_events_kind_check", oneOf(t.kind, ["DRIFT", "DEGRADATION"])),
  idx: index("strategy_drift_events_playbook_idx").on(t.playbookId, t.detectedAt),
}));

export const opportunityScans = pgTable("opportunity_scans", {
  id: idColumn(),
  scanKind: text("scan_kind").notNull(),
  parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
  detectorVersion: text("detector_version").notNull(),
  dataSource: text("data_source").notNull(),
  status: text("status").notNull().default("RUNNING"),
  candidateCount: integer("candidate_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Stage 05: identifies the scheduled slot (for example 2031-01-05T09:45Z), so one slot is scanned once however many times the job is delivered. */
  slotKey: text("slot_key"),
  universeSize: integer("universe_size").notNull().default(0),
  /** Underlyings that were not scanned and why (no data, stale, ineligible, malformed): a skipped instrument is recorded, never silently dropped. */
  skipped: jsonb("skipped").notNull().default(sql`'[]'::jsonb`),
  errorKind: text("error_kind"),
}, (t) => ({
  slotUnique: uniqueIndex("opportunity_scans_slot_unique").on(t.scanKind, t.slotKey),
  statusCheck: check("opportunity_scans_status_check", oneOf(t.status, ["RUNNING", "COMPLETED", "FAILED"])),
  sourceCheck: check("opportunity_scans_source_check", oneOf(t.dataSource, DATA_SOURCES)),
  countCheck: check("opportunity_scans_count_check", sql`${t.candidateCount} >= 0`),
}));

export const CANDIDATE_STATE_VALUES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"] as const;
export const CANDIDATE_TERMINAL_STATES = ["EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"] as const;
export const opportunityCandidates = pgTable("opportunity_candidates", {
  id: idColumn(),
  source: text("source").notNull(),
  state: text("state").notNull().default("NEW"),
  claimId: uuid("claim_id").references(() => optionsClaims.id, { onDelete: "restrict" }),
  scanId: uuid("scan_id").references(() => opportunityScans.id, { onDelete: "restrict" }),
  underlying: text("underlying").notNull(),
  exchange: text("exchange").notNull().default("NSE"),
  strike: numeric("strike"),
  optionType: text("option_type"),
  expiry: date("expiry"),
  side: text("side").notNull(),
  entryKind: text("entry_kind").notNull(),
  entryLow: numeric("entry_low"),
  entryHigh: numeric("entry_high"),
  stopLoss: numeric("stop_loss"),
  targets: jsonb("targets").notNull().default(sql`'[]'::jsonb`),
  setup: text("setup"),
  classificationConfidence: numeric("classification_confidence"),
  evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
  dataSource: text("data_source").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  createdAt: createdAtColumn(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: updatedAtColumn(),
  /** Stage 05. Identity of the setup (underlying, setup, side, signal bar, detector version): the same setup found twice is one candidate. Null for Telegram candidates (they are unique per claim). */
  dedupeKey: text("dedupe_key"),
  /** The condition that voids the setup (a price beyond which the thesis is wrong). Evidence for revalidation; never an order. */
  invalidation: jsonb("invalidation"),
  supersededBy: uuid("superseded_by"),
  stateReason: text("state_reason"),
  researchAttempts: integer("research_attempts").notNull().default(0),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  /** Deterministic ordering score (higher is better). A priority for review, NOT a probability and NOT permission to act. Null when not ranked. */
  rankScore: numeric("rank_score"),
}, (t) => ({
  dedupeUnique: uniqueIndex("opportunity_candidates_dedupe_unique").on(t.dedupeKey),
  supersededFk: foreignKey({ name: "opp_candidates_superseded_by_fk", columns: [t.supersededBy], foreignColumns: [t.id] }).onDelete("restrict"),
  attemptsCheck: check("opportunity_candidates_attempts_check", sql`${t.researchAttempts} >= 0`),
  onePerClaim: uniqueIndex("opportunity_candidates_claim_unique").on(t.claimId),
  stateIdx: index("opportunity_candidates_state_idx").on(t.state, t.expiresAt),
  sourceIdx: index("opportunity_candidates_source_idx").on(t.source, t.createdAt),
  sourceCheck: check("opportunity_candidates_source_check", oneOf(t.source, ["TELEGRAM", "INDEPENDENT"])),
  stateCheck: check("opportunity_candidates_state_check", oneOf(t.state, CANDIDATE_STATE_VALUES)),
  originCheck: check("opportunity_candidates_origin_check", sql`(${t.source} = 'TELEGRAM' and ${t.claimId} is not null and ${t.scanId} is null) or (${t.source} = 'INDEPENDENT' and ${t.scanId} is not null and ${t.claimId} is null)`),
  sideCheck: check("opportunity_candidates_side_check", oneOf(t.side, ["BUY", "SELL"])),
  optionCheck: check("opportunity_candidates_option_check", sql`${t.optionType} is null or ${t.optionType} in ('CE', 'PE')`),
  entryCheck: check("opportunity_candidates_entry_check", oneOf(t.entryKind, ["above", "below", "at", "range", "market"])),
  sourceDataCheck: check("opportunity_candidates_data_source_check", oneOf(t.dataSource, DATA_SOURCES)),
  expiryCheck: check("opportunity_candidates_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
}));

/** Append-only lifecycle history of a candidate; written by a trigger on opportunity_candidates so a state change cannot skip the audit. */
export const opportunityCandidateEvents = pgTable("opportunity_candidate_events", {
  id: idColumn(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("opportunity_candidate_events_candidate_idx").on(t.candidateId, t.occurredAt),
  toCheck: check("opportunity_candidate_events_to_check", oneOf(t.toState, CANDIDATE_STATE_VALUES)),
}));

export const researchPackages = pgTable("research_packages", {
  id: idColumn(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  /** one entry per agent: verdict (spec vocabulary), evidence references, risk flags, status */
  agentResults: jsonb("agent_results").notNull(),
  assessment: text("assessment").notNull(),
  haltReason: text("halt_reason"),
  createdAt: createdAtColumn(),
}, (t) => ({
  versionUnique: uniqueIndex("research_packages_candidate_version_unique").on(t.candidateId, t.version),
  versionCheck: check("research_packages_version_check", sql`${t.version} >= 1`),
  assessmentCheck: check("research_packages_assessment_check", oneOf(t.assessment, ["RESEARCH_SUPPORTIVE", "RESEARCH_NEUTRAL", "RESEARCH_CAUTION", "RESEARCH_ADVERSE", "RESEARCH_INCOMPLETE", "RESEARCH_BLOCKED"])),
}));
