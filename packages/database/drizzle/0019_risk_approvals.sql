CREATE TABLE "risk_approval_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"risk_decision_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"nonce" text NOT NULL,
	"card_text" text NOT NULL,
	"card_content_sha256" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"telegram_message_id" bigint,
	"card_text_sha256" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "risk_approval_cards_state_check" CHECK ("risk_approval_cards"."state" in ('pending', 'sent', 'decided', 'expired')),
	CONSTRAINT "risk_approval_cards_shape_check" CHECK ("risk_approval_cards"."nonce" ~ '^[0-9a-f]{32}$' and "risk_approval_cards"."card_content_sha256" ~ '^[0-9a-f]{64}$' and length("risk_approval_cards"."card_text") between 1 and 3800 and ("risk_approval_cards"."card_text_sha256" is null or "risk_approval_cards"."card_text_sha256" = "risk_approval_cards"."card_content_sha256")),
	CONSTRAINT "risk_approval_cards_sent_check" CHECK (("risk_approval_cards"."state" in ('pending', 'expired')) or "risk_approval_cards"."telegram_message_id" is not null),
	CONSTRAINT "risk_approval_cards_actor_check" CHECK ("risk_approval_cards"."created_by" ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "risk_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"risk_decision_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"card_id" uuid,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"actor_context" jsonb NOT NULL,
	"reason" text,
	"decision_snapshot" jsonb NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"valid_until" timestamp with time zone,
	"card_text_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_approvals_action_check" CHECK ("risk_approvals"."action" in ('APPROVE', 'REJECT')),
	CONSTRAINT "risk_approvals_actor_check" CHECK ("risk_approvals"."actor" ~ '^(telegram|operator):[A-Za-z0-9._-]{1,64}$'),
	CONSTRAINT "risk_approvals_reject_reason_check" CHECK ("risk_approvals"."action" <> 'REJECT' or ("risk_approvals"."reason" is not null and length(btrim("risk_approvals"."reason")) > 0)),
	CONSTRAINT "risk_approvals_approve_validity_check" CHECK ("risk_approvals"."action" <> 'APPROVE' or "risk_approvals"."valid_until" is not null),
	CONSTRAINT "risk_approvals_reason_length_check" CHECK ("risk_approvals"."reason" is null or length("risk_approvals"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD CONSTRAINT "risk_approval_cards_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_approvals" ADD CONSTRAINT "risk_approvals_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_approvals" ADD CONSTRAINT "risk_approvals_card_id_risk_approval_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."risk_approval_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_approval_cards_decision_unique" ON "risk_approval_cards" USING btree ("risk_decision_id");--> statement-breakpoint
CREATE INDEX "risk_approval_cards_state_idx" ON "risk_approval_cards" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_approvals_decision_unique" ON "risk_approvals" USING btree ("risk_decision_id");
--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 3 / Task 6: risk approvals. `risk_approvals` is an immutable, hash-chained table (the eleventh chain) written
-- ONLY by the SECURITY DEFINER function below; `risk_approval_cards` is the workflow table the approval bot reads and advances only through SECURITY DEFINER functions.
ALTER TABLE "risk_approvals" ADD COLUMN "chain_index" bigint NOT NULL, ADD COLUMN "previous_hash" text NOT NULL, ADD COLUMN "payload_hash" text NOT NULL, ADD COLUMN "event_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_approvals" ADD CONSTRAINT "risk_approvals_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX "risk_approvals_chain_index_unique" ON "risk_approvals" USING btree ("chain_index");--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_risk_approvals"(r "risk_approvals") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.risk_decision_id::text, r.decision_version::text, r.card_id::text, r.action, r.actor, r.actor_context::text, r.reason, r.decision_snapshot::text, r.evidence_references::text,
		twins_audit_ts(r.valid_until), r.card_text_sha256, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE TRIGGER "risk_approvals_chain_before_insert" BEFORE INSERT ON "risk_approvals" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('risk_approvals');--> statement-breakpoint
CREATE TRIGGER "risk_approvals_chain_after_insert" AFTER INSERT ON "risk_approvals" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('risk_approvals');--> statement-breakpoint
CREATE TRIGGER "risk_approvals_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_approvals" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "risk_approvals_no_truncate" BEFORE TRUNCATE ON "risk_approvals" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
-- table-level guard (defence in depth, applies to every inserter): the row must match the decision version, and an APPROVE needs a currently approvable, un-superseded decision and no open loss breaker
CREATE FUNCTION "twins_risk_approval_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	d risk_decisions_effective%ROWTYPE;
BEGIN
	SELECT * INTO d FROM risk_decisions_effective WHERE id = NEW.risk_decision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'risk_approvals: the risk decision does not exist' USING ERRCODE = 'foreign_key_violation';
	END IF;
	IF d.decision_version <> NEW.decision_version THEN
		RAISE EXCEPTION 'risk_approvals: decision_version does not match the decision' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.action = 'APPROVE' THEN
		IF d.superseded_by_id IS NOT NULL OR d.status <> 'APPROVED_FOR_REVIEW' THEN
			RAISE EXCEPTION 'risk_approvals: only a current APPROVED_FOR_REVIEW decision can be approved' USING ERRCODE = 'check_violation';
		END IF;
		IF twins_circuit_breaker_open() THEN
			RAISE EXCEPTION 'risk_approvals: a loss circuit breaker is open; no approval is recorded' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "risk_approvals_a_integrity_before_insert" BEFORE INSERT ON "risk_approvals" FOR EACH ROW EXECUTE FUNCTION "twins_risk_approval_integrity"();--> statement-breakpoint
ALTER TABLE "risk_approvals" ENABLE ALWAYS TRIGGER "risk_approvals_a_integrity_before_insert", ENABLE ALWAYS TRIGGER "risk_approvals_chain_before_insert", ENABLE ALWAYS TRIGGER "risk_approvals_chain_after_insert", ENABLE ALWAYS TRIGGER "risk_approvals_no_update_delete", ENABLE ALWAYS TRIGGER "risk_approvals_no_truncate";--> statement-breakpoint
-- cards: content never changes, state only moves forward (pending -> sent -> decided; pending|sent -> expired), never deleted
CREATE FUNCTION "twins_risk_approval_card_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id <> OLD.id OR NEW.risk_decision_id <> OLD.risk_decision_id OR NEW.decision_version <> OLD.decision_version OR NEW.nonce <> OLD.nonce OR NEW.card_text <> OLD.card_text
		OR NEW.card_content_sha256 <> OLD.card_content_sha256 OR NEW.expires_at <> OLD.expires_at OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'risk_approval_cards: the card content is immutable' USING ERRCODE = '23001';
	END IF;
	IF NEW.state <> OLD.state AND NOT ((OLD.state = 'pending' AND NEW.state IN ('sent', 'expired')) OR (OLD.state = 'sent' AND NEW.state IN ('decided', 'expired'))) THEN
		RAISE EXCEPTION 'risk_approval_cards: invalid state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "risk_approval_cards_guard" BEFORE UPDATE ON "risk_approval_cards" FOR EACH ROW EXECUTE FUNCTION "twins_risk_approval_card_guard"();--> statement-breakpoint
CREATE TRIGGER "risk_approval_cards_no_delete" BEFORE DELETE ON "risk_approval_cards" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "risk_approval_cards_no_truncate" BEFORE TRUNCATE ON "risk_approval_cards" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ENABLE ALWAYS TRIGGER "risk_approval_cards_guard", ENABLE ALWAYS TRIGGER "risk_approval_cards_no_delete", ENABLE ALWAYS TRIGGER "risk_approval_cards_no_truncate";--> statement-breakpoint
-- bot door 1: the bot marks a card as sent (only a pending, unexpired card whose text hash is the card's own)
CREATE FUNCTION "twins_risk_card_mark_sent"(p_card_id uuid, p_message_id bigint, p_sha text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	n integer;
BEGIN
	UPDATE risk_approval_cards SET state = 'sent', telegram_message_id = p_message_id, card_text_sha256 = p_sha, sent_at = now()
	 WHERE id = p_card_id AND state = 'pending' AND card_content_sha256 = p_sha AND expires_at > now();
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n = 1;
END;
$$;--> statement-breakpoint
-- bot door 2: expire every card whose validity has passed; returns what the bot must edit in Telegram
CREATE FUNCTION "twins_risk_card_expire_due"() RETURNS TABLE (card_id uuid, message_id bigint) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
	UPDATE risk_approval_cards SET state = 'expired' WHERE state IN ('pending', 'sent') AND expires_at <= now() RETURNING id, telegram_message_id
$$;--> statement-breakpoint
-- THE door: records an APPROVE or REJECT of one risk-decision version. Re-checks eligibility AT THE MOMENT OF APPROVAL (never from stale state):
-- current (un-superseded) APPROVED_FOR_REVIEW decision, inside its validity, kill switch off, no open loss breaker, the latest stop-loss validation VALID and cited, and
-- sizing / portfolio / market all passed. A REJECT is risk-reducing and needs only an existing decision. Returns 'recorded', 'duplicate' or 'refused:<reason>'; it never creates an order.
CREATE FUNCTION "twins_record_risk_approval"(p_decision_id uuid, p_card_id uuid, p_action text, p_actor text, p_context jsonb, p_reason text, p_valid_until timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	d risk_decisions_effective%ROWTYPE;
	c risk_approval_cards%ROWTYPE;
	latest stop_loss_validations%ROWTYPE;
	killed boolean;
	valid_until timestamptz := p_valid_until;
	card_sha text;
	why text;
	reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
	IF p_action NOT IN ('APPROVE', 'REJECT') THEN
		RAISE EXCEPTION 'twins_record_risk_approval: action must be APPROVE or REJECT' USING ERRCODE = 'check_violation';
	END IF;
	IF p_actor IS NULL OR p_actor !~ '^(telegram|operator):[A-Za-z0-9._-]{1,64}$' THEN
		RAISE EXCEPTION 'twins_record_risk_approval: actor must be telegram:<id> or operator:<name>' USING ERRCODE = 'check_violation';
	END IF;
	IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN
		RAISE EXCEPTION 'twins_record_risk_approval: context must be a JSON object' USING ERRCODE = 'check_violation';
	END IF;
	IF p_action = 'REJECT' AND reason IS NULL THEN reason := 'rejected_by_reviewer'; END IF;
	PERFORM pg_advisory_xact_lock(1953722, hashtext(p_decision_id::text));
	SELECT * INTO d FROM risk_decisions_effective WHERE id = p_decision_id;
	IF NOT FOUND THEN RETURN 'refused:decision_not_found'; END IF;
	IF EXISTS (SELECT 1 FROM risk_approvals WHERE risk_decision_id = p_decision_id) THEN RETURN 'duplicate'; END IF;
	IF p_card_id IS NOT NULL THEN
		SELECT * INTO c FROM risk_approval_cards WHERE id = p_card_id FOR UPDATE;
		IF NOT FOUND OR c.risk_decision_id <> p_decision_id THEN RETURN 'refused:card_not_found'; END IF;
		IF c.expires_at <= now() THEN RETURN 'refused:card_expired'; END IF;
		IF c.state <> 'sent' OR c.telegram_message_id IS DISTINCT FROM nullif(p_context ->> 'cardMessageId', '')::bigint THEN RETURN 'refused:card_not_active'; END IF;
		valid_until := c.expires_at;
		card_sha := c.card_text_sha256;
	END IF;
	IF p_action = 'APPROVE' THEN
		why := CASE
			WHEN d.superseded_by_id IS NOT NULL THEN 'decision_superseded'
			WHEN d.status <> 'APPROVED_FOR_REVIEW' THEN 'decision_not_approved_for_review'
			WHEN valid_until IS NULL OR valid_until <= now() THEN 'decision_expired'
			WHEN valid_until > d.created_at + interval '24 hours' THEN 'validity_out_of_range'
			ELSE NULL END;
		IF why IS NULL THEN
			SELECT value INTO killed FROM system_controls WHERE control_name = 'KILL_SWITCH_ACTIVE';
			IF NOT FOUND OR killed IS NULL THEN why := 'state_unavailable';
			ELSIF killed THEN why := 'kill_switch_active';
			ELSIF twins_circuit_breaker_open() THEN why := 'circuit_breaker_open';
			END IF;
		END IF;
		IF why IS NULL THEN
			SELECT * INTO latest FROM stop_loss_validations s WHERE s.signal_id IS NOT DISTINCT FROM d.signal_id AND s.options_claim_id IS NOT DISTINCT FROM d.options_claim_id ORDER BY s.chain_index DESC LIMIT 1;
			IF NOT FOUND OR latest.id <> d.stop_loss_validation_id OR latest.result <> 'VALID' THEN why := 'stop_loss_not_valid';
			ELSIF coalesce(d.output_snapshot #>> '{sizing,status}', '') <> 'SIZED' OR coalesce(d.planned_quantity, 0) <= 0 OR coalesce(d.planned_max_loss_amount, 0) <= 0 THEN why := 'sizing_missing';
			ELSIF coalesce(d.output_snapshot #>> '{portfolio,outcome}', '') <> 'APPROVED_FOR_REVIEW' THEN why := 'portfolio_not_passed';
			ELSIF coalesce(d.output_snapshot #>> '{market,outcome}', '') <> 'PASSED' THEN why := 'market_not_passed';
			END IF;
		END IF;
		IF why IS NOT NULL THEN
			IF p_card_id IS NOT NULL THEN UPDATE risk_approval_cards SET state = 'expired' WHERE id = p_card_id AND state IN ('pending', 'sent'); END IF;
			RETURN 'refused:' || why;
		END IF;
	END IF;
	INSERT INTO risk_approvals (id, risk_decision_id, decision_version, card_id, action, actor, actor_context, reason, decision_snapshot, evidence_references, valid_until, card_text_sha256)
	VALUES (gen_random_uuid(), d.id, d.decision_version, p_card_id, p_action, p_actor, p_context, reason,
		jsonb_build_object('riskDecisionId', d.id, 'decisionVersion', d.decision_version, 'status', d.status, 'market', d.market, 'instrumentType', d.instrument_type, 'symbol', d.symbol, 'expiry', d.expiry, 'strike', d.strike,
			'optionType', d.option_type, 'side', d.side, 'entryPrice', d.entry_price, 'stopLoss', d.stop_loss, 'stopLossBasis', d.stop_loss_basis, 'targets', jsonb_build_array(d.target_1, d.target_2, d.target_3),
			'plannedQuantity', d.planned_quantity, 'plannedNotional', d.planned_notional, 'plannedMaxLossAmount', d.planned_max_loss_amount, 'plannedMaxLossPercent', d.planned_max_loss_percent,
			'plannedRiskRewardRatio', d.planned_risk_reward_ratio, 'confidenceScore', d.confidence_score, 'sourceTrustTier', d.source_trust_tier, 'createdAt', d.created_at, 'outputSnapshot', d.output_snapshot),
		d.evidence_references || jsonb_build_object('stopLossValidationId', d.stop_loss_validation_id, 'riskDecisionId', d.id), valid_until, card_sha);
	IF p_card_id IS NOT NULL THEN UPDATE risk_approval_cards SET state = 'decided', decided_at = now() WHERE id = p_card_id; END IF;
	RETURN 'recorded';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "twins_risk_card_mark_sent"(uuid, bigint, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "twins_risk_card_expire_due"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "twins_record_risk_approval"(uuid, uuid, text, text, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
-- the future approval-to-order step: an order also needs a recorded APPROVE for its decision (no order path exists; the table is empty)
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
	IF NOT EXISTS (SELECT 1 FROM risk_approvals a WHERE a.risk_decision_id = NEW.risk_decision_id AND a.action = 'APPROVE') THEN
		RAISE EXCEPTION 'orders: the risk decision has no recorded APPROVE approval' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DISABLE TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_name_check", ADD CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events', 'stop_loss_validations', 'risk_decisions', 'loss_events', 'circuit_breaker_events', 'event_blackout_windows', 'risk_approvals'));--> statement-breakpoint
INSERT INTO "audit_chain_heads" ("chain_name", "last_index", "last_hash") VALUES ('risk_approvals', 0, repeat('0', 64));--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|stop_loss_validations|risk_decisions|loss_events|circuit_breaker_events|event_blackout_windows|risk_approvals|risk_approval_cards|twins_audit_|twins_risk_decision|twins_risk_approval|twins_risk_card|twins_record_risk_approval|twins_circuit_breaker|twins_event_blackout|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate|_stop_loss_|orders_require_risk_decision|_breaker_)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;
