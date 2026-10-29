CREATE TABLE "historical_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"series_count" integer NOT NULL,
	"bar_count" bigint NOT NULL,
	"coverage_from" timestamp with time zone,
	"coverage_to" timestamp with time zone,
	"descriptor" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_datasets_hash_check" CHECK ("historical_datasets"."content_sha256" ~ '^[0-9a-f]{64}$' and "historical_datasets"."provider_id" ~ '^[A-Za-z0-9_.:-]{1,80}$' and "historical_datasets"."dataset_id" ~ '^[A-Za-z0-9_.:-]{1,80}$' and "historical_datasets"."dataset_version" ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "historical_datasets_counts_check" CHECK ("historical_datasets"."series_count" >= 0 and "historical_datasets"."bar_count" >= 0),
	CONSTRAINT "historical_datasets_actor_check" CHECK ("historical_datasets"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_evaluation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"sequence" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_evaluation_events_type_check" CHECK ("historical_evaluation_events"."event_type" in ('RUN_STARTED', 'CHECKPOINT', 'RUN_COMPLETED')),
	CONSTRAINT "historical_evaluation_events_seq_check" CHECK ("historical_evaluation_events"."sequence" >= 1 and octet_length("historical_evaluation_events"."detail"::text) <= 4096),
	CONSTRAINT "historical_evaluation_events_actor_check" CHECK ("historical_evaluation_events"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"scope" text NOT NULL,
	"import_batch_id" uuid,
	"normalized_record_id" uuid,
	"algorithm_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"dataset_ids" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_evaluation_runs_scope_check" CHECK (("historical_evaluation_runs"."scope" = 'BATCH' and "historical_evaluation_runs"."import_batch_id" is not null and "historical_evaluation_runs"."normalized_record_id" is null) or ("historical_evaluation_runs"."scope" = 'RECORD' and "historical_evaluation_runs"."normalized_record_id" is not null and "historical_evaluation_runs"."import_batch_id" is null)),
	CONSTRAINT "historical_evaluation_runs_hash_check" CHECK ("historical_evaluation_runs"."run_key" ~ '^[0-9a-f]{64}$' and "historical_evaluation_runs"."config_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_evaluation_runs_actor_check" CHECK ("historical_evaluation_runs"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_outcome_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"normalized_record_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"dataset_id" uuid,
	"algorithm_version" text NOT NULL,
	"final_outcome" text NOT NULL,
	"primary_reason" text,
	"reasons" jsonb NOT NULL,
	"entry_status" text NOT NULL,
	"entry_first_touch_at" timestamp with time zone,
	"sl_status" text NOT NULL,
	"sl_first_touch_at" timestamp with time zone,
	"target_evaluations" jsonb NOT NULL,
	"data_quality" text NOT NULL,
	"data_window" jsonb NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_outcome_labels_outcome_check" CHECK ("historical_outcome_labels"."final_outcome" in ('WIN_T1', 'WIN_T2', 'WIN_T3', 'LOSS_SL', 'NO_ENTRY', 'EXPIRED_NO_ENTRY', 'EXPIRED_AFTER_ENTRY', 'INVALID_SIGNAL', 'UNVERIFIABLE')),
	CONSTRAINT "historical_outcome_labels_status_check" CHECK ("historical_outcome_labels"."entry_status" in ('ENTRY_REACHED', 'ENTRY_NOT_REACHED', 'ENTRY_INVALID', 'UNVERIFIABLE') and "historical_outcome_labels"."sl_status" in ('SL_HIT', 'SL_NOT_HIT', 'SL_INVALID', 'UNVERIFIABLE') and "historical_outcome_labels"."data_quality" in ('GOOD', 'DEGRADED', 'INSUFFICIENT', 'NOT_APPLICABLE')),
	CONSTRAINT "historical_outcome_labels_reason_check" CHECK (("historical_outcome_labels"."final_outcome" not in ('INVALID_SIGNAL', 'UNVERIFIABLE') or "historical_outcome_labels"."primary_reason" is not null) and ("historical_outcome_labels"."primary_reason" is null or "historical_outcome_labels"."primary_reason" ~ '^[A-Z][A-Z0-9_]{2,60}$')),
	CONSTRAINT "historical_outcome_labels_size_check" CHECK (octet_length("historical_outcome_labels"."evidence"::text) <= 65536 and octet_length("historical_outcome_labels"."input_snapshot"::text) <= 16384),
	CONSTRAINT "historical_outcome_labels_actor_check" CHECK ("historical_outcome_labels"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "historical_evaluation_events" ADD CONSTRAINT "historical_evaluation_events_run_id_historical_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_evaluation_runs" ADD CONSTRAINT "historical_evaluation_runs_import_batch_id_historical_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."historical_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_evaluation_runs" ADD CONSTRAINT "historical_evaluation_runs_normalized_record_id_historical_normalized_records_id_fk" FOREIGN KEY ("normalized_record_id") REFERENCES "public"."historical_normalized_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD CONSTRAINT "historical_outcome_labels_run_id_historical_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD CONSTRAINT "historical_outcome_labels_normalized_record_id_historical_normalized_records_id_fk" FOREIGN KEY ("normalized_record_id") REFERENCES "public"."historical_normalized_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD CONSTRAINT "historical_outcome_labels_source_record_id_historical_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."historical_source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD CONSTRAINT "historical_outcome_labels_dataset_id_historical_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."historical_datasets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_datasets_ref_unique" ON "historical_datasets" USING btree ("provider_id","dataset_id","dataset_version","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_evaluation_events_seq_unique" ON "historical_evaluation_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_evaluation_runs_key_unique" ON "historical_evaluation_runs" USING btree ("run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_outcome_labels_run_record_unique" ON "historical_outcome_labels" USING btree ("run_id","normalized_record_id");--> statement-breakpoint
CREATE INDEX "historical_outcome_labels_record_idx" ON "historical_outcome_labels" USING btree ("normalized_record_id");--> statement-breakpoint
CREATE INDEX "historical_outcome_labels_outcome_idx" ON "historical_outcome_labels" USING btree ("run_id","final_outcome");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 4 / Task 2: historical outcome evaluation. Datasets, runs, labels and evaluation events are immutable and hash-chained
-- (chains 13-16). A label can never be edited; a different dataset / configuration / algorithm is a different run.
ALTER TABLE "historical_datasets" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_datasets" ADD CONSTRAINT "historical_datasets_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_datasets_chain_index_unique" ON "historical_datasets" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_datasets"(r "historical_datasets") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.provider_id, r.dataset_id, r.dataset_version, r.content_sha256, r.series_count::text, r.bar_count::text, twins_audit_ts(r.coverage_from), twins_audit_ts(r.coverage_to), r.descriptor::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_datasets_chain_before_insert" BEFORE INSERT ON "historical_datasets" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_datasets');--> statement-breakpoint
CREATE TRIGGER "historical_datasets_chain_after_insert" AFTER INSERT ON "historical_datasets" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_datasets');--> statement-breakpoint
CREATE TRIGGER "historical_datasets_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_datasets" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_datasets_no_truncate" BEFORE TRUNCATE ON "historical_datasets" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_evaluation_runs" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_evaluation_runs" ADD CONSTRAINT "historical_evaluation_runs_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_evaluation_runs_chain_index_unique" ON "historical_evaluation_runs" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_evaluation_runs"(r "historical_evaluation_runs") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_key, r.scope, r.import_batch_id::text, r.normalized_record_id::text, r.algorithm_version, r.config::text, r.config_sha256, twins_audit_ts(r.evaluated_at), r.dataset_ids::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_runs_chain_before_insert" BEFORE INSERT ON "historical_evaluation_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_evaluation_runs');--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_runs_chain_after_insert" AFTER INSERT ON "historical_evaluation_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_evaluation_runs');--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_evaluation_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_runs_no_truncate" BEFORE TRUNCATE ON "historical_evaluation_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ADD CONSTRAINT "historical_outcome_labels_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_outcome_labels_chain_index_unique" ON "historical_outcome_labels" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_outcome_labels"(r "historical_outcome_labels") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.normalized_record_id::text, r.source_record_id::text, r.dataset_id::text, r.algorithm_version, r.final_outcome, r.primary_reason, r.reasons::text, r.entry_status, twins_audit_ts(r.entry_first_touch_at), r.sl_status, twins_audit_ts(r.sl_first_touch_at), r.target_evaluations::text, r.data_quality, r.data_window::text, r.input_snapshot::text, r.evidence::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_outcome_labels_chain_before_insert" BEFORE INSERT ON "historical_outcome_labels" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_outcome_labels');--> statement-breakpoint
CREATE TRIGGER "historical_outcome_labels_chain_after_insert" AFTER INSERT ON "historical_outcome_labels" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_outcome_labels');--> statement-breakpoint
CREATE TRIGGER "historical_outcome_labels_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_outcome_labels" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_outcome_labels_no_truncate" BEFORE TRUNCATE ON "historical_outcome_labels" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_evaluation_events" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_evaluation_events" ADD CONSTRAINT "historical_evaluation_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_evaluation_events_chain_index_unique" ON "historical_evaluation_events" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_evaluation_events"(r "historical_evaluation_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.run_id::text, r.event_type, r.sequence::text, r.detail::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_events_chain_before_insert" BEFORE INSERT ON "historical_evaluation_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_evaluation_events');--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_events_chain_after_insert" AFTER INSERT ON "historical_evaluation_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_evaluation_events');--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_events_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_evaluation_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_evaluation_events_no_truncate" BEFORE TRUNCATE ON "historical_evaluation_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- a label's source record must be the source of its normalized record (a label cannot be attached to another message's evidence)
CREATE FUNCTION "twins_historical_label_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	n_source uuid;
BEGIN
	SELECT source_record_id INTO n_source FROM historical_normalized_records WHERE id = NEW.normalized_record_id;
	IF NOT FOUND OR n_source IS DISTINCT FROM NEW.source_record_id THEN
		RAISE EXCEPTION 'historical_outcome_labels: the source record must be the source of the normalized record' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "historical_outcome_labels_a_integrity_before_insert" BEFORE INSERT ON "historical_outcome_labels" FOR EACH ROW EXECUTE FUNCTION "twins_historical_label_integrity"();--> statement-breakpoint
ALTER TABLE "historical_datasets" ENABLE ALWAYS TRIGGER "historical_datasets_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_datasets_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_datasets_no_update_delete", ENABLE ALWAYS TRIGGER "historical_datasets_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_evaluation_runs" ENABLE ALWAYS TRIGGER "historical_evaluation_runs_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_evaluation_runs_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_evaluation_runs_no_update_delete", ENABLE ALWAYS TRIGGER "historical_evaluation_runs_no_truncate";--> statement-breakpoint
ALTER TABLE "historical_outcome_labels" ENABLE ALWAYS TRIGGER "historical_outcome_labels_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_outcome_labels_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_outcome_labels_no_update_delete", ENABLE ALWAYS TRIGGER "historical_outcome_labels_no_truncate", ENABLE ALWAYS TRIGGER "historical_outcome_labels_a_integrity_before_insert";--> statement-breakpoint
ALTER TABLE "historical_evaluation_events" ENABLE ALWAYS TRIGGER "historical_evaluation_events_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_evaluation_events_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_evaluation_events_no_update_delete", ENABLE ALWAYS TRIGGER "historical_evaluation_events_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals', 'historical_source_records', 'historical_datasets', 'historical_evaluation_runs', 'historical_outcome_labels', 'historical_evaluation_events'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('historical_datasets', 0, repeat('0', 64)), ('historical_evaluation_runs', 0, repeat('0', 64)), ('historical_outcome_labels', 0, repeat('0', 64)), ('historical_evaluation_events', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";
