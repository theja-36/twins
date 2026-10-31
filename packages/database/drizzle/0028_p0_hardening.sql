CREATE TABLE "agent_engine_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_engine_state_single_row_check" CHECK ("agent_engine_state"."id" = 1),
	CONSTRAINT "agent_engine_state_version_check" CHECK ("agent_engine_state"."version" >= 1),
	CONSTRAINT "agent_engine_state_reason_check" CHECK (char_length(btrim("agent_engine_state"."reason")) between 8 and 500),
	CONSTRAINT "agent_engine_state_changed_by_check" CHECK ("agent_engine_state"."changed_by" ~ '^[A-Za-z0-9._@:-]{2,64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_engine_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"previous_value" boolean,
	"new_value" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_engine_state_events_type_check" CHECK ("agent_engine_state_events"."event_type" in ('seed', 'change')),
	CONSTRAINT "agent_engine_state_events_previous_check" CHECK (("agent_engine_state_events"."event_type" = 'seed') = ("agent_engine_state_events"."previous_value" is null))
);
--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD COLUMN "research_run_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD COLUMN "research_assessment" text;--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD COLUMN "research_synthesis_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_engine_state_events_version_unique" ON "agent_engine_state_events" USING btree ("version");--> statement-breakpoint
CREATE INDEX "agent_engine_state_events_time_idx" ON "agent_engine_state_events" USING btree ("changed_at");--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD CONSTRAINT "risk_approval_cards_research_run_id_agent_orchestrator_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."agent_orchestrator_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_approval_cards" ADD CONSTRAINT "risk_approval_cards_research_check" CHECK (("risk_approval_cards"."research_run_id" is null) = ("risk_approval_cards"."research_assessment" is null) and ("risk_approval_cards"."research_run_id" is null) = ("risk_approval_cards"."research_synthesis_sha256" is null) and ("risk_approval_cards"."research_synthesis_sha256" is null or "risk_approval_cards"."research_synthesis_sha256" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
-- HAND-WRITTEN. P0 hardening (HB-01 .. HB-04). Everything above is drizzle-kit output.
-- HB-01: a card cites the exact orchestrator run (assessment and synthesis hash) it was created against; the approval function refuses unless the cited run is still the latest, and records the run in the immutable
--        approval row (decision_snapshot.research and evidence_references.researchRun*, both inside the hash-chain payload).
-- HB-02: a later non-adverse run cannot clear an earlier ADVERSE / BLOCKED run unless the evidence of every agent that gave the adverse / blocking verdict has CHANGED (see twins_research_assessment).
-- HB-03: agent_engine_state tells the database whether the engine is enabled, so a missing assessment is refused here as well.
-- HB-04: explicit read grants for the runtime role live in infrastructure/staging/app-role.sql.
-- Immutable card content now includes the research reference.
CREATE OR REPLACE FUNCTION "twins_risk_approval_card_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id <> OLD.id OR NEW.risk_decision_id <> OLD.risk_decision_id OR NEW.decision_version <> OLD.decision_version OR NEW.nonce <> OLD.nonce OR NEW.card_text <> OLD.card_text
		OR NEW.card_content_sha256 <> OLD.card_content_sha256 OR NEW.expires_at <> OLD.expires_at OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
		OR NEW.research_run_id IS DISTINCT FROM OLD.research_run_id OR NEW.research_assessment IS DISTINCT FROM OLD.research_assessment OR NEW.research_synthesis_sha256 IS DISTINCT FROM OLD.research_synthesis_sha256 THEN
		RAISE EXCEPTION 'risk_approval_cards: the card content is immutable' USING ERRCODE = '23001';
	END IF;
	IF NEW.state <> OLD.state AND NOT ((OLD.state = 'pending' AND NEW.state IN ('sent', 'expired')) OR (OLD.state = 'sent' AND NEW.state IN ('decided', 'expired'))) THEN
		RAISE EXCEPTION 'risk_approval_cards: invalid state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- agent_engine_state: one row, changes audited like system_controls, never deleted
CREATE FUNCTION "agent_engine_state_before_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'agent_engine_state: id is immutable' USING ERRCODE = 'restrict_violation'; END IF;
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN RAISE EXCEPTION 'agent_engine_state: version must increase by exactly 1' USING ERRCODE = 'restrict_violation'; END IF;
	IF NEW.enabled IS NOT DISTINCT FROM OLD.enabled THEN RAISE EXCEPTION 'agent_engine_state: a change must flip the value' USING ERRCODE = 'restrict_violation'; END IF;
	IF NEW.reason IS NOT DISTINCT FROM OLD.reason THEN RAISE EXCEPTION 'agent_engine_state: a change must state a new reason' USING ERRCODE = 'restrict_violation'; END IF;
	NEW.changed_at := clock_timestamp();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "agent_engine_state_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO agent_engine_state_events (previous_value, new_value, reason, changed_by, changed_at, version, event_type) VALUES (NULL, NEW.enabled, NEW.reason, NEW.changed_by, NEW.changed_at, NEW.version, 'seed');
	ELSE
		INSERT INTO agent_engine_state_events (previous_value, new_value, reason, changed_by, changed_at, version, event_type) VALUES (OLD.enabled, NEW.enabled, NEW.reason, NEW.changed_by, NEW.changed_at, NEW.version, 'change');
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "agent_engine_state_forbid"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '%: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_guard" BEFORE UPDATE ON "agent_engine_state" FOR EACH ROW EXECUTE FUNCTION "agent_engine_state_before_update"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_audit_insert" AFTER INSERT ON "agent_engine_state" FOR EACH ROW EXECUTE FUNCTION "agent_engine_state_audit"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_audit_update" AFTER UPDATE ON "agent_engine_state" FOR EACH ROW EXECUTE FUNCTION "agent_engine_state_audit"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_no_delete" BEFORE DELETE ON "agent_engine_state" FOR EACH ROW EXECUTE FUNCTION "agent_engine_state_forbid"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_no_truncate" BEFORE TRUNCATE ON "agent_engine_state" FOR EACH STATEMENT EXECUTE FUNCTION "agent_engine_state_forbid"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_events_no_update_delete" BEFORE UPDATE OR DELETE ON "agent_engine_state_events" FOR EACH ROW EXECUTE FUNCTION "agent_engine_state_forbid"();--> statement-breakpoint
CREATE TRIGGER "agent_engine_state_events_no_truncate" BEFORE TRUNCATE ON "agent_engine_state_events" FOR EACH STATEMENT EXECUTE FUNCTION "agent_engine_state_forbid"();--> statement-breakpoint
INSERT INTO "agent_engine_state" ("id", "enabled", "version", "reason", "changed_by") VALUES (1, false, 1, 'initial seed: migration 0028 default (engine not enabled)', 'migration');--> statement-breakpoint
-- evidence fingerprint of ONE agent in ONE orchestrator run: what the agent actually cited (kind, ref, hash), in order. Empty when the agent cited nothing.
CREATE FUNCTION "twins_agent_evidence_fp"(p_run uuid, p_agent text) RETURNS text LANGUAGE sql STABLE AS $$
	SELECT coalesce((SELECT md5(string_agg(e.kind || ':' || e.ref || ':' || coalesce(e.ref_sha256, ''), ',' ORDER BY e.ordinal))
		FROM agent_runs a JOIN agent_evidence_references e ON e.agent_run_id = a.id
		WHERE a.orchestrator_run_id = p_run AND a.agent_id = p_agent AND a.status = 'COMPLETED'), '')
$$;--> statement-breakpoint
-- The research assessment that stands for a decision lineage: the LATEST run among the versions of the signal / options claim that are not newer than the decision (zero rows = no assessment).
-- refusal is NULL when the assessment does not stand in the way. HB-02: when the latest run is better than an EARLIER ADVERSE / BLOCKED run, it only clears that run if every agent that
-- gave an ADVERSE / BLOCKING verdict there (or, when none did, at least one agent) now cites DIFFERENT, non-empty evidence. A re-run with the same evidence, a configuration change or a
-- new decision version over the same evidence cannot turn an adverse result into an acceptable one.
CREATE FUNCTION "twins_research_assessment"(p_signal uuid, p_claim uuid, p_version integer) RETURNS TABLE (run_id uuid, assessment text, synthesis_sha256 text, refusal text) LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
	l record;
	b record;
	flagged text[];
	cleared boolean;
BEGIN
	SELECT o.id AS id, o.created_at AS at, s.assessment AS assessment, s.synthesis_input_sha256 AS sha INTO l
		FROM agent_orchestrator_runs o JOIN agent_orchestrator_syntheses s ON s.orchestrator_run_id = o.id JOIN risk_decisions rd ON rd.id = o.risk_decision_id
		WHERE rd.signal_id IS NOT DISTINCT FROM p_signal AND rd.options_claim_id IS NOT DISTINCT FROM p_claim AND rd.decision_version <= p_version
		ORDER BY o.created_at DESC, o.id DESC LIMIT 1;
	IF NOT FOUND THEN RETURN; END IF;
	run_id := l.id; assessment := l.assessment; synthesis_sha256 := l.sha;
	refusal := CASE l.assessment WHEN 'RESEARCH_BLOCKED' THEN 'research_assessment_blocked' WHEN 'RESEARCH_INCOMPLETE' THEN 'research_assessment_incomplete' WHEN 'RESEARCH_ADVERSE' THEN 'research_assessment_adverse' ELSE NULL END;
	IF refusal IS NULL THEN
		SELECT o.id AS id, s.assessment AS assessment INTO b
			FROM agent_orchestrator_runs o JOIN agent_orchestrator_syntheses s ON s.orchestrator_run_id = o.id JOIN risk_decisions rd ON rd.id = o.risk_decision_id
			WHERE rd.signal_id IS NOT DISTINCT FROM p_signal AND rd.options_claim_id IS NOT DISTINCT FROM p_claim AND rd.decision_version <= p_version
				AND s.assessment IN ('RESEARCH_ADVERSE', 'RESEARCH_BLOCKED') AND o.id <> l.id AND (o.created_at, o.id) < (l.at, l.id)
			ORDER BY o.created_at DESC, o.id DESC LIMIT 1;
		IF FOUND THEN
			SELECT array_agg(a.agent_id) INTO flagged FROM agent_runs a WHERE a.orchestrator_run_id = b.id AND a.verdict IN ('ADVERSE', 'BLOCKING');
			IF flagged IS NULL THEN
				cleared := EXISTS (SELECT 1 FROM agent_runs n WHERE n.orchestrator_run_id = l.id AND twins_agent_evidence_fp(l.id, n.agent_id) <> '' AND twins_agent_evidence_fp(l.id, n.agent_id) <> twins_agent_evidence_fp(b.id, n.agent_id));
			ELSE
				cleared := NOT EXISTS (SELECT 1 FROM unnest(flagged) f(agent_id) WHERE twins_agent_evidence_fp(l.id, f.agent_id) = '' OR twins_agent_evidence_fp(l.id, f.agent_id) = twins_agent_evidence_fp(b.id, f.agent_id));
			END IF;
			IF NOT cleared THEN refusal := CASE b.assessment WHEN 'RESEARCH_BLOCKED' THEN 'research_blocked_not_superseded' ELSE 'research_adverse_not_superseded' END; END IF;
		END IF;
	END IF;
	RETURN NEXT;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_record_risk_approval"(p_decision_id uuid, p_card_id uuid, p_action text, p_actor text, p_context jsonb, p_reason text, p_valid_until timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	d risk_decisions_effective%ROWTYPE;
	c risk_approval_cards%ROWTYPE;
	latest stop_loss_validations%ROWTYPE;
	killed boolean;
	research text;
	rr_run uuid;
	rr_assessment text;
	rr_sha text;
	rr_refusal text;
	engine_on boolean;
	cited uuid;
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
			ELSIF coalesce(d.output_snapshot #>> '{intelligence,status}', '') <> 'VALID'
				OR coalesce(d.output_snapshot #>> '{intelligence,trust,tier}', '') NOT IN ('A', 'B', 'C')
				OR coalesce(d.output_snapshot #>> '{intelligence,confidence,tier}', '') NOT IN ('HIGH', 'MEDIUM', 'LOW') THEN why := 'source_intelligence_not_valid';
			END IF;
		END IF;
		IF why IS NULL THEN
			-- HB-03: the database knows whether the owner has declared the engine enabled; HB-01: the approval must cite the exact run it relied on; HB-02: see twins_research_assessment
			SELECT enabled INTO engine_on FROM agent_engine_state WHERE id = 1;
			IF NOT FOUND OR engine_on IS NULL THEN
				why := 'state_unavailable';
			ELSE
				SELECT t.run_id, t.assessment, t.synthesis_sha256, t.refusal INTO rr_run, rr_assessment, rr_sha, rr_refusal FROM twins_research_assessment(d.signal_id, d.options_claim_id, d.decision_version) t;
				cited := coalesce(c.research_run_id, nullif(p_context ->> 'researchRunId', '')::uuid);
				IF rr_run IS NULL THEN
					IF engine_on THEN why := 'research_assessment_missing';
					ELSIF cited IS NOT NULL THEN why := 'research_assessment_changed';
					END IF;
				ELSIF rr_refusal IS NOT NULL THEN why := rr_refusal;
				ELSIF cited IS NULL THEN why := 'research_reference_missing';
				ELSIF cited <> rr_run THEN why := 'research_assessment_changed';
				END IF;
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
			'plannedRiskRewardRatio', d.planned_risk_reward_ratio, 'confidenceScore', d.confidence_score, 'sourceTrustTier', d.source_trust_tier, 'createdAt', d.created_at, 'outputSnapshot', d.output_snapshot,
			'research', jsonb_build_object('runId', rr_run, 'assessment', rr_assessment, 'synthesisSha256', rr_sha, 'engineEnabled', engine_on)),
		d.evidence_references || jsonb_build_object('stopLossValidationId', d.stop_loss_validation_id, 'riskDecisionId', d.id, 'researchRunId', rr_run, 'researchAssessment', rr_assessment, 'researchSynthesisSha256', rr_sha), valid_until, card_sha);
	IF p_card_id IS NOT NULL THEN UPDATE risk_approval_cards SET state = 'decided', decided_at = now() WHERE id = p_card_id; END IF;
	RETURN 'recorded';
END;
$$;

