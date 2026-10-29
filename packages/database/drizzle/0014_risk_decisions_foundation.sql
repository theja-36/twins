-- HAND-WRITTEN GUARD (before anything else): the pre-Stage-3 risk_decisions table was never written by any code. If an environment nevertheless holds rows or orders,
-- stop here instead of reinterpreting them; nothing is changed and no history is rewritten.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM "risk_decisions") THEN RAISE EXCEPTION 'migration 0014: legacy risk_decisions rows exist; resolve them manually before migrating' USING ERRCODE = 'check_violation'; END IF;
	IF EXISTS (SELECT 1 FROM "orders") THEN RAISE EXCEPTION 'migration 0014: orders exist; resolve them manually before migrating' USING ERRCODE = 'check_violation'; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "risk_decisions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "risk_decisions" ALTER COLUMN "decision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_decisions" ALTER COLUMN "approved" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "signal_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "options_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "stop_loss_validation_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "decision_version" integer;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "instrument_type" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "market" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "expiry" date;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "strike" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "option_type" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "side" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "entry_price" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "stop_loss" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "stop_loss_basis" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "target_1" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "target_2" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "target_3" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "planned_quantity" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "planned_notional" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "planned_max_loss_amount" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "planned_max_loss_percent" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "planned_risk_reward_ratio" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "confidence_score" numeric;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "source_trust_tier" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "decision_reason_code" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "input_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "output_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "evidence_references" jsonb;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_options_claim_id_options_claims_id_fk" FOREIGN KEY ("options_claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_stop_loss_validation_id_stop_loss_validations_id_fk" FOREIGN KEY ("stop_loss_validation_id") REFERENCES "public"."stop_loss_validations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_decisions_signal_idx" ON "risk_decisions" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "risk_decisions_claim_idx" ON "risk_decisions" USING btree ("options_claim_id");--> statement-breakpoint
CREATE INDEX "risk_decisions_stop_loss_idx" ON "risk_decisions" USING btree ("stop_loss_validation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_decisions_supersedes_unique" ON "risk_decisions" USING btree ("supersedes_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_decisions_idempotency_unique" ON "risk_decisions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_decisions_first_signal_unique" ON "risk_decisions" USING btree ("signal_id") WHERE "risk_decisions"."supersedes_id" is null and "risk_decisions"."signal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_decisions_first_claim_unique" ON "risk_decisions" USING btree ("options_claim_id") WHERE "risk_decisions"."supersedes_id" is null and "risk_decisions"."options_claim_id" is not null;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_status_check" CHECK ("risk_decisions"."status" in ('PENDING', 'APPROVED_FOR_REVIEW', 'REJECTED', 'EXPIRED', 'SUPERSEDED'));--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_subject_check" CHECK (("risk_decisions"."signal_id" is not null) <> ("risk_decisions"."options_claim_id" is not null));--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_legacy_null_check" CHECK ("risk_decisions"."decision_id" is null and "risk_decisions"."approved" is null and "risk_decisions"."reasons" is null and "risk_decisions"."max_position_size" is null and "risk_decisions"."risk_per_trade" is null);--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_required_check" CHECK ("risk_decisions"."stop_loss_validation_id" is not null and "risk_decisions"."decision_version" >= 1 and "risk_decisions"."status" is not null and "risk_decisions"."idempotency_key" is not null and "risk_decisions"."input_snapshot" is not null and "risk_decisions"."evidence_references" is not null and "risk_decisions"."decision_reason_code" is not null and "risk_decisions"."created_by" is not null and "risk_decisions"."instrument_type" is not null and "risk_decisions"."symbol" is not null);--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_version_check" CHECK (("risk_decisions"."supersedes_id" is null) = ("risk_decisions"."decision_version" = 1));--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_numbers_check" CHECK (("risk_decisions"."entry_price" is null or "risk_decisions"."entry_price" > 0) and ("risk_decisions"."stop_loss" is null or "risk_decisions"."stop_loss" > 0) and ("risk_decisions"."target_1" is null or "risk_decisions"."target_1" > 0) and ("risk_decisions"."target_2" is null or "risk_decisions"."target_2" > 0) and ("risk_decisions"."target_3" is null or "risk_decisions"."target_3" > 0) and ("risk_decisions"."strike" is null or "risk_decisions"."strike" > 0) and ("risk_decisions"."planned_quantity" is null or "risk_decisions"."planned_quantity" >= 0) and ("risk_decisions"."planned_notional" is null or "risk_decisions"."planned_notional" >= 0) and ("risk_decisions"."planned_max_loss_amount" is null or "risk_decisions"."planned_max_loss_amount" >= 0) and ("risk_decisions"."planned_max_loss_percent" is null or "risk_decisions"."planned_max_loss_percent" >= 0) and ("risk_decisions"."planned_risk_reward_ratio" is null or "risk_decisions"."planned_risk_reward_ratio" >= 0) and ("risk_decisions"."confidence_score" is null or ("risk_decisions"."confidence_score" >= 0 and "risk_decisions"."confidence_score" <= 100)));--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_review_shape_check" CHECK ("risk_decisions"."status" <> 'APPROVED_FOR_REVIEW' or ("risk_decisions"."stop_loss" is not null and "risk_decisions"."entry_price" is not null and "risk_decisions"."stop_loss_basis" is not null));--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_actor_check" CHECK ("risk_decisions"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$');
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 3 / Task 1: immutable, hash-chained risk decisions.
-- 1. self reference for the version chain (a row may be superseded by at most one successor: unique index above)
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_supersedes_id_risk_decisions_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- 2. audit chain columns, payload function (version 1 of this table's payload; same hash definition and domain as 0010/0011), guards, head
ALTER TABLE "risk_decisions" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "risk_decisions_chain_index_unique" ON "risk_decisions" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_risk_decisions"(r "risk_decisions") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.signal_id::text, r.options_claim_id::text, r.stop_loss_validation_id::text, r.supersedes_id::text, r.decision_version::text, r.status, r.idempotency_key,
		r.instrument_type, r.market, r.symbol, r.expiry::text, r.strike::text, r.option_type, r.side, r.entry_price::text, r.stop_loss::text, r.stop_loss_basis, r.target_1::text, r.target_2::text, r.target_3::text,
		r.planned_quantity::text, r.planned_notional::text, r.planned_max_loss_amount::text, r.planned_max_loss_percent::text, r.planned_risk_reward_ratio::text, r.confidence_score::text, r.source_trust_tier,
		r.decision_reason_code, r.decision_reason, r.input_snapshot::text, r.output_snapshot::text, r.evidence_references::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "risk_decisions_chain_before_insert" BEFORE INSERT ON "risk_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('risk_decisions');--> statement-breakpoint
CREATE TRIGGER "risk_decisions_chain_after_insert" AFTER INSERT ON "risk_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('risk_decisions');--> statement-breakpoint
CREATE TRIGGER "risk_decisions_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "risk_decisions_no_truncate" BEFORE TRUNCATE ON "risk_decisions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- 3. integrity: the subject, the stop-loss evidence and the version chain are checked BEFORE the chain row is assigned (trigger name sorts first)
CREATE FUNCTION "twins_risk_decision_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v stop_loss_validations%ROWTYPE;
	p risk_decisions%ROWTYPE;
	latest uuid;
BEGIN
	IF NEW.status = 'SUPERSEDED' THEN
		RAISE EXCEPTION 'risk_decisions: SUPERSEDED is derived from a successor row and is never stored' USING ERRCODE = 'check_violation';
	END IF;
	SELECT * INTO v FROM stop_loss_validations WHERE id = NEW.stop_loss_validation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'risk_decisions: the stop-loss validation evidence does not exist' USING ERRCODE = 'foreign_key_violation';
	END IF;
	IF v.signal_id IS DISTINCT FROM NEW.signal_id OR v.options_claim_id IS DISTINCT FROM NEW.options_claim_id THEN
		RAISE EXCEPTION 'risk_decisions: the stop-loss validation belongs to a different subject' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status = 'APPROVED_FOR_REVIEW' THEN
		IF v.result <> 'VALID' THEN
			RAISE EXCEPTION 'risk_decisions: APPROVED_FOR_REVIEW requires a VALID stop-loss validation (got %)', v.result USING ERRCODE = 'check_violation';
		END IF;
		SELECT s.id INTO latest FROM stop_loss_validations s WHERE s.signal_id IS NOT DISTINCT FROM NEW.signal_id AND s.options_claim_id IS NOT DISTINCT FROM NEW.options_claim_id ORDER BY s.chain_index DESC LIMIT 1;
		IF latest IS DISTINCT FROM v.id THEN
			RAISE EXCEPTION 'risk_decisions: APPROVED_FOR_REVIEW must cite the LATEST stop-loss validation of the subject' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.stop_loss IS DISTINCT FROM v.normalized_stop_loss OR NEW.entry_price IS DISTINCT FROM v.entry_price THEN
			RAISE EXCEPTION 'risk_decisions: stop-loss and entry price must equal the validated values' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF NEW.supersedes_id IS NULL THEN
		IF NEW.decision_version <> 1 THEN RAISE EXCEPTION 'risk_decisions: the first version must be 1' USING ERRCODE = 'check_violation'; END IF;
	ELSE
		SELECT * INTO p FROM risk_decisions WHERE id = NEW.supersedes_id;
		IF NOT FOUND THEN RAISE EXCEPTION 'risk_decisions: the superseded decision does not exist' USING ERRCODE = 'foreign_key_violation'; END IF;
		IF p.signal_id IS DISTINCT FROM NEW.signal_id OR p.options_claim_id IS DISTINCT FROM NEW.options_claim_id THEN
			RAISE EXCEPTION 'risk_decisions: a revision must concern the same signal or options claim' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.decision_version <> p.decision_version + 1 THEN
			RAISE EXCEPTION 'risk_decisions: decision_version must be the predecessor''s plus one' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "risk_decisions_a_integrity_before_insert" BEFORE INSERT ON "risk_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_risk_decision_integrity"();--> statement-breakpoint
ALTER TABLE "risk_decisions" ENABLE ALWAYS TRIGGER "risk_decisions_a_integrity_before_insert", ENABLE ALWAYS TRIGGER "risk_decisions_chain_before_insert", ENABLE ALWAYS TRIGGER "risk_decisions_chain_after_insert", ENABLE ALWAYS TRIGGER "risk_decisions_no_update_delete", ENABLE ALWAYS TRIGGER "risk_decisions_no_truncate";--> statement-breakpoint
-- 4. the chain's head (the heads table refuses direct writes: lift its guard for this migration transaction only; the DDL watch records these statements)
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('risk_decisions', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|risk_decisions|twins_audit_|twins_risk_decision|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_|orders_require_risk_decision)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;--> statement-breakpoint
-- 5. the derived view: effective status, superseded_by_id and superseded_at come from the successor row (a decision row itself never changes)
CREATE VIEW "risk_decisions_effective" AS
SELECT d.*, s.id AS superseded_by_id, s.created_at AS superseded_at,
	CASE WHEN s.id IS NOT NULL THEN 'SUPERSEDED' ELSE d.status END AS effective_status
FROM risk_decisions d
LEFT JOIN risk_decisions s ON s.supersedes_id = d.id;--> statement-breakpoint
-- 6. the mandatory link to orders: NO order can be created without a risk decision that is currently APPROVED_FOR_REVIEW and not superseded.
-- (No order path exists yet and the orders table is empty; this fixes the structure for every later stage, execution included.)
CREATE FUNCTION "orders_require_risk_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	eff text;
BEGIN
	IF NEW.risk_decision_id IS NULL THEN
		RAISE EXCEPTION 'orders: an order requires a risk decision' USING ERRCODE = 'check_violation';
	END IF;
	SELECT effective_status INTO eff FROM risk_decisions_effective WHERE id = NEW.risk_decision_id;
	IF eff IS DISTINCT FROM 'APPROVED_FOR_REVIEW' THEN
		RAISE EXCEPTION 'orders: the risk decision must be APPROVED_FOR_REVIEW and not superseded (is %)', coalesce(eff, 'missing') USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "orders_require_risk_decision" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION "orders_require_risk_decision"();--> statement-breakpoint
ALTER TABLE "orders" ENABLE ALWAYS TRIGGER "orders_require_risk_decision";
