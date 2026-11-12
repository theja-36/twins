-- Least-privilege Postgres role for the RUNTIME services (api, worker, scheduler) - Stage 1 / Task 3 role separation. Idempotent; run as the database
-- OWNER (the role that runs migrations) AFTER every migration, and after the role exists:
--     CREATE ROLE twins_app LOGIN;          -- then set its password WITHOUT it appearing in a command line, history or the repository
--     \password twins_app
--   psql -v app_role=twins_app -f app-role.sql
-- Roles: the OWNER (schema + migrations + the safety-control / audit-verify jobs) is separate from this RUNTIME role and from the approval bot (twins_bot).
-- The runtime role can read and append, but it can NOT: UPDATE/DELETE/TRUNCATE any protected audit table, change a runtime safety control, write the
-- audit chain heads, own or alter any table, disable a trigger (needs ownership or the TRIGGER privilege, which it lacks), or create objects.
-- Protected (append-only, hash-chained): audit_events, signal_validations, telegram_messages, options_claims, system_control_events, stop_loss_validations.
-- No DELETE is granted on ANY table: the application never deletes rows. A table that has an event_hash column or a *_no_update_delete trigger is
-- treated as append-only automatically, so a future audit table cannot be left writable by forgetting to list it here.
SELECT set_config('twins.app_role', :'app_role', false);
ALTER ROLE :"app_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE :"app_role" SET statement_timeout = '30s';
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_role";
REVOKE ALL ON SCHEMA public FROM :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";
DO $$
DECLARE
	r text := current_setting('twins.app_role');
	t record;
	-- no access at all: the approval bot's tables (the bot has its own role) and anything only the owner/admin path may touch. twins_control_privileged_roles (migration 0047) is the allowlist of owner roles for risk_control_events: if the runtime role could append to it, it could allow-list itself
	none_for_runtime text[] := ARRAY['claim_review_cards', 'claim_reviews', 'approval_bot_events', 'approval_bot_state', 'system_control_events', 'audit_chain_heads', 'agent_engine_state_events', 'twins_control_privileged_roles'];
	-- read only: the runtime safety controls are changed only through the owner-run safety-control CLI
	read_only text[] := ARRAY['system_controls', 'telegram_intake_outbox_replays', 'risk_approvals', 'agent_engine_state', 'orders', 'fills', 'positions', 'paper_switch', 'paper_switch_events', 'user_decisions', 'user_decision_events', 'users', 'risk_control_events']; -- risk_control_events (migration 0047): the runtime role keeps SELECT only and records a halt ONLY through twins_set_user_halt (SECURITY DEFINER, owned by twins_control_writer); the generic append-only rule below would otherwise give it INSERT. -- the replay log is written only by the owner-run operations CLI (dead-letter replay); orders / fills / positions are the execution tables: no execution service exists and the runtime role gets SELECT only (P1 hardening, migration 0029); risk_approvals is written ONLY by twins_record_risk_approval (SECURITY DEFINER), never by an INSERT of this role
	-- insert only: the approval card is created by the application and then only ever advanced by the approval bot's SECURITY DEFINER functions
	insert_only text[] := ARRAY['risk_approval_cards'];
BEGIN
	FOR t IN SELECT c.relname AS name, c.relkind AS kind,
	               (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'event_hash' AND NOT a.attisdropped)
	                OR EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgname LIKE '%\_no\_update\_delete')) AS append_only
	           FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') LOOP
		IF t.name = ANY (none_for_runtime) THEN
			CONTINUE;
		ELSIF t.kind = 'v' THEN
			EXECUTE format('GRANT SELECT ON %I TO %I', t.name, r); -- views (e.g. signal_validation_eligibility) are read-only
		ELSIF t.name = ANY (read_only) THEN
			EXECUTE format('GRANT SELECT ON %I TO %I', t.name, r);
		ELSIF t.name = ANY (insert_only) THEN
			EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t.name, r);
		ELSIF t.append_only THEN
			EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t.name, r);
		ELSE
			EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t.name, r);
		END IF;
	END LOOP;
END
$$;
-- HB-04: the research-assessment check (application layer and start-up probe) reads these with this role; they are also covered by the loop above, and the explicit grants make the dependency visible and fail the
-- script (not a request) if one of the tables is ever renamed. agent_engine_state is read-only here: only the owner-run agent-engine-control CLI changes it.
GRANT SELECT ON agent_orchestrator_runs, agent_orchestrator_syntheses, agent_runs, agent_evidence_references, risk_decisions, agent_engine_state TO :"app_role";
GRANT EXECUTE ON FUNCTION twins_research_assessment(uuid, uuid, integer), twins_agent_evidence_fp(uuid, text) TO :"app_role";
-- the one door through which the API records a risk APPROVE / REJECT (it re-checks eligibility inside the database); the card-state doors are for the approval bot only
GRANT EXECUTE ON FUNCTION twins_record_risk_approval(uuid, uuid, text, text, jsonb, text, timestamptz) TO :"app_role";
-- Stage 07: the only doors to user_decisions / user_decision_events (the runtime role has no direct write on them). Each function acts only for the user bound to the transaction.
GRANT EXECUTE ON FUNCTION twins_create_user_decision(jsonb), twins_end_user_decision(uuid, text, text, text), twins_invalidate_decision(uuid, text, jsonb, text), twins_record_decision_approval(uuid, text, jsonb, text, text) TO :"app_role";
-- Paper trading switch (migration 0031): the runtime role may READ the switch and its history, and change it ONLY through this audited function (the admin API route is the sole caller).
-- Stage 01 / G-13: users is read-only for the runtime role except the password hash and display name; the role and active flag change only through the doors; the failed-login log is cleared through its definer function.
GRANT UPDATE (password_hash, display_name, updated_at) ON users TO :"app_role";
GRANT EXECUTE ON FUNCTION twins_create_user(text, text, text, text, uuid), twins_set_user_role(uuid, uuid, text), twins_set_user_active(uuid, uuid, boolean), twins_clear_login_failures(text) TO :"app_role";
-- Stage 02: accounts and broker_connections are row-level protected; the worker / scheduler cycles list accounts across users only through these identifier-only definer functions.
GRANT EXECUTE ON FUNCTION twins_list_active_accounts(), twins_list_active_account_users(integer) TO :"app_role";
GRANT EXECUTE ON FUNCTION twins_paper_set_switch(boolean, text, text) TO :"app_role";

-- Risk-control hardening (migration 0047, amends ADR-015): the one door through which the planning cycle records a USER-scope halt. Not executable by PUBLIC; the runtime role has no direct INSERT on risk_control_events (read_only above).
REVOKE ALL ON FUNCTION twins_set_user_halt(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION twins_set_user_halt(text, text, timestamptz) TO :"app_role";
