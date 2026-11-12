-- HAND-WRITTEN (security hardening follow-up to 0047). Additive: changes EXECUTE privileges only. No ownership, body, RLS, trigger or data change.
--
-- WHY: Postgres grants EXECUTE on every new function to PUBLIC by default. Eleven SECURITY DEFINER functions created before 0047 were therefore executable by every role in the cluster,
-- including roles that must never reach them (the approval bot, any future reporting or read-only role). Each already checks the user bound to the transaction, but a door should not be
-- reachable by a role that has no business calling it, and "PUBLIC can execute" makes the real caller list impossible to audit.
--
-- WHAT THIS DOES: REVOKE EXECUTE ... FROM PUBLIC on the eleven functions below (idempotent), then, only if the runtime role twins_app already exists, grants it exactly the functions the application
-- calls (the same grants infrastructure/staging/app-role.sql makes; repeated here so a deployed runtime is never cut off between the migration and the app-role.sql re-run).
-- The owner / migrating role keeps access (it owns the functions). The approval bot is granted nothing here: it uses only its own card-state doors (approval-bot-role.sql).
--
-- WHAT IT DOES NOT DO: it does not change who owns the functions (still the migrating superuser for all but twins_set_user_halt), does not authenticate twins.user_id, and does not touch RLS or append-only protections.
--
-- twins_audit_chain_after_insert is a TRIGGER function: Postgres checks EXECUTE on a trigger function when the trigger is created, not when it fires, so revoking PUBLIC does not stop the audit chain. Verified by tests.
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_audit_chain_after_insert() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_clear_login_failures(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_create_user(text, text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_set_user_role(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_set_user_active(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_create_user_decision(jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_end_user_decision(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_invalidate_decision(uuid, text, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_record_decision_approval(uuid, text, jsonb, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_list_active_accounts() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_list_active_account_users(integer) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twins_app') THEN
		GRANT EXECUTE ON FUNCTION public.twins_clear_login_failures(text), public.twins_create_user(text, text, text, text, uuid), public.twins_set_user_role(uuid, uuid, text), public.twins_set_user_active(uuid, uuid, boolean) TO twins_app;
		GRANT EXECUTE ON FUNCTION public.twins_create_user_decision(jsonb), public.twins_end_user_decision(uuid, text, text, text), public.twins_invalidate_decision(uuid, text, jsonb, text), public.twins_record_decision_approval(uuid, text, jsonb, text, text) TO twins_app;
		GRANT EXECUTE ON FUNCTION public.twins_list_active_accounts(), public.twins_list_active_account_users(integer) TO twins_app;
	END IF;
END
$$;
