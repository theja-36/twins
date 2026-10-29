CREATE TABLE "event_blackout_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" text NOT NULL,
	"market" text NOT NULL,
	"scope" text NOT NULL,
	"scope_value" text,
	"severity" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text,
	"cancels_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_blackout_windows_type_check" CHECK ("event_blackout_windows"."entry_type" in ('WINDOW', 'CANCELLATION')),
	CONSTRAINT "event_blackout_windows_scope_check" CHECK ("event_blackout_windows"."scope" in ('MARKET', 'SYMBOL') and (("event_blackout_windows"."scope" = 'SYMBOL') = ("event_blackout_windows"."scope_value" is not null))),
	CONSTRAINT "event_blackout_windows_severity_check" CHECK ("event_blackout_windows"."severity" in ('WARNING', 'CRITICAL')),
	CONSTRAINT "event_blackout_windows_time_check" CHECK ("event_blackout_windows"."ends_at" > "event_blackout_windows"."starts_at"),
	CONSTRAINT "event_blackout_windows_cancel_shape_check" CHECK (("event_blackout_windows"."entry_type" = 'CANCELLATION') = ("event_blackout_windows"."cancels_id" is not null)),
	CONSTRAINT "event_blackout_windows_reason_check" CHECK ("event_blackout_windows"."reason_code" ~ '^[a-z][a-z0-9_]{2,60}$' and "event_blackout_windows"."market" ~ '^[A-Z0-9]{2,20}$'),
	CONSTRAINT "event_blackout_windows_actor_check" CHECK ("event_blackout_windows"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_blackout_windows_idempotency_unique" ON "event_blackout_windows" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_blackout_windows_cancels_unique" ON "event_blackout_windows" USING btree ("cancels_id");--> statement-breakpoint
CREATE INDEX "event_blackout_windows_window_idx" ON "event_blackout_windows" USING btree ("market","starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_market_review_check" CHECK ("risk_decisions"."status" <> 'APPROVED_FOR_REVIEW' or coalesce("risk_decisions"."output_snapshot" -> 'market' ->> 'outcome' = 'PASSED', false)) NOT VALID;
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 3 / Task 5: the market-risk review check above is NOT VALID (enforced for every new row; rows written
-- before this migration - none in staging - are preserved untouched). Event blackout windows are an immutable, hash-chained table (the tenth chain).
ALTER TABLE "event_blackout_windows" ADD CONSTRAINT "event_blackout_windows_cancels_id_fk" FOREIGN KEY ("cancels_id") REFERENCES "public"."event_blackout_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_blackout_windows" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "event_blackout_windows" ADD CONSTRAINT "event_blackout_windows_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "event_blackout_windows_chain_index_unique" ON "event_blackout_windows" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_event_blackout_windows"(r "event_blackout_windows") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.entry_type, r.market, r.scope, r.scope_value, r.severity, twins_audit_ts(r.starts_at), twins_audit_ts(r.ends_at), r.reason_code, r.reason, r.cancels_id::text, r.idempotency_key, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "event_blackout_windows_chain_before_insert" BEFORE INSERT ON "event_blackout_windows" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('event_blackout_windows');--> statement-breakpoint
CREATE TRIGGER "event_blackout_windows_chain_after_insert" AFTER INSERT ON "event_blackout_windows" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('event_blackout_windows');--> statement-breakpoint
CREATE TRIGGER "event_blackout_windows_no_update_delete" BEFORE UPDATE OR DELETE ON "event_blackout_windows" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "event_blackout_windows_no_truncate" BEFORE TRUNCATE ON "event_blackout_windows" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- a CANCELLATION must withdraw a WINDOW (not another cancellation) and must describe the same market, scope and period
CREATE FUNCTION "twins_event_blackout_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	w event_blackout_windows%ROWTYPE;
BEGIN
	IF NEW.entry_type = 'CANCELLATION' THEN
		SELECT * INTO w FROM event_blackout_windows WHERE id = NEW.cancels_id;
		IF NOT FOUND OR w.entry_type <> 'WINDOW' THEN
			RAISE EXCEPTION 'event_blackout_windows: a CANCELLATION must reference a WINDOW' USING ERRCODE = 'check_violation';
		END IF;
		IF w.market <> NEW.market OR w.scope <> NEW.scope OR w.scope_value IS DISTINCT FROM NEW.scope_value OR w.starts_at <> NEW.starts_at OR w.ends_at <> NEW.ends_at OR w.severity <> NEW.severity THEN
			RAISE EXCEPTION 'event_blackout_windows: a CANCELLATION must describe the window it withdraws' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "event_blackout_windows_a_integrity_before_insert" BEFORE INSERT ON "event_blackout_windows" FOR EACH ROW EXECUTE FUNCTION "twins_event_blackout_integrity"();--> statement-breakpoint
ALTER TABLE "event_blackout_windows" ENABLE ALWAYS TRIGGER "event_blackout_windows_a_integrity_before_insert", ENABLE ALWAYS TRIGGER "event_blackout_windows_chain_before_insert", ENABLE ALWAYS TRIGGER "event_blackout_windows_chain_after_insert", ENABLE ALWAYS TRIGGER "event_blackout_windows_no_update_delete", ENABLE ALWAYS TRIGGER "event_blackout_windows_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('event_blackout_windows', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|risk_decisions|loss_events|circuit_breaker_events|event_blackout_windows|twins_audit_|twins_risk_decision|twins_circuit_breaker|twins_event_blackout|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_|orders_require_risk_decision|_breaker_)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;
