#!/usr/bin/env python3
"""Appends the hand-written part of migration 0033 (append-only triggers, decision guard, row-level security) to the drizzle-generated SQL.
Regenerate flow (migration not yet applied anywhere): remove 0033 files + journal entry, `drizzle-kit generate --name master_build_platform`, run this script."""
import sys
p = "packages/database/drizzle/0033_master_build_platform.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build" in s: sys.exit("already appended")
APPEND = ["user_capital_profiles", "user_risk_policies", "risk_assessments", "simulations", "user_decision_events", "trade_monitoring_events", "trade_outcomes", "strategy_drift_events", "learning_version_events", "signal_classifications", "market_regimes", "confidence_assessments", "confidence_calibration_runs", "counterfactual_reviews", "research_packages", "performance_snapshots"]
RLS = ["user_capital_profiles", "user_risk_policies", "user_execution_permissions", "risk_assessments", "simulations", "user_decisions", "user_decision_events", "trade_monitoring_events", "trade_outcomes"]
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
SEP = "\n--> statement-breakpoint\n"
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 02, ADR-002/003/008/011/012). Append-only evidence tables reject UPDATE / DELETE / TRUNCATE through the existing twins_audit_forbid_change() function; the trigger names end in _no_update_delete so infrastructure/staging/app-role.sql grants the runtime role SELECT and INSERT only.")
for t in APPEND:
    o.append(f'CREATE TRIGGER "{t}_no_update_delete" BEFORE UPDATE OR DELETE ON "{t}" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
    o.append(f'CREATE TRIGGER "{t}_no_truncate" BEFORE TRUNCATE ON "{t}" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append("-- HAND-APPENDED. user_decisions guard: a decision is created PENDING; afterwards ONLY workflow_state (and updated_at) may change, and a decision in a final state never changes again. This stops outcome, owner, evidence links and validity window from being edited after the fact, and stops a row being inserted already APPROVED. The approval itself (a recorded human approval) is added in Stage 07 as the only door; until then the runtime role has no write grant on this table (app-role.sql).")
o.append('''CREATE FUNCTION "twins_user_decision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.workflow_state <> 'PENDING' THEN
			RAISE EXCEPTION 'a decision must start PENDING' USING ERRCODE = 'check_violation';
		END IF;
		-- mandatory stop-loss floor: a QUALIFIED decision cannot be created for a candidate that has no positive stop-loss. This is only a floor; the full rule (basis, validity) stays in packages/stop-loss and the Stage 07 producer must call it first.
		IF NEW.outcome = 'QUALIFIED' AND NOT EXISTS (SELECT 1 FROM opportunity_candidates c WHERE c.id = NEW.candidate_id AND c.stop_loss IS NOT NULL AND c.stop_loss > 0) THEN
			RAISE EXCEPTION 'a QUALIFIED decision needs a candidate with a stop-loss' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.candidate_id <> OLD.candidate_id
	   OR NEW.outcome <> OLD.outcome OR NEW.explanation IS DISTINCT FROM OLD.explanation
	   OR NEW.valid_from <> OLD.valid_from OR NEW.valid_until <> OLD.valid_until OR NEW.created_at <> OLD.created_at
	   OR NEW.confidence_assessment_id IS DISTINCT FROM OLD.confidence_assessment_id OR NEW.risk_assessment_id IS DISTINCT FROM OLD.risk_assessment_id
	   OR NEW.simulation_id IS DISTINCT FROM OLD.simulation_id OR NEW.risk_decision_id IS DISTINCT FROM OLD.risk_decision_id
	   OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
		RAISE EXCEPTION 'only workflow_state of a decision may change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.workflow_state <> OLD.workflow_state AND OLD.workflow_state <> 'PENDING' THEN
		RAISE EXCEPTION 'a decision in a final state cannot change' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "user_decisions_guard" BEFORE INSERT OR UPDATE ON "user_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_user_decision_guard"();')
o.append('CREATE TRIGGER "user_decisions_no_delete" BEFORE DELETE ON "user_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append('CREATE TRIGGER "user_decisions_no_truncate" BEFORE TRUNCATE ON "user_decisions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append("-- HAND-APPENDED. Until the Stage 07 approval doors exist, the runtime and bot roles must not write user_decisions or user_decision_events (same pattern as migration 0029 for the execution tables; app-role.sql lists them as read-only so a re-run does not grant them back). The roles are skipped when absent (CI and development databases).")
o.append("""DO $$
DECLARE
	r text;
	t text;
BEGIN
	FOREACH r IN ARRAY ARRAY['twins_app', 'twins_bot'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			FOREACH t IN ARRAY ARRAY['user_decisions', 'user_decision_events'] LOOP
				EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I', t, r);
			END LOOP;
		END IF;
	END LOOP;
END
$$;""")
o.append("-- HAND-APPENDED. Row-level security on every user-private table: a row is visible and writable only when its user_id equals the transaction's `twins.user_id` setting. With no setting the policy matches nothing (fail closed). FORCE applies it to the table owner too. The application sets the setting per transaction (packages/database withUser); system actors act for a user only by naming that user. Composite (account_id, user_id) foreign keys additionally guarantee that a row can never name another user's account.")
for t in RLS:
    o.append(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;')
    o.append(f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;')
    o.append(f'CREATE POLICY "{t}_owner_only" ON "{t}" USING (user_id = {CUR}) WITH CHECK (user_id = {CUR});')
o.append("-- HAND-APPENDED. performance_snapshots: shared rows (no user) are readable by all; a user's own rows only by that user; a SHARED row can be written only with NO user context (system actors), never from a user session.")
o.append('ALTER TABLE "performance_snapshots" ENABLE ROW LEVEL SECURITY;')
o.append('ALTER TABLE "performance_snapshots" FORCE ROW LEVEL SECURITY;')
o.append(f'CREATE POLICY "performance_snapshots_shared_or_owner" ON "performance_snapshots" USING (user_id is null or user_id = {CUR}) WITH CHECK ((user_id is null and {CUR} is null) or user_id = {CUR});')
open(p, "w").write(SEP.join(o) + "\n")
print("appended")
