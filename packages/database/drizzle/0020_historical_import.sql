CREATE TABLE "historical_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_key" text NOT NULL,
	"label" text NOT NULL,
	"format" text NOT NULL,
	"contract_version" text NOT NULL,
	"parser_version" text NOT NULL,
	"default_market" text,
	"manifest" jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"options" jsonb NOT NULL,
	"confirmed_source" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_batches_key_check" CHECK ("historical_import_batches"."batch_key" ~ '^[0-9a-f]{64}$' and "historical_import_batches"."manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_batches_label_check" CHECK ("historical_import_batches"."label" ~ '^[A-Za-z0-9_.:@ -]{1,80}$'),
	CONSTRAINT "historical_import_batches_actor_check" CHECK ("historical_import_batches"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "historical_import_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"records_consumed" bigint NOT NULL,
	"counters" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_checkpoints_status_check" CHECK ("historical_import_checkpoints"."status" in ('IN_PROGRESS', 'COMPLETED')),
	CONSTRAINT "historical_import_checkpoints_seq_check" CHECK ("historical_import_checkpoints"."sequence" >= 1 and "historical_import_checkpoints"."records_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "historical_import_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_record_id" uuid,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"source_file" text,
	"source_line" integer,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_issues_severity_check" CHECK ("historical_import_issues"."severity" in ('WARNING', 'ERROR')),
	CONSTRAINT "historical_import_issues_code_check" CHECK ("historical_import_issues"."code" ~ '^[a-z][a-z0-9_]{2,60}$' and octet_length("historical_import_issues"."detail"::text) <= 2048)
);
--> statement-breakpoint
CREATE TABLE "historical_normalized_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"parse_status" text NOT NULL,
	"market" text,
	"market_source" text,
	"instrument_type" text,
	"underlying" text,
	"expiry" jsonb,
	"expiry_date" date,
	"strike" numeric,
	"option_type" text,
	"side" text,
	"entry" jsonb,
	"stop_loss" numeric,
	"level_basis" text,
	"targets" jsonb NOT NULL,
	"time_validity" text,
	"conditions" jsonb NOT NULL,
	"missing_fields" jsonb NOT NULL,
	"ambiguous_fields" jsonb NOT NULL,
	"validation_result" text NOT NULL,
	"stop_loss_validation" jsonb,
	"parsed" jsonb,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_normalized_records_status_check" CHECK ("historical_normalized_records"."parse_status" in ('SIGNAL', 'OPTIONS_CLAIM', 'AMBIGUOUS', 'UNSUPPORTED', 'NO_SIGNAL') and "historical_normalized_records"."validation_result" in ('VALID', 'INCOMPLETE', 'AMBIGUOUS', 'UNSUPPORTED', 'NOT_A_SIGNAL')),
	CONSTRAINT "historical_normalized_records_market_check" CHECK (("historical_normalized_records"."market" is null) = ("historical_normalized_records"."market_source" is null) and ("historical_normalized_records"."market_source" is null or "historical_normalized_records"."market_source" in ('record', 'batch_default', 'underlying_mapping'))),
	CONSTRAINT "historical_normalized_records_numbers_check" CHECK (("historical_normalized_records"."strike" is null or "historical_normalized_records"."strike" > 0) and ("historical_normalized_records"."stop_loss" is null or "historical_normalized_records"."stop_loss" > 0))
);
--> statement-breakpoint
CREATE TABLE "historical_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"channel_label" text NOT NULL,
	"original_message_id" text NOT NULL,
	"message_timestamp" timestamp with time zone NOT NULL,
	"author" text,
	"raw_text" text NOT NULL,
	"content_sha256" text NOT NULL,
	"raw_text_redacted" text DEFAULT 'no' NOT NULL,
	"media_refs" jsonb NOT NULL,
	"edit_of_id" uuid,
	"revision_no" integer DEFAULT 0 NOT NULL,
	"edited_at" timestamp with time zone,
	"source_file" text NOT NULL,
	"source_file_sha256" text NOT NULL,
	"source_line" integer NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_source_records_hash_check" CHECK ("historical_source_records"."identity_key" ~ '^[0-9a-f]{64}$' and "historical_source_records"."content_sha256" ~ '^[0-9a-f]{64}$' and "historical_source_records"."source_file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_source_records_revision_check" CHECK (("historical_source_records"."edit_of_id" is null) = ("historical_source_records"."revision_no" = 0) and "historical_source_records"."revision_no" >= 0),
	CONSTRAINT "historical_source_records_redacted_check" CHECK ("historical_source_records"."raw_text_redacted" in ('yes', 'no')),
	CONSTRAINT "historical_source_records_shape_check" CHECK ("historical_source_records"."channel_label" ~ '^[A-Za-z0-9_.:@ -]{1,80}$' and "historical_source_records"."original_message_id" ~ '^[A-Za-z0-9_.:-]{1,80}$' and "historical_source_records"."source_line" >= 1 and length("historical_source_records"."raw_text") <= 20000),
	CONSTRAINT "historical_source_records_actor_check" CHECK ("historical_source_records"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "historical_import_checkpoints" ADD CONSTRAINT "historical_import_checkpoints_batch_id_historical_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."historical_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_issues" ADD CONSTRAINT "historical_import_issues_batch_id_historical_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."historical_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_issues" ADD CONSTRAINT "historical_import_issues_source_record_id_historical_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."historical_source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_normalized_records" ADD CONSTRAINT "historical_normalized_records_source_record_id_historical_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."historical_source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_source_records" ADD CONSTRAINT "historical_source_records_batch_id_historical_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."historical_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_batches_key_unique" ON "historical_import_batches" USING btree ("batch_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_checkpoints_seq_unique" ON "historical_import_checkpoints" USING btree ("batch_id","sequence");--> statement-breakpoint
CREATE INDEX "historical_import_issues_batch_idx" ON "historical_import_issues" USING btree ("batch_id","severity","code");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_normalized_records_source_unique" ON "historical_normalized_records" USING btree ("source_record_id","parser_version");--> statement-breakpoint
CREATE INDEX "historical_normalized_records_status_idx" ON "historical_normalized_records" USING btree ("parse_status","validation_result");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_records_identity_unique" ON "historical_source_records" USING btree ("identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_records_revision_unique" ON "historical_source_records" USING btree ("channel_label","original_message_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_records_edit_unique" ON "historical_source_records" USING btree ("edit_of_id","content_sha256");--> statement-breakpoint
CREATE INDEX "historical_source_records_batch_idx" ON "historical_source_records" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "historical_source_records_time_idx" ON "historical_source_records" USING btree ("channel_label","message_timestamp");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 4 / Task 1: historical archive import. `historical_source_records` is the evidence table: immutable and
-- hash-chained (the twelfth chain). The batch, normalized, issue and checkpoint tables are append-only (UPDATE / DELETE / TRUNCATE rejected, also under replica role).
-- Self reference for revisions: an edit is a NEW row linked to the original message version.
ALTER TABLE "historical_source_records" ADD CONSTRAINT "historical_source_records_edit_of_id_fk" FOREIGN KEY ("edit_of_id") REFERENCES "public"."historical_source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_source_records" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_source_records" ADD CONSTRAINT "historical_source_records_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "historical_source_records_chain_index_unique" ON "historical_source_records" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_historical_source_records"(r "historical_source_records") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.batch_id::text, r.identity_key, r.channel_label, r.original_message_id, twins_audit_ts(r.message_timestamp), r.author, r.raw_text, r.content_sha256, r.raw_text_redacted, r.media_refs::text,
		r.edit_of_id::text, r.revision_no::text, twins_audit_ts(r.edited_at), r.source_file, r.source_file_sha256, r.source_line::text, r.provenance::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "historical_source_records_chain_before_insert" BEFORE INSERT ON "historical_source_records" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('historical_source_records');--> statement-breakpoint
CREATE TRIGGER "historical_source_records_chain_after_insert" AFTER INSERT ON "historical_source_records" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('historical_source_records');--> statement-breakpoint
CREATE TRIGGER "historical_source_records_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_source_records" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_source_records_no_truncate" BEFORE TRUNCATE ON "historical_source_records" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- a revision must concern the SAME message as the original it points at, and the original must itself be revision 0
CREATE FUNCTION "twins_historical_source_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	o historical_source_records%ROWTYPE;
BEGIN
	IF NEW.edit_of_id IS NOT NULL THEN
		SELECT * INTO o FROM historical_source_records WHERE id = NEW.edit_of_id;
		IF NOT FOUND OR o.revision_no <> 0 OR o.channel_label <> NEW.channel_label OR o.original_message_id <> NEW.original_message_id THEN
			RAISE EXCEPTION 'historical_source_records: a revision must point at revision 0 of the same channel and message' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "historical_source_records_a_integrity_before_insert" BEFORE INSERT ON "historical_source_records" FOR EACH ROW EXECUTE FUNCTION "twins_historical_source_integrity"();--> statement-breakpoint
ALTER TABLE "historical_source_records" ENABLE ALWAYS TRIGGER "historical_source_records_a_integrity_before_insert", ENABLE ALWAYS TRIGGER "historical_source_records_chain_before_insert", ENABLE ALWAYS TRIGGER "historical_source_records_chain_after_insert", ENABLE ALWAYS TRIGGER "historical_source_records_no_update_delete", ENABLE ALWAYS TRIGGER "historical_source_records_no_truncate";--> statement-breakpoint
CREATE TRIGGER "historical_import_batches_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_import_batches" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_import_batches_no_truncate" BEFORE TRUNCATE ON "historical_import_batches" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_import_batches" ENABLE ALWAYS TRIGGER "historical_import_batches_no_update_delete", ENABLE ALWAYS TRIGGER "historical_import_batches_no_truncate";--> statement-breakpoint
CREATE TRIGGER "historical_normalized_records_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_normalized_records" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_normalized_records_no_truncate" BEFORE TRUNCATE ON "historical_normalized_records" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_normalized_records" ENABLE ALWAYS TRIGGER "historical_normalized_records_no_update_delete", ENABLE ALWAYS TRIGGER "historical_normalized_records_no_truncate";--> statement-breakpoint
CREATE TRIGGER "historical_import_issues_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_import_issues" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_import_issues_no_truncate" BEFORE TRUNCATE ON "historical_import_issues" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_import_issues" ENABLE ALWAYS TRIGGER "historical_import_issues_no_update_delete", ENABLE ALWAYS TRIGGER "historical_import_issues_no_truncate";--> statement-breakpoint
CREATE TRIGGER "historical_import_checkpoints_no_update_delete" BEFORE UPDATE OR DELETE ON "historical_import_checkpoints" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "historical_import_checkpoints_no_truncate" BEFORE TRUNCATE ON "historical_import_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "historical_import_checkpoints" ENABLE ALWAYS TRIGGER "historical_import_checkpoints_no_update_delete", ENABLE ALWAYS TRIGGER "historical_import_checkpoints_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals', 'historical_source_records'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('historical_source_records', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|risk_decisions|loss_events|circuit_breaker_events|event_blackout_windows|risk_approvals|risk_approval_cards|historical_|twins_audit_|twins_risk_decision|twins_risk_approval|twins_risk_card|twins_record_risk_approval|twins_circuit_breaker|twins_event_blackout|twins_historical|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_|orders_require_risk_decision|_breaker_)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;
