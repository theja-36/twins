-- HAND-WRITTEN. Stage 4 / Task 5: valid source intelligence is mandatory for an approval. The approval function (SECURITY DEFINER, migration 0019) re-checks, inside the database and at the
-- instant an approval is recorded, that the decision carries recorded source intelligence that is VALID, from a trust tier A / B / C source, with a known confidence tier. Everything else in
-- the function is unchanged; CREATE OR REPLACE keeps the owner, the SECURITY DEFINER setting and the existing EXECUTE grants.
CREATE OR REPLACE FUNCTION "twins_record_risk_approval"(p_decision_id uuid, p_card_id uuid, p_action text, p_actor text, p_context jsonb, p_reason text, p_valid_until timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
			ELSIF coalesce(d.output_snapshot #>> '{intelligence,status}', '') <> 'VALID'
				OR coalesce(d.output_snapshot #>> '{intelligence,trust,tier}', '') NOT IN ('A', 'B', 'C')
				OR coalesce(d.output_snapshot #>> '{intelligence,confidence,tier}', '') NOT IN ('HIGH', 'MEDIUM', 'LOW') THEN why := 'source_intelligence_not_valid';
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
$$;
