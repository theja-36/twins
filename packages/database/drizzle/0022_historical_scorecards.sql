CREATE TABLE "historical_scorecard_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"sequence" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_scorecard_events_type_check" CHECK ("historical_scorecard_events"."event_type" in ('RUN_STARTED', 'RUN_COMPLETED') and "historical_scorecard_events"."sequence" >= 1 and octet_length("historical_scorecard_events"."detail"::text) <= 4096),
	CONSTRAINT "historical_scorecard_events_actor_check" CHECK ("historical_scorecard_events"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_scorecard_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"window_type" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"sample_size" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"caveats" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_scorecard_metrics_type_check" CHECK ("historical_scorecard_metrics"."window_type" in ('ALL_TIME', 'LAST_30D', 'LAST_90D', 'LAST_180D', 'LAST_365D', 'CALENDAR_MONTH') and "historical_scorecard_metrics"."sample_size" >= 0 and "historical_scorecard_metrics"."window_end" >= "historical_scorecard_metrics"."window_start"),
	CONSTRAINT "historical_scorecard_metrics_size_check" CHECK (octet_length("historical_scorecard_metrics"."metrics"::text) <= 16384 and octet_length("historical_scorecard_metrics"."caveats"::text) <= 4096),
	CONSTRAINT "historical_scorecard_metrics_actor_check" CHECK ("historical_scorecard_metrics"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_scorecard_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"source_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"algorithm_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"label_set_sha256" text NOT NULL,
	"input_summary" jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_scorecard_runs_hash_check" CHECK ("historical_scorecard_runs"."run_key" ~ '^[0-9a-f]{64}$' and "historical_scorecard_runs"."config_sha256" ~ '^[0-9a-f]{64}$' and "historical_scorecard_runs"."label_set_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_scorecard_runs_size_check" CHECK (octet_length("historical_scorecard_runs"."input_summary"::text) <= 65536 and octet_length("historical_scorecard_runs"."source_snapshot"::text) <= 16384),
	CONSTRAINT "historical_scorecard_runs_actor_check" CHECK ("historical_scorecard_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_source_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" text NOT NULL,
	"source_key" text NOT NULL,
	"channel_label" text NOT NULL,
	"alias_of_id" uuid,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_source_registry_type_check" CHECK (("historical_source_registry"."entry_type" = 'IDENTITY' and "historical_source_registry"."alias_of_id" is null) or ("historical_source_registry"."entry_type" = 'ALIAS_LINK' and "historical_source_registry"."alias_of_id" is not null and "historical_source_registry"."alias_of_id" <> "historical_source_registry"."id")),
	CONSTRAINT "historical_source_registry_value_check" CHECK ("historical_source_registry"."source_key" ~ '^[0-9a-f]{64}$' and char_length("historical_source_registry"."channel_label") between 1 and 200 and ("historical_source_registry"."reason" is null or char_length("historical_source_registry"."reason") <= 500)),
	CONSTRAINT "historical_source_registry_actor_check" CHECK ("historical_source_registry"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_trust_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"tier_label" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"explanation" jsonb NOT NULL,
	"metric_snapshot" jsonb NOT NULL,
	"threshold_config" jsonb NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_trust_tiers_tier_check" CHECK (("historical_trust_tiers"."tier" = 'A' and "historical_trust_tiers"."tier_label" = 'HIGH_TRUST') or ("historical_trust_tiers"."tier" = 'B' and "historical_trust_tiers"."tier_label" = 'MODERATE_TRUST') or ("historical_trust_tiers"."tier" = 'C' and "historical_trust_tiers"."tier_label" = 'LOW_TRUST') or ("historical_trust_tiers"."tier" = 'D' and "historical_trust_tiers"."tier_label" = 'UNTRUSTED') or ("historical_trust_tiers"."tier" = 'UNKNOWN' and "historical_trust_tiers"."tier_label" = 'INSUFFICIENT_EVIDENCE')),
	CONSTRAINT "historical_trust_tiers_size_check" CHECK (octet_length("historical_trust_tiers"."explanation"::text) <= 8192 and octet_length("historical_trust_tiers"."metric_snapshot"::text) <= 16384 and octet_length("historical_trust_tiers"."threshold_config"::text) <= 4096 and octet_length("historical_trust_tiers"."evidence_references"::text) <= 16384),
	CONSTRAINT "historical_trust_tiers_actor_check" CHECK ("historical_trust_tiers"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "historical_scorecard_events" ADD CONSTRAINT "historical_scorecard_events_run_id_historical_scorecard_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_scorecard_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_scorecard_metrics" ADD CONSTRAINT "historical_scorecard_metrics_run_id_historical_scorecard_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_scorecard_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_scorecard_runs" ADD CONSTRAINT "historical_scorecard_runs_source_id_historical_source_registry_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."historical_source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_source_registry" ADD CONSTRAINT "historical_source_registry_alias_of_id_historical_source_registry_id_fk" FOREIGN KEY ("alias_of_id") REFERENCES "public"."historical_source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_trust_tiers" ADD CONSTRAINT "historical_trust_tiers_run_id_historical_scorecard_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_scorecard_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_trust_tiers" ADD CONSTRAINT "historical_trust_tiers_source_id_historical_source_registry_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."historical_source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_events_seq_unique" ON "historical_scorecard_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_metrics_window_unique" ON "historical_scorecard_metrics" USING btree ("run_id","window_type","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_runs_key_unique" ON "historical_scorecard_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "historical_scorecard_runs_source_idx" ON "historical_scorecard_runs" USING btree ("source_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_registry_key_unique" ON "historical_source_registry" USING btree ("source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_trust_tiers_run_unique" ON "historical_trust_tiers" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "historical_trust_tiers_latest_idx" ON "historical_trust_tiers" USING btree ("source_id","as_of");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 4 / Task 3: source scorecards and trust tiers. The identity registry, scorecard runs, metrics, tier assignments and events are
-- immutable and hash-chained (chains 17-21). A scorecard is never edited: a different as-of, label set, configuration or algorithm is a different run.
ALTER TABLE "historical_source_registry" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_source_registry" ADD CONSTRAINT "historical_source_registry_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_registry_chain_index_unique" ON "historical_source_registry" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_source_registry"(r "historical_source_registry") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.entry_type, r.source_key, r.channel_label, r.alias_of_id::text, r.reason, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_source_registry_chain_before_insert" BEFORE INSERT ON "historical_source_registry" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_source_registry');--> statement-breakpoint
CREATE TRIGGER "historical_source_registry_chain_after_insert" AFTER INSERT ON "historical_source_registry" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_source_registry');--> statement-breakpoint
CREATE TRIGGER "historical_source_registry_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_source_registry" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_source_registry_no_truncate" BEFORE TRUNCATE ON "historical_source_registry" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_scorecard_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_scorecard_runs" ADD CONSTRAINT "historical_scorecard_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_runs_chain_index_unique" ON "historical_scorecard_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_scorecard_runs"(r "historical_scorecard_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_key, r.source_id::text, twins_audit_ts(r.as_of), r.algorithm_version, r.config::text, r.config_sha256, r.label_set_sha256, r.input_summary::text, r.source_snapshot::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_runs_chain_before_insert" BEFORE INSERT ON "historical_scorecard_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_scorecard_runs');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_runs_chain_after_insert" AFTER INSERT ON "historical_scorecard_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_scorecard_runs');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_scorecard_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_runs_no_truncate" BEFORE TRUNCATE ON "historical_scorecard_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_scorecard_metrics" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_scorecard_metrics" ADD CONSTRAINT "historical_scorecard_metrics_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_metrics_chain_index_unique" ON "historical_scorecard_metrics" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_scorecard_metrics"(r "historical_scorecard_metrics") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.window_type, twins_audit_ts(r.window_start), twins_audit_ts(r.window_end), r.sample_size::text, r.metrics::text, r.caveats::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_metrics_chain_before_insert" BEFORE INSERT ON "historical_scorecard_metrics" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_scorecard_metrics');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_metrics_chain_after_insert" AFTER INSERT ON "historical_scorecard_metrics" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_scorecard_metrics');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_metrics_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_scorecard_metrics" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_metrics_no_truncate" BEFORE TRUNCATE ON "historical_scorecard_metrics" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_trust_tiers" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_trust_tiers" ADD CONSTRAINT "historical_trust_tiers_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_trust_tiers_chain_index_unique" ON "historical_trust_tiers" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_trust_tiers"(r "historical_trust_tiers") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.source_id::text, r.tier, r.tier_label, twins_audit_ts(r.as_of), r.explanation::text, r.metric_snapshot::text, r.threshold_config::text, r.evidence_references::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_trust_tiers_chain_before_insert" BEFORE INSERT ON "historical_trust_tiers" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_trust_tiers');--> statement-breakpoint
CREATE TRIGGER "historical_trust_tiers_chain_after_insert" AFTER INSERT ON "historical_trust_tiers" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_trust_tiers');--> statement-breakpoint
CREATE TRIGGER "historical_trust_tiers_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_trust_tiers" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_trust_tiers_no_truncate" BEFORE TRUNCATE ON "historical_trust_tiers" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_scorecard_events" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_scorecard_events" ADD CONSTRAINT "historical_scorecard_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_scorecard_events_chain_index_unique" ON "historical_scorecard_events" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_scorecard_events"(r "historical_scorecard_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.event_type, r.sequence::text, r.detail::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_events_chain_before_insert" BEFORE INSERT ON "historical_scorecard_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_scorecard_events');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_events_chain_after_insert" AFTER INSERT ON "historical_scorecard_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_scorecard_events');--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_events_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_scorecard_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_scorecard_events_no_truncate" BEFORE TRUNCATE ON "historical_scorecard_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_source_registry" ENABLE ALWAYS TRIGGER "historical_source_registry_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_source_registry_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_source_registry_no_update_delete", ENABLE ALWAYS TRIGGER "historical_source_registry_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_scorecard_runs" ENABLE ALWAYS TRIGGER "historical_scorecard_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_runs_no_update_delete", ENABLE ALWAYS TRIGGER "historical_scorecard_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_scorecard_metrics" ENABLE ALWAYS TRIGGER "historical_scorecard_metrics_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_metrics_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_metrics_no_update_delete", ENABLE ALWAYS TRIGGER "historical_scorecard_metrics_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_trust_tiers" ENABLE ALWAYS TRIGGER "historical_trust_tiers_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_trust_tiers_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_trust_tiers_no_update_delete", ENABLE ALWAYS TRIGGER "historical_trust_tiers_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_scorecard_events" ENABLE ALWAYS TRIGGER "historical_scorecard_events_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_events_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_scorecard_events_no_update_delete", ENABLE ALWAYS TRIGGER "historical_scorecard_events_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals', 'historical_source_records', 'historical_datasets', 'historical_evaluation_runs', 'historical_outcome_labels', 'historical_evaluation_events', 'historical_source_registry', 'historical_scorecard_runs', 'historical_scorecard_metrics', 'historical_trust_tiers', 'historical_scorecard_events'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('historical_source_registry', 0, repeat('0', 64)), ('historical_scorecard_runs', 0, repeat('0', 64)), ('historical_scorecard_metrics', 0, repeat('0', 64)), ('historical_trust_tiers', 0, repeat('0', 64)), ('historical_scorecard_events', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";
