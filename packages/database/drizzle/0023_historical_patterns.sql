CREATE TABLE "historical_confidence_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"normalized_record_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"tier" text NOT NULL,
	"evidence_quality" text NOT NULL,
	"sample_size" integer NOT NULL,
	"pattern_refs" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"limitations" jsonb NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_confidence_estimates_tier_check" CHECK ("historical_confidence_estimates"."tier" in ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN') and "historical_confidence_estimates"."score" between 0 and 100 and (("historical_confidence_estimates"."tier" = 'UNKNOWN') = ("historical_confidence_estimates"."score" = 0)) and "historical_confidence_estimates"."sample_size" >= 0),
	CONSTRAINT "historical_confidence_estimates_quality_check" CHECK ("historical_confidence_estimates"."evidence_quality" in ('SUFFICIENT', 'LOW_QUALITY_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'NO_MATCH', 'NO_LIBRARY')),
	CONSTRAINT "historical_confidence_estimates_size_check" CHECK (octet_length("historical_confidence_estimates"."inputs"::text) <= 8192 and octet_length("historical_confidence_estimates"."explanation"::text) <= 8192 and octet_length("historical_confidence_estimates"."pattern_refs"::text) <= 8192 and octet_length("historical_confidence_estimates"."evidence_references"::text) <= 8192),
	CONSTRAINT "historical_confidence_estimates_actor_check" CHECK ("historical_confidence_estimates"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_confidence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"pattern_run_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"import_batch_id" uuid,
	"normalized_record_id" uuid,
	"algorithm_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"trust_mode" text NOT NULL,
	"lookahead" boolean NOT NULL,
	"input_summary" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_confidence_runs_scope_check" CHECK ((("historical_confidence_runs"."scope" = 'BATCH' and "historical_confidence_runs"."import_batch_id" is not null and "historical_confidence_runs"."normalized_record_id" is null) or ("historical_confidence_runs"."scope" = 'RECORD' and "historical_confidence_runs"."normalized_record_id" is not null and "historical_confidence_runs"."import_batch_id" is null)) and "historical_confidence_runs"."trust_mode" in ('point_in_time', 'latest')),
	CONSTRAINT "historical_confidence_runs_hash_check" CHECK ("historical_confidence_runs"."run_key" ~ '^[0-9a-f]{64}$' and "historical_confidence_runs"."config_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_confidence_runs_actor_check" CHECK ("historical_confidence_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_pattern_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern_key" text NOT NULL,
	"key_text" text NOT NULL,
	"level" integer NOT NULL,
	"features" jsonb NOT NULL,
	"definition_version" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_pattern_definitions_level_check" CHECK ("historical_pattern_definitions"."pattern_key" ~ '^[0-9a-f]{64}$' and "historical_pattern_definitions"."level" between 1 and 4 and char_length("historical_pattern_definitions"."key_text") between 1 and 400),
	CONSTRAINT "historical_pattern_definitions_actor_check" CHECK ("historical_pattern_definitions"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_pattern_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"embargo_cutoff" timestamp with time zone NOT NULL,
	"label_set_sha256" text NOT NULL,
	"input_summary" jsonb NOT NULL,
	"pattern_count" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_pattern_runs_hash_check" CHECK ("historical_pattern_runs"."run_key" ~ '^[0-9a-f]{64}$' and "historical_pattern_runs"."config_sha256" ~ '^[0-9a-f]{64}$' and "historical_pattern_runs"."label_set_sha256" ~ '^[0-9a-f]{64}$' and "historical_pattern_runs"."pattern_count" >= 0 and "historical_pattern_runs"."embargo_cutoff" <= "historical_pattern_runs"."as_of"),
	CONSTRAINT "historical_pattern_runs_size_check" CHECK (octet_length("historical_pattern_runs"."input_summary"::text) <= 65536),
	CONSTRAINT "historical_pattern_runs_actor_check" CHECK ("historical_pattern_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_pattern_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"evidence_status" text NOT NULL,
	"flags" jsonb NOT NULL,
	"sample_size" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"mixes" jsonb NOT NULL,
	"first_observed" timestamp with time zone,
	"last_observed" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_pattern_snapshots_status_check" CHECK ("historical_pattern_snapshots"."evidence_status" in ('SUFFICIENT', 'INSUFFICIENT_EVIDENCE', 'LOW_QUALITY_EVIDENCE') and "historical_pattern_snapshots"."sample_size" >= 0 and "historical_pattern_snapshots"."level" between 1 and 4),
	CONSTRAINT "historical_pattern_snapshots_size_check" CHECK (octet_length("historical_pattern_snapshots"."metrics"::text) <= 16384 and octet_length("historical_pattern_snapshots"."mixes"::text) <= 4096),
	CONSTRAINT "historical_pattern_snapshots_actor_check" CHECK ("historical_pattern_snapshots"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ADD CONSTRAINT "historical_confidence_estimates_run_id_historical_confidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_confidence_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ADD CONSTRAINT "historical_confidence_estimates_normalized_record_id_historical_normalized_records_id_fk" FOREIGN KEY ("normalized_record_id") REFERENCES "public"."historical_normalized_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ADD CONSTRAINT "historical_confidence_estimates_source_record_id_historical_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."historical_source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ADD CONSTRAINT "historical_confidence_runs_pattern_run_id_historical_pattern_runs_id_fk" FOREIGN KEY ("pattern_run_id") REFERENCES "public"."historical_pattern_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ADD CONSTRAINT "historical_confidence_runs_import_batch_id_historical_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."historical_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ADD CONSTRAINT "historical_confidence_runs_normalized_record_id_historical_normalized_records_id_fk" FOREIGN KEY ("normalized_record_id") REFERENCES "public"."historical_normalized_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_pattern_snapshots" ADD CONSTRAINT "historical_pattern_snapshots_run_id_historical_pattern_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_pattern_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_pattern_snapshots" ADD CONSTRAINT "historical_pattern_snapshots_pattern_id_historical_pattern_definitions_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."historical_pattern_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_confidence_estimates_run_record_unique" ON "historical_confidence_estimates" USING btree ("run_id","normalized_record_id");--> statement-breakpoint
CREATE INDEX "historical_confidence_estimates_tier_idx" ON "historical_confidence_estimates" USING btree ("run_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_confidence_runs_key_unique" ON "historical_confidence_runs" USING btree ("run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_definitions_key_unique" ON "historical_pattern_definitions" USING btree ("pattern_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_runs_key_unique" ON "historical_pattern_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "historical_pattern_runs_as_of_idx" ON "historical_pattern_runs" USING btree ("as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_snapshots_run_pattern_unique" ON "historical_pattern_snapshots" USING btree ("run_id","pattern_id");--> statement-breakpoint
CREATE INDEX "historical_pattern_snapshots_status_idx" ON "historical_pattern_snapshots" USING btree ("run_id","evidence_status");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 4 / Task 4: historical pattern library and calibrated confidence. Definitions, pattern runs, performance snapshots,
-- confidence runs and confidence estimates are immutable and hash-chained (chains 22-26). Nothing is edited: a different as-of, label set, configuration or algorithm is a different run.
ALTER TABLE "historical_pattern_definitions" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_pattern_definitions" ADD CONSTRAINT "historical_pattern_definitions_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_definitions_chain_index_unique" ON "historical_pattern_definitions" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_pattern_definitions"(r "historical_pattern_definitions") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.pattern_key, r.key_text, r.level::text, r.features::text, r.definition_version, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_pattern_definitions_chain_before_insert" BEFORE INSERT ON "historical_pattern_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_pattern_definitions');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_definitions_chain_after_insert" AFTER INSERT ON "historical_pattern_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_pattern_definitions');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_definitions_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_pattern_definitions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_pattern_definitions_no_truncate" BEFORE TRUNCATE ON "historical_pattern_definitions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_pattern_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_pattern_runs" ADD CONSTRAINT "historical_pattern_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_runs_chain_index_unique" ON "historical_pattern_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_pattern_runs"(r "historical_pattern_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_key, r.algorithm_version, r.config::text, r.config_sha256, twins_audit_ts(r.as_of), twins_audit_ts(r.embargo_cutoff), r.label_set_sha256, r.input_summary::text, r.pattern_count::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_pattern_runs_chain_before_insert" BEFORE INSERT ON "historical_pattern_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_pattern_runs');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_runs_chain_after_insert" AFTER INSERT ON "historical_pattern_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_pattern_runs');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_pattern_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_pattern_runs_no_truncate" BEFORE TRUNCATE ON "historical_pattern_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_pattern_snapshots" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_pattern_snapshots" ADD CONSTRAINT "historical_pattern_snapshots_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_pattern_snapshots_chain_index_unique" ON "historical_pattern_snapshots" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_pattern_snapshots"(r "historical_pattern_snapshots") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.pattern_id::text, r.level::text, r.evidence_status, r.flags::text, r.sample_size::text, r.metrics::text, r.mixes::text, twins_audit_ts(r.first_observed), twins_audit_ts(r.last_observed), r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_pattern_snapshots_chain_before_insert" BEFORE INSERT ON "historical_pattern_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_pattern_snapshots');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_snapshots_chain_after_insert" AFTER INSERT ON "historical_pattern_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_pattern_snapshots');--> statement-breakpoint
CREATE TRIGGER "historical_pattern_snapshots_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_pattern_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_pattern_snapshots_no_truncate" BEFORE TRUNCATE ON "historical_pattern_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ADD CONSTRAINT "historical_confidence_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_confidence_runs_chain_index_unique" ON "historical_confidence_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_confidence_runs"(r "historical_confidence_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_key, r.pattern_run_id::text, r.scope, r.import_batch_id::text, r.normalized_record_id::text, r.algorithm_version, r.config::text, r.config_sha256, r.trust_mode, r.lookahead::text, r.input_summary::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_confidence_runs_chain_before_insert" BEFORE INSERT ON "historical_confidence_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_confidence_runs');--> statement-breakpoint
CREATE TRIGGER "historical_confidence_runs_chain_after_insert" AFTER INSERT ON "historical_confidence_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_confidence_runs');--> statement-breakpoint
CREATE TRIGGER "historical_confidence_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_confidence_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_confidence_runs_no_truncate" BEFORE TRUNCATE ON "historical_confidence_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ADD CONSTRAINT "historical_confidence_estimates_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_confidence_estimates_chain_index_unique" ON "historical_confidence_estimates" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_confidence_estimates"(r "historical_confidence_estimates") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.normalized_record_id::text, r.source_record_id::text, r.score::text, r.tier, r.evidence_quality, r.sample_size::text, r.pattern_refs::text, r.inputs::text, r.explanation::text, r.limitations::text, r.evidence_references::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_confidence_estimates_chain_before_insert" BEFORE INSERT ON "historical_confidence_estimates" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_confidence_estimates');--> statement-breakpoint
CREATE TRIGGER "historical_confidence_estimates_chain_after_insert" AFTER INSERT ON "historical_confidence_estimates" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_confidence_estimates');--> statement-breakpoint
CREATE TRIGGER "historical_confidence_estimates_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_confidence_estimates" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_confidence_estimates_no_truncate" BEFORE TRUNCATE ON "historical_confidence_estimates" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_pattern_definitions" ENABLE ALWAYS TRIGGER "historical_pattern_definitions_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_pattern_definitions_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_pattern_definitions_no_update_delete", ENABLE ALWAYS TRIGGER "historical_pattern_definitions_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_pattern_runs" ENABLE ALWAYS TRIGGER "historical_pattern_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_pattern_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_pattern_runs_no_update_delete", ENABLE ALWAYS TRIGGER "historical_pattern_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_pattern_snapshots" ENABLE ALWAYS TRIGGER "historical_pattern_snapshots_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_pattern_snapshots_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_pattern_snapshots_no_update_delete", ENABLE ALWAYS TRIGGER "historical_pattern_snapshots_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_confidence_runs" ENABLE ALWAYS TRIGGER "historical_confidence_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_confidence_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_confidence_runs_no_update_delete", ENABLE ALWAYS TRIGGER "historical_confidence_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_confidence_estimates" ENABLE ALWAYS TRIGGER "historical_confidence_estimates_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_confidence_estimates_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_confidence_estimates_no_update_delete", ENABLE ALWAYS TRIGGER "historical_confidence_estimates_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals', 'historical_source_records', 'historical_datasets', 'historical_evaluation_runs', 'historical_outcome_labels', 'historical_evaluation_events', 'historical_source_registry', 'historical_scorecard_runs', 'historical_scorecard_metrics', 'historical_trust_tiers', 'historical_scorecard_events', 'historical_pattern_definitions', 'historical_pattern_runs', 'historical_pattern_snapshots', 'historical_confidence_runs', 'historical_confidence_estimates'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('historical_pattern_definitions', 0, repeat('0', 64)), ('historical_pattern_runs', 0, repeat('0', 64)), ('historical_pattern_snapshots', 0, repeat('0', 64)), ('historical_confidence_runs', 0, repeat('0', 64)), ('historical_confidence_estimates', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";
