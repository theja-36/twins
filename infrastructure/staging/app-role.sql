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
	-- no access at all: the approval bot's tables (the bot has its own role) and anything only the owner/admin path may touch
	none_for_runtime text[] := ARRAY['claim_review_cards', 'claim_reviews', 'approval_bot_events', 'approval_bot_state', 'system_control_events', 'audit_chain_heads'];
	-- read only: the runtime safety controls are changed only through the owner-run safety-control CLI
	read_only text[] := ARRAY['system_controls', 'telegram_intake_outbox_replays']; -- the replay log is written only by the owner-run operations CLI (dead-letter replay)
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
		ELSIF t.append_only THEN
			EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t.name, r);
		ELSE
			EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t.name, r);
		END IF;
	END LOOP;
END
$$;
