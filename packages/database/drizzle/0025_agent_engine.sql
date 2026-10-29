CREATE TABLE "agent_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"contract_version" text NOT NULL,
	"contract" jsonb NOT NULL,
	"contract_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_definitions_value_check" CHECK ("agent_definitions"."agent_id" ~ '^[a-z][a-z0-9_]{2,40}$' and "agent_definitions"."agent_version" ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' and "agent_definitions"."contract_sha256" ~ '^[0-9a-f]{64}$' and octet_length("agent_definitions"."contract"::text) <= 16384),
	CONSTRAINT "agent_definitions_actor_check" CHECK ("agent_definitions"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "agent_evidence_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"ref_sha256" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_evidence_references_value_check" CHECK ("agent_evidence_references"."kind" ~ '^[a-z][a-z0-9_]{1,30}$' and "agent_evidence_references"."ref" ~ '^[A-Za-z0-9_.:/#@=-]{1,200}$' and ("agent_evidence_references"."ref_sha256" is null or "agent_evidence_references"."ref_sha256" ~ '^[0-9a-f]{64}$') and "agent_evidence_references"."ordinal" >= 0),
	CONSTRAINT "agent_evidence_references_actor_check" CHECK ("agent_evidence_references"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "agent_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_findings_value_check" CHECK ("agent_findings"."code" ~ '^[A-Z][A-Z0-9_]{2,60}$' and "agent_findings"."severity" in ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL') and char_length("agent_findings"."summary") <= 300 and "agent_findings"."ordinal" >= 0 and octet_length("agent_findings"."detail"::text) <= 2048),
	CONSTRAINT "agent_findings_actor_check" CHECK ("agent_findings"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "agent_orchestrator_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"risk_decision_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"trigger" text NOT NULL,
	"trigger_context" jsonb NOT NULL,
	"agent_set" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_sha256" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_orchestrator_runs_value_check" CHECK ("agent_orchestrator_runs"."run_key" ~ '^[0-9a-f]{64}$' and "agent_orchestrator_runs"."config_sha256" ~ '^[0-9a-f]{64}$' and "agent_orchestrator_runs"."input_sha256" ~ '^[0-9a-f]{64}$' and "agent_orchestrator_runs"."status" in ('COMPLETED', 'INCOMPLETE', 'FAILED') and "agent_orchestrator_runs"."trigger" in ('WORKER_PIPELINE', 'OPERATOR') and "agent_orchestrator_runs"."duration_ms" >= 0 and "agent_orchestrator_runs"."completed_at" >= "agent_orchestrator_runs"."started_at" and "agent_orchestrator_runs"."decision_version" >= 1),
	CONSTRAINT "agent_orchestrator_runs_size_check" CHECK (octet_length("agent_orchestrator_runs"."input_snapshot"::text) <= 65536 and octet_length("agent_orchestrator_runs"."agent_set"::text) <= 8192 and octet_length("agent_orchestrator_runs"."config"::text) <= 8192 and octet_length("agent_orchestrator_runs"."trigger_context"::text) <= 4096),
	CONSTRAINT "agent_orchestrator_runs_actor_check" CHECK ("agent_orchestrator_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "agent_orchestrator_syntheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestrator_run_id" uuid NOT NULL,
	"assessment" text NOT NULL,
	"score" numeric(9, 6),
	"algorithm_version" text NOT NULL,
	"synthesis_input" jsonb NOT NULL,
	"synthesis_input_sha256" text NOT NULL,
	"result" jsonb NOT NULL,
	"grants_approval" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_orchestrator_syntheses_value_check" CHECK ("agent_orchestrator_syntheses"."assessment" in ('RESEARCH_SUPPORTIVE', 'RESEARCH_NEUTRAL', 'RESEARCH_CAUTION', 'RESEARCH_ADVERSE', 'RESEARCH_BLOCKED', 'RESEARCH_INCOMPLETE') and "agent_orchestrator_syntheses"."synthesis_input_sha256" ~ '^[0-9a-f]{64}$' and ("agent_orchestrator_syntheses"."score" is null or "agent_orchestrator_syntheses"."score" between -1 and 1) and octet_length("agent_orchestrator_syntheses"."synthesis_input"::text) <= 32768 and octet_length("agent_orchestrator_syntheses"."result"::text) <= 32768),
	CONSTRAINT "agent_orchestrator_syntheses_no_approval_check" CHECK ("agent_orchestrator_syntheses"."grants_approval" = false),
	CONSTRAINT "agent_orchestrator_syntheses_actor_check" CHECK ("agent_orchestrator_syntheses"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestrator_run_id" uuid NOT NULL,
	"definition_id" uuid,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"status" text NOT NULL,
	"verdict" text NOT NULL,
	"confidence" numeric(5, 2),
	"attempts" integer NOT NULL,
	"input_snapshot_ref" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('COMPLETED', 'FAILED', 'TIMEOUT', 'SKIPPED', 'UNAVAILABLE') and "agent_runs"."verdict" in ('SUPPORTIVE', 'NEUTRAL', 'CAUTION', 'ADVERSE', 'BLOCKING', 'UNAVAILABLE') and "agent_runs"."attempts" between 0 and 5 and "agent_runs"."duration_ms" >= 0 and "agent_runs"."completed_at" >= "agent_runs"."started_at"),
	CONSTRAINT "agent_runs_coherence_check" CHECK ((("agent_runs"."status" = 'COMPLETED') = ("agent_runs"."verdict" <> 'UNAVAILABLE')) and (("agent_runs"."status" = 'COMPLETED') = ("agent_runs"."confidence" is not null)) and ("agent_runs"."confidence" is null or "agent_runs"."confidence" between 0 and 100) and ("agent_runs"."status" in ('COMPLETED', 'UNAVAILABLE') or "agent_runs"."error_code" is not null)),
	CONSTRAINT "agent_runs_value_check" CHECK ("agent_runs"."agent_id" ~ '^[a-z][a-z0-9_]{2,40}$' and "agent_runs"."input_snapshot_ref" ~ '^[0-9a-f]{64}$' and ("agent_runs"."error_code" is null or "agent_runs"."error_code" ~ '^[A-Z][A-Z0-9_]{2,60}$') and ("agent_runs"."error_message" is null or char_length("agent_runs"."error_message") <= 300) and octet_length("agent_runs"."input_snapshot"::text) <= 65536 and octet_length("agent_runs"."output_snapshot"::text) <= 16384),
	CONSTRAINT "agent_runs_actor_check" CHECK ("agent_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "agent_evidence_references" ADD CONSTRAINT "agent_evidence_references_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_orchestrator_runs" ADD CONSTRAINT "agent_orchestrator_runs_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_orchestrator_syntheses" ADD CONSTRAINT "agent_orchestrator_syntheses_orchestrator_run_id_agent_orchestrator_runs_id_fk" FOREIGN KEY ("orchestrator_run_id") REFERENCES "public"."agent_orchestrator_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_orchestrator_run_id_agent_orchestrator_runs_id_fk" FOREIGN KEY ("orchestrator_run_id") REFERENCES "public"."agent_orchestrator_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_definition_id_agent_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definitions_ref_unique" ON "agent_definitions" USING btree ("agent_id","agent_version","contract_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evidence_references_ordinal_unique" ON "agent_evidence_references" USING btree ("agent_run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_findings_ordinal_unique" ON "agent_findings" USING btree ("agent_run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_orchestrator_runs_key_unique" ON "agent_orchestrator_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "agent_orchestrator_runs_decision_idx" ON "agent_orchestrator_runs" USING btree ("risk_decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_orchestrator_syntheses_run_unique" ON "agent_orchestrator_syntheses" USING btree ("orchestrator_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_run_agent_unique" ON "agent_runs" USING btree ("orchestrator_run_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "agent_runs" USING btree ("agent_id","agent_version");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 5 / Task 1: agent engine. Registry snapshots, orchestrator runs, agent runs, findings, evidence references and
-- syntheses are immutable and hash-chained (chains 27-32). A synthesis can never grant approval (check constraint). Nothing is edited: a different input or configuration is a different run.
ALTER TABLE "agent_definitions" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definitions_chain_index_unique" ON "agent_definitions" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_definitions"(r "agent_definitions") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.agent_id, r.agent_version, r.contract_version, r.contract::text, r.contract_sha256, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_definitions_chain_before_insert" BEFORE INSERT ON "agent_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_definitions');--> statement-breakpoint
CREATE TRIGGER "agent_definitions_chain_after_insert" AFTER INSERT ON "agent_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_definitions');--> statement-breakpoint
CREATE TRIGGER "agent_definitions_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_definitions_no_truncate" BEFORE TRUNCATE ON "agent_definitions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_orchestrator_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_orchestrator_runs" ADD CONSTRAINT "agent_orchestrator_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_orchestrator_runs_chain_index_unique" ON "agent_orchestrator_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_orchestrator_runs"(r "agent_orchestrator_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_key, r.risk_decision_id::text, r.decision_version::text, r.trigger, r.trigger_context::text, r.agent_set::text, r.config::text, r.config_sha256, r.input_snapshot::text, r.input_sha256, r.status, twins_audit_ts(r.started_at), twins_audit_ts(r.completed_at), r.duration_ms::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_runs_chain_before_insert" BEFORE INSERT ON "agent_orchestrator_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_orchestrator_runs');--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_runs_chain_after_insert" AFTER INSERT ON "agent_orchestrator_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_orchestrator_runs');--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_orchestrator_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_runs_no_truncate" BEFORE TRUNCATE ON "agent_orchestrator_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_chain_index_unique" ON "agent_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_runs"(r "agent_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.orchestrator_run_id::text, r.definition_id::text, r.agent_id, r.agent_version, r.status, r.verdict, r.confidence::text, r.attempts::text, r.input_snapshot_ref, r.input_snapshot::text, r.output_snapshot::text, twins_audit_ts(r.started_at), twins_audit_ts(r.completed_at), r.duration_ms::text, r.error_code, r.error_message, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_runs_chain_before_insert" BEFORE INSERT ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_runs');--> statement-breakpoint
CREATE TRIGGER "agent_runs_chain_after_insert" AFTER INSERT ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_runs');--> statement-breakpoint
CREATE TRIGGER "agent_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_runs_no_truncate" BEFORE TRUNCATE ON "agent_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_findings" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_findings_chain_index_unique" ON "agent_findings" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_findings"(r "agent_findings") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.agent_run_id::text, r.ordinal::text, r.code, r.severity, r.summary, r.detail::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_findings_chain_before_insert" BEFORE INSERT ON "agent_findings" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_findings');--> statement-breakpoint
CREATE TRIGGER "agent_findings_chain_after_insert" AFTER INSERT ON "agent_findings" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_findings');--> statement-breakpoint
CREATE TRIGGER "agent_findings_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_findings" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_findings_no_truncate" BEFORE TRUNCATE ON "agent_findings" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_evidence_references" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_evidence_references" ADD CONSTRAINT "agent_evidence_references_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evidence_references_chain_index_unique" ON "agent_evidence_references" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_evidence_references"(r "agent_evidence_references") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.agent_run_id::text, r.ordinal::text, r.kind, r.ref, r.ref_sha256, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_evidence_references_chain_before_insert" BEFORE INSERT ON "agent_evidence_references" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_evidence_references');--> statement-breakpoint
CREATE TRIGGER "agent_evidence_references_chain_after_insert" AFTER INSERT ON "agent_evidence_references" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_evidence_references');--> statement-breakpoint
CREATE TRIGGER "agent_evidence_references_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_evidence_references" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_evidence_references_no_truncate" BEFORE TRUNCATE ON "agent_evidence_references" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_orchestrator_syntheses" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_orchestrator_syntheses" ADD CONSTRAINT "agent_orchestrator_syntheses_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_orchestrator_syntheses_chain_index_unique" ON "agent_orchestrator_syntheses" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_agent_orchestrator_syntheses"(r "agent_orchestrator_syntheses") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.orchestrator_run_id::text, r.assessment, r.score::text, r.algorithm_version, r.synthesis_input::text, r.synthesis_input_sha256, r.result::text, r.grants_approval::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_syntheses_chain_before_insert" BEFORE INSERT ON "agent_orchestrator_syntheses" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('agent_orchestrator_syntheses');--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_syntheses_chain_after_insert" AFTER INSERT ON "agent_orchestrator_syntheses" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('agent_orchestrator_syntheses');--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_syntheses_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_orchestrator_syntheses" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "agent_orchestrator_syntheses_no_truncate" BEFORE TRUNCATE ON "agent_orchestrator_syntheses" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "agent_definitions" ENABLE ALWAYS TRIGGER "agent_definitions_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_definitions_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_definitions_no_update_delete", ENABLE ALWAYS TRIGGER "agent_definitions_no_truncate";--> statement-breakpoint
ALTER TABLE "agent_orchestrator_runs" ENABLE ALWAYS TRIGGER "agent_orchestrator_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_orchestrator_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_orchestrator_runs_no_update_delete", ENABLE ALWAYS TRIGGER "agent_orchestrator_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ALWAYS TRIGGER "agent_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_runs_no_update_delete", ENABLE ALWAYS TRIGGER "agent_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "agent_findings" ENABLE ALWAYS TRIGGER "agent_findings_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_findings_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_findings_no_update_delete", ENABLE ALWAYS TRIGGER "agent_findings_no_truncate";--> statement-breakpoint
ALTER TABLE "agent_evidence_references" ENABLE ALWAYS TRIGGER "agent_evidence_references_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_evidence_references_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_evidence_references_no_update_delete", ENABLE ALWAYS TRIGGER "agent_evidence_references_no_truncate";--> statement-breakpoint
ALTER TABLE "agent_orchestrator_syntheses" ENABLE ALWAYS TRIGGER "agent_orchestrator_syntheses_chain_before_insert", ENABLE ALWAYS TRIGGER "agent_orchestrator_syntheses_chain_after_insert", ENABLE ALWAYS TRIGGER "agent_orchestrator_syntheses_no_update_delete", ENABLE ALWAYS TRIGGER "agent_orchestrator_syntheses_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals', 'historical_source_records', 'historical_datasets', 'historical_evaluation_runs', 'historical_outcome_labels', 'historical_evaluation_events', 'historical_source_registry', 'historical_scorecard_runs', 'historical_scorecard_metrics', 'historical_trust_tiers', 'historical_scorecard_events', 'historical_pattern_definitions', 'historical_pattern_runs', 'historical_pattern_snapshots', 'historical_confidence_runs', 'historical_confidence_estimates', 'agent_definitions', 'agent_orchestrator_runs', 'agent_runs', 'agent_findings', 'agent_evidence_references', 'agent_orchestrator_syntheses'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('agent_definitions', 0, repeat('0', 64)), ('agent_orchestrator_runs', 0, repeat('0', 64)), ('agent_runs', 0, repeat('0', 64)), ('agent_findings', 0, repeat('0', 64)), ('agent_evidence_references', 0, repeat('0', 64)), ('agent_orchestrator_syntheses', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";
