import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { riskDecisions } from "./riskDecisions";

/**
 * Agent engine persistence (Stage 5 / Task 1): the registry snapshots, every orchestrator run, every agent run with its findings and evidence references, and the synthesis.
 * All six tables are APPEND-ONLY and HASH-CHAINED (chains 27-32; chain columns and guards are hand-written in migration 0025). An orchestrator run is written ONCE, complete (the
 * agents run in memory first); a different decision version, agent set, configuration or input is a different run. Nothing here creates a risk decision, approval, order or fill.
 */
const ACTOR = sql`'^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`;
const HEX = sql`'^[0-9a-f]{64}$'`;

export const agentDefinitions = pgTable(
  "agent_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    contract: jsonb("contract").notNull(),
    contractSha256: text("contract_sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    refUnique: uniqueIndex("agent_definitions_ref_unique").on(t.agentId, t.agentVersion, t.contractSha256),
    valueCheck: check("agent_definitions_value_check", sql`${t.agentId} ~ '^[a-z][a-z0-9_-]{2,40}$' and ${t.agentVersion} ~ '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$' and ${t.contractSha256} ~ ${HEX} and octet_length(${t.contract}::text) <= 16384`),
    actorCheck: check("agent_definitions_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const agentOrchestratorRuns = pgTable(
  "agent_orchestrator_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(decision version, agent set + versions, configuration, input snapshot): the same evaluation resolves to the same run. */
    runKey: text("run_key").notNull(),
    riskDecisionId: uuid("risk_decision_id").notNull().references(() => riskDecisions.id, { onDelete: "restrict" }),
    decisionVersion: integer("decision_version").notNull(),
    trigger: text("trigger").notNull(),
    triggerContext: jsonb("trigger_context").notNull(),
    agentSet: jsonb("agent_set").notNull(),
    config: jsonb("config").notNull(),
    configSha256: text("config_sha256").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    inputSha256: text("input_sha256").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("agent_orchestrator_runs_key_unique").on(t.runKey),
    decisionIdx: index("agent_orchestrator_runs_decision_idx").on(t.riskDecisionId),
    valueCheck: check("agent_orchestrator_runs_value_check", sql`${t.runKey} ~ ${HEX} and ${t.configSha256} ~ ${HEX} and ${t.inputSha256} ~ ${HEX} and ${t.status} in ('COMPLETED', 'INCOMPLETE', 'FAILED') and ${t.trigger} in ('WORKER_PIPELINE', 'OPERATOR') and ${t.durationMs} >= 0 and ${t.completedAt} >= ${t.startedAt} and ${t.decisionVersion} >= 1`),
    sizeCheck: check("agent_orchestrator_runs_size_check", sql`octet_length(${t.inputSnapshot}::text) <= 65536 and octet_length(${t.agentSet}::text) <= 8192 and octet_length(${t.config}::text) <= 8192 and octet_length(${t.triggerContext}::text) <= 4096`),
    actorCheck: check("agent_orchestrator_runs_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orchestratorRunId: uuid("orchestrator_run_id").notNull().references(() => agentOrchestratorRuns.id, { onDelete: "restrict" }),
    definitionId: uuid("definition_id").references(() => agentDefinitions.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    status: text("status").notNull(),
    verdict: text("verdict").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    attempts: integer("attempts").notNull(),
    inputSnapshotRef: text("input_snapshot_ref").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    outputSnapshot: jsonb("output_snapshot").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runAgentUnique: uniqueIndex("agent_runs_run_agent_unique").on(t.orchestratorRunId, t.agentId),
    agentIdx: index("agent_runs_agent_idx").on(t.agentId, t.agentVersion),
    statusCheck: check("agent_runs_status_check", sql`${t.status} in ('COMPLETED', 'FAILED', 'TIMEOUT', 'SKIPPED', 'UNAVAILABLE') and ${t.verdict} in ('SUPPORTIVE', 'NEUTRAL', 'CAUTION', 'ADVERSE', 'BLOCKING', 'UNAVAILABLE') and ${t.attempts} between 0 and 5 and ${t.durationMs} >= 0 and ${t.completedAt} >= ${t.startedAt}`),
    coherenceCheck: check("agent_runs_coherence_check", sql`((${t.status} = 'COMPLETED') = (${t.verdict} <> 'UNAVAILABLE')) and ((${t.status} = 'COMPLETED') = (${t.confidence} is not null)) and (${t.confidence} is null or ${t.confidence} between 0 and 100) and (${t.status} in ('COMPLETED', 'UNAVAILABLE') or ${t.errorCode} is not null)`),
    valueCheck: check("agent_runs_value_check", sql`${t.agentId} ~ '^[a-z][a-z0-9_-]{2,40}$' and ${t.inputSnapshotRef} ~ ${HEX} and (${t.errorCode} is null or ${t.errorCode} ~ '^[A-Z][A-Z0-9_]{2,60}$') and (${t.errorMessage} is null or char_length(${t.errorMessage}) <= 300) and octet_length(${t.inputSnapshot}::text) <= 65536 and octet_length(${t.outputSnapshot}::text) <= 16384`),
    actorCheck: check("agent_runs_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const agentFindings = pgTable(
  "agent_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id").notNull().references(() => agentRuns.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    summary: text("summary").notNull(),
    detail: jsonb("detail").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUnique: uniqueIndex("agent_findings_ordinal_unique").on(t.agentRunId, t.ordinal),
    valueCheck: check("agent_findings_value_check", sql`${t.code} ~ '^[A-Z][A-Z0-9_]{2,60}$' and ${t.severity} in ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL') and char_length(${t.summary}) <= 300 and ${t.ordinal} >= 0 and octet_length(${t.detail}::text) <= 2048`),
    actorCheck: check("agent_findings_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const agentEvidenceReferences = pgTable(
  "agent_evidence_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id").notNull().references(() => agentRuns.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    refSha256: text("ref_sha256"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUnique: uniqueIndex("agent_evidence_references_ordinal_unique").on(t.agentRunId, t.ordinal),
    valueCheck: check("agent_evidence_references_value_check", sql`${t.kind} ~ '^[a-z][a-z0-9_]{1,30}$' and ${t.ref} ~ '^[A-Za-z0-9_.:/#@=-]{1,200}$' and (${t.refSha256} is null or ${t.refSha256} ~ ${HEX}) and ${t.ordinal} >= 0`),
    actorCheck: check("agent_evidence_references_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const agentOrchestratorSyntheses = pgTable(
  "agent_orchestrator_syntheses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orchestratorRunId: uuid("orchestrator_run_id").notNull().references(() => agentOrchestratorRuns.id, { onDelete: "restrict" }),
    assessment: text("assessment").notNull(),
    score: numeric("score", { precision: 9, scale: 6 }),
    algorithmVersion: text("algorithm_version").notNull(),
    synthesisInput: jsonb("synthesis_input").notNull(),
    synthesisInputSha256: text("synthesis_input_sha256").notNull(),
    result: jsonb("result").notNull(),
    /** Always false: a research assessment is never an approval. */
    grantsApproval: boolean("grants_approval").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runUnique: uniqueIndex("agent_orchestrator_syntheses_run_unique").on(t.orchestratorRunId),
    valueCheck: check("agent_orchestrator_syntheses_value_check", sql`${t.assessment} in ('RESEARCH_SUPPORTIVE', 'RESEARCH_NEUTRAL', 'RESEARCH_CAUTION', 'RESEARCH_ADVERSE', 'RESEARCH_BLOCKED', 'RESEARCH_INCOMPLETE') and ${t.synthesisInputSha256} ~ ${HEX} and (${t.score} is null or ${t.score} between -1 and 1) and octet_length(${t.synthesisInput}::text) <= 32768 and octet_length(${t.result}::text) <= 32768`),
    noApprovalCheck: check("agent_orchestrator_syntheses_no_approval_check", sql`${t.grantsApproval} = false`),
    actorCheck: check("agent_orchestrator_syntheses_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);
