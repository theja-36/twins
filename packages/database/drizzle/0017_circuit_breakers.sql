CREATE TABLE "circuit_breaker_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"event_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"loss_amount" numeric NOT NULL,
	"limit_amount" numeric NOT NULL,
	"capital" numeric NOT NULL,
	"loss_pct" numeric NOT NULL,
	"planned_exposure_amount" numeric NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text,
	"breach_event_id" uuid,
	"reset_authorization" text,
	"idempotency_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circuit_breaker_events_scope_check" CHECK ("circuit_breaker_events"."scope" in ('DAILY', 'WEEKLY')),
	CONSTRAINT "circuit_breaker_events_type_check" CHECK ("circuit_breaker_events"."event_type" in ('WARNED', 'BREACHED', 'RESET')),
	CONSTRAINT "circuit_breaker_events_numbers_check" CHECK ("circuit_breaker_events"."loss_amount" >= 0 and "circuit_breaker_events"."limit_amount" > 0 and "circuit_breaker_events"."capital" > 0 and "circuit_breaker_events"."loss_pct" >= 0 and "circuit_breaker_events"."planned_exposure_amount" >= 0 and "circuit_breaker_events"."period_end" > "circuit_breaker_events"."period_start"),
	CONSTRAINT "circuit_breaker_events_reset_shape_check" CHECK (("circuit_breaker_events"."event_type" = 'RESET') = ("circuit_breaker_events"."breach_event_id" is not null) and ("circuit_breaker_events"."event_type" = 'RESET') = ("circuit_breaker_events"."reset_authorization" is not null)),
	CONSTRAINT "circuit_breaker_events_actor_check" CHECK ("circuit_breaker_events"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "loss_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"risk_decision_id" uuid,
	"idempotency_key" text NOT NULL,
	"details" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loss_events_amount_check" CHECK ("loss_events"."amount" > 0),
	CONSTRAINT "loss_events_source_check" CHECK ("loss_events"."source" in ('synthetic', 'manual_adjustment', 'broker_reconciliation')),
	CONSTRAINT "loss_events_actor_check" CHECK ("loss_events"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "loss_events" ADD CONSTRAINT "loss_events_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "circuit_breaker_events_idempotency_unique" ON "circuit_breaker_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "circuit_breaker_events_breach_unique" ON "circuit_breaker_events" USING btree ("breach_event_id");--> statement-breakpoint
CREATE INDEX "circuit_breaker_events_scope_idx" ON "circuit_breaker_events" USING btree ("scope","event_type","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "loss_events_idempotency_unique" ON "loss_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "loss_events_source_ref_unique" ON "loss_events" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "loss_events_occurred_idx" ON "loss_events" USING btree ("occurred_at");--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 3 / Task 4: immutable, hash-chained loss events and circuit-breaker events; the breaker gate on approvals and orders.
ALTER TABLE "circuit_breaker_events" ADD CONSTRAINT "circuit_breaker_events_breach_event_id_fk" FOREIGN KEY ("breach_event_id") REFERENCES "public"."circuit_breaker_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- 1. audit chain columns, payload functions (version 1 of each payload; same hash definition and domain as 0010/0011/0014), guards
ALTER TABLE "loss_events" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "loss_events" ADD CONSTRAINT "loss_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "loss_events_chain_index_unique" ON "loss_events" USING btree ("chain_index");--> statement-breakpoint
ALTER TABLE "circuit_breaker_events" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "circuit_breaker_events" ADD CONSTRAINT "circuit_breaker_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "circuit_breaker_events_chain_index_unique" ON "circuit_breaker_events" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_loss_events"(r "loss_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.amount::text, r.currency, twins_audit_ts(r.occurred_at), r.source, r.source_ref, r.risk_decision_id::text, r.idempotency_key, r.details::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_circuit_breaker_events"(r "circuit_breaker_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.scope, r.event_type, twins_audit_ts(r.period_start), twins_audit_ts(r.period_end), r.loss_amount::text, r.limit_amount::text, r.capital::text, r.loss_pct::text,
		r.planned_exposure_amount::text, r.reason_code, r.reason, r.breach_event_id::text, r.reset_authorization, r.idempotency_key, r.snapshot::text, r.created_by, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "loss_events_chain_before_insert" BEFORE INSERT ON "loss_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('loss_events');--> statement-breakpoint
CREATE TRIGGER "loss_events_chain_after_insert" AFTER INSERT ON "loss_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('loss_events');--> statement-breakpoint
CREATE TRIGGER "loss_events_no_update_delete" BEFORE UPDATE OR DELETE ON "loss_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "loss_events_no_truncate" BEFORE TRUNCATE ON "loss_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "circuit_breaker_events_chain_before_insert" BEFORE INSERT ON "circuit_breaker_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('circuit_breaker_events');--> statement-breakpoint
CREATE TRIGGER "circuit_breaker_events_chain_after_insert" AFTER INSERT ON "circuit_breaker_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('circuit_breaker_events');--> statement-breakpoint
CREATE TRIGGER "circuit_breaker_events_no_update_delete" BEFORE UPDATE OR DELETE ON "circuit_breaker_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "circuit_breaker_events_no_truncate" BEFORE TRUNCATE ON "circuit_breaker_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- 2. a RESET must concern a BREACHED row of the same scope (and cannot precede the reset time it records)
CREATE FUNCTION "twins_circuit_breaker_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	b circuit_breaker_events%ROWTYPE;
BEGIN
	IF NEW.event_type = 'RESET' THEN
		SELECT * INTO b FROM circuit_breaker_events WHERE id = NEW.breach_event_id;
		IF NOT FOUND OR b.event_type <> 'BREACHED' OR b.scope <> NEW.scope THEN
			RAISE EXCEPTION 'circuit_breaker_events: a RESET must reference a BREACHED event of the same scope' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "circuit_breaker_events_a_integrity_before_insert" BEFORE INSERT ON "circuit_breaker_events" FOR EACH ROW EXECUTE FUNCTION "twins_circuit_breaker_integrity"();--> statement-breakpoint
-- 3. the breaker gate in the database: open while a BREACHED event's reset time is in the future and nothing resets it. Approvals and orders are refused while open.
CREATE FUNCTION "twins_circuit_breaker_open"() RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (SELECT 1 FROM circuit_breaker_events b WHERE b.event_type = 'BREACHED' AND b.period_end > now() AND NOT EXISTS (SELECT 1 FROM circuit_breaker_events r WHERE r.breach_event_id = b.id))
$$;--> statement-breakpoint
CREATE FUNCTION "twins_risk_decision_breaker_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status = 'APPROVED_FOR_REVIEW' AND twins_circuit_breaker_open() THEN
		RAISE EXCEPTION 'risk_decisions: a loss circuit breaker is open; APPROVED_FOR_REVIEW is refused' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "risk_decisions_b_breaker_before_insert" BEFORE INSERT ON "risk_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_risk_decision_breaker_gate"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "orders_require_risk_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
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
	IF twins_circuit_breaker_open() THEN
		RAISE EXCEPTION 'orders: a loss circuit breaker is open; no order may be created' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER TABLE "loss_events" ENABLE ALWAYS TRIGGER "loss_events_chain_before_insert", ENABLE ALWAYS TRIGGER "loss_events_chain_after_insert", ENABLE ALWAYS TRIGGER "loss_events_no_update_delete", ENABLE ALWAYS TRIGGER "loss_events_no_truncate";--> statement-breakpoint
ALTER TABLE "circuit_breaker_events" ENABLE ALWAYS TRIGGER "circuit_breaker_events_a_integrity_before_insert", ENABLE ALWAYS TRIGGER "circuit_breaker_events_chain_before_insert", ENABLE ALWAYS TRIGGER "circuit_breaker_events_chain_after_insert", ENABLE ALWAYS TRIGGER "circuit_breaker_events_no_update_delete", ENABLE ALWAYS TRIGGER "circuit_breaker_events_no_truncate";--> statement-breakpoint
ALTER TABLE "risk_decisions" ENABLE ALWAYS TRIGGER "risk_decisions_b_breaker_before_insert";--> statement-breakpoint
-- 4. the chains' heads (the heads table refuses direct writes: lift its guard for this migration transaction only; the DDL watch records these statements)
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('loss_events', 0, repeat('0', 64)), ('circuit_breaker_events', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|risk_decisions|loss_events|circuit_breaker_events|twins_audit_|twins_risk_decision|twins_circuit_breaker|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_|orders_require_risk_decision|_breaker_)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;
