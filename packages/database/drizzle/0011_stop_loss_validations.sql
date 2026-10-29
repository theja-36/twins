CREATE TABLE "stop_loss_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"signal_id" uuid,
	"options_claim_id" uuid,
	"idempotency_key" text,
	"rule_version" text NOT NULL,
	"result" text NOT NULL,
	"reason_code" text,
	"detail" text,
	"instrument_type" text,
	"instrument_kind" text,
	"side" text,
	"option_type" text,
	"level_basis" text,
	"original_stop_loss" text,
	"normalized_stop_loss" numeric,
	"entry_price" numeric,
	"risk_distance" numeric,
	"risk_pct" numeric,
	"max_risk_pct" numeric,
	"max_risk_source" text,
	"expected_stop_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stop_loss_validations_subject_check" CHECK (("stop_loss_validations"."subject_kind" = 'signal' and "stop_loss_validations"."signal_id" is not null and "stop_loss_validations"."options_claim_id" is null) or ("stop_loss_validations"."subject_kind" = 'options_claim' and "stop_loss_validations"."options_claim_id" is not null and "stop_loss_validations"."signal_id" is null)),
	CONSTRAINT "stop_loss_validations_result_check" CHECK ("stop_loss_validations"."result" in ('VALID', 'INVALID', 'MISSING', 'AMBIGUOUS')),
	CONSTRAINT "stop_loss_validations_reason_check" CHECK (("stop_loss_validations"."result" = 'VALID') = ("stop_loss_validations"."reason_code" is null)),
	CONSTRAINT "stop_loss_validations_valid_shape_check" CHECK ("stop_loss_validations"."result" <> 'VALID' or ("stop_loss_validations"."normalized_stop_loss" is not null and "stop_loss_validations"."normalized_stop_loss" > 0 and "stop_loss_validations"."entry_price" is not null and "stop_loss_validations"."entry_price" > 0 and "stop_loss_validations"."risk_distance" > 0))
);
--> statement-breakpoint
ALTER TABLE "stop_loss_validations" ADD CONSTRAINT "stop_loss_validations_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_loss_validations" ADD CONSTRAINT "stop_loss_validations_options_claim_id_options_claims_id_fk" FOREIGN KEY ("options_claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stop_loss_validations_signal_idx" ON "stop_loss_validations" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "stop_loss_validations_claim_idx" ON "stop_loss_validations" USING btree ("options_claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stop_loss_validations_idempotency_unique" ON "stop_loss_validations" USING btree ("idempotency_key");--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 1 / Task 4: mandatory stop-loss invariant.
-- 1. stop_loss_validations joins the audit trail exactly like the five tables of 0010: chain columns assigned by the BEFORE INSERT trigger, append-only guards
--    (ENABLE ALWAYS), a chain head, and a payload function (payload version 1, same hash definition and domain as 0010).
-- 2. signal_validations may only record an APPROVE if the LATEST stop-loss validation of that signal is VALID (BEFORE INSERT trigger). Rows are never rewritten:
--    historical APPROVE rows without evidence stay as they are and are reported as NOT eligible by the view signal_validation_eligibility.
ALTER TABLE "stop_loss_validations" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "stop_loss_validations" ADD CONSTRAINT "stop_loss_validations_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "stop_loss_validations_chain_index_unique" ON "stop_loss_validations" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_stop_loss_validations"(r "stop_loss_validations") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.subject_kind, r.signal_id::text, r.options_claim_id::text, r.idempotency_key, r.rule_version, r.result, r.reason_code, r.detail, r.instrument_type, r.instrument_kind,
		r.side, r.option_type, r.level_basis, r.original_stop_loss, r.normalized_stop_loss::text, r.entry_price::text, r.risk_distance::text, r.risk_pct::text, r.max_risk_pct::text, r.max_risk_source,
		r.expected_stop_side, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "stop_loss_validations_chain_before_insert" BEFORE INSERT ON "stop_loss_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('stop_loss_validations');--> statement-breakpoint
CREATE TRIGGER "stop_loss_validations_chain_after_insert" AFTER INSERT ON "stop_loss_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('stop_loss_validations');--> statement-breakpoint
CREATE TRIGGER "stop_loss_validations_no_update_delete" BEFORE UPDATE OR DELETE ON "stop_loss_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "stop_loss_validations_no_truncate" BEFORE TRUNCATE ON "stop_loss_validations" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "stop_loss_validations" ENABLE ALWAYS TRIGGER "stop_loss_validations_chain_before_insert", ENABLE ALWAYS TRIGGER "stop_loss_validations_chain_after_insert", ENABLE ALWAYS TRIGGER "stop_loss_validations_no_update_delete", ENABLE ALWAYS TRIGGER "stop_loss_validations_no_truncate";--> statement-breakpoint
-- the new chain's head (the heads table refuses direct writes: lift its guard for this migration transaction only; the DDL watch records these statements)
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('stop_loss_validations', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
-- the DDL watch also covers the new objects
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|twins_audit_|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;--> statement-breakpoint
-- the invariant: no APPROVE without a VALID stop-loss validation of the same signal (latest evidence decides)
CREATE FUNCTION "twins_signal_validation_requires_stop_loss"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	latest text;
BEGIN
	IF NEW.outcome = 'APPROVE' THEN
		SELECT result INTO latest FROM stop_loss_validations WHERE signal_id = NEW.signal_id ORDER BY chain_index DESC LIMIT 1;
		IF latest IS DISTINCT FROM 'VALID' THEN
			RAISE EXCEPTION 'signal_validations: APPROVE requires a VALID stop-loss validation for the signal (latest: %)', coalesce(latest, 'none') USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "signal_validations_stop_loss_invariant" BEFORE INSERT ON "signal_validations" FOR EACH ROW EXECUTE FUNCTION "twins_signal_validation_requires_stop_loss"();--> statement-breakpoint
ALTER TABLE "signal_validations" ENABLE ALWAYS TRIGGER "signal_validations_stop_loss_invariant";--> statement-breakpoint
-- eligibility report: historical rows are NOT rewritten; a validation is approval-eligible only if it is an APPROVE backed by VALID evidence recorded no later than it
CREATE VIEW "signal_validation_eligibility" AS
SELECT v.id AS validation_id, v.signal_id, v.outcome, v.validated_at, sl.id AS stop_loss_validation_id, sl.result AS stop_loss_result, sl.reason_code AS stop_loss_reason_code,
	coalesce(v.outcome = 'APPROVE' AND sl.result = 'VALID', false) AS approval_eligible,
	CASE WHEN v.outcome <> 'APPROVE' THEN 'not_an_approval'
	     WHEN sl.id IS NULL THEN 'legacy_no_stop_loss_evidence'
	     WHEN sl.result = 'VALID' THEN 'stop_loss_valid'
	     ELSE 'stop_loss_not_valid' END AS eligibility_note
FROM signal_validations v
LEFT JOIN LATERAL (SELECT s.id, s.result, s.reason_code FROM stop_loss_validations s WHERE s.signal_id = v.signal_id AND s.created_at <= v.created_at ORDER BY s.chain_index DESC LIMIT 1) sl ON true;
