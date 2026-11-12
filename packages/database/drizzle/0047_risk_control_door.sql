-- HAND-WRITTEN (risk-control hardening, "Option B"; amends ADR-015). Additive; no data is changed.
--
-- WHY: until now the runtime role (twins_app) held INSERT on risk_control_events (the generic append-only rule in infrastructure/staging/app-role.sql gave it SELECT + INSERT). With no user bound it could append a
-- PLATFORM-wide row, and a CLEAR claiming actor_kind = 'OWNER' (a self-asserted label the database never verified). The only legitimate runtime writer is the planning cycle, which appends USER-scope SET halts with the user bound.
--
-- WHAT THIS DOES:
--  1. a dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS role, twins_control_writer, that owns exactly ONE object (the function below) and can only SELECT and INSERT on risk_control_events;
--  2. twins_control_privileged_roles: an explicit, append-only allowlist of the database roles that may write control events directly (the owner path); seeded with the role that runs this migration;
--  3. a BEFORE INSERT guard trigger: a session whose session_user is not on the allowlist can append ONLY the exact shape the planning cycle writes (USER scope, SET, SYSTEM actor 'planning-cycle', a halt kind, the user bound to the transaction);
--  4. twins_set_user_halt(...): the one door through which the runtime role records a halt (SECURITY DEFINER, owned by the writer role, fixed search_path, not executable by PUBLIC);
--  5. ENABLE ALWAYS on the guard and on the two existing append-only triggers, so session_replication_role = replica cannot switch them off.
--
-- WHAT IT DOES NOT DO: it does not authenticate the user binding. twins.user_id is a transaction-local setting that any code running as the runtime role can set to any user's id (known, documented limitation: every row-level-security policy and every
-- "door" in this schema trusts the application's binding). This migration bounds what a compromised runtime can WRITE to risk controls (restrictive halts for any user; never a platform-wide control, a CLEAR or an OWNER claim); it does not stop impersonation.
--
-- The runtime INSERT privilege itself is removed by infrastructure/staging/app-role.sql (risk_control_events moves to read-only; EXECUTE on the function is granted there). Run app-role.sql AFTER this migration.
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
		RAISE EXCEPTION '0047: the migrating role must be a superuser or have CREATEROLE (it creates twins_control_writer)';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twins_control_writer') THEN
		CREATE ROLE twins_control_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
	ELSE
		ALTER ROLE twins_control_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
	END IF;
	-- nobody but the migrating role may be a member (roles are cluster-wide: a role left by another database must not carry members)
	IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = 'twins_control_writer'::regrole AND r.rolname <> current_user) THEN
		RAISE EXCEPTION '0047: twins_control_writer must have no members other than the migrating role';
	END IF;
END
$$;
--> statement-breakpoint
-- minimum privileges: read and append on the one table (row-level security still applies to it: it is not the table owner and has no BYPASSRLS); nothing else
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM twins_control_writer;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO twins_control_writer;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.risk_control_events TO twins_control_writer;
--> statement-breakpoint
CREATE TABLE public.twins_control_privileged_roles (
	role_name name PRIMARY KEY,
	purpose text NOT NULL,
	added_by name NOT NULL DEFAULT session_user,
	added_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT twins_control_privileged_roles_purpose_check CHECK (length(purpose) >= 10)
);
--> statement-breakpoint
REVOKE ALL ON public.twins_control_privileged_roles FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER twins_control_privileged_roles_no_update_delete BEFORE UPDATE OR DELETE ON public.twins_control_privileged_roles FOR EACH ROW EXECUTE FUNCTION public.twins_audit_forbid_change();
--> statement-breakpoint
CREATE TRIGGER twins_control_privileged_roles_no_truncate BEFORE TRUNCATE ON public.twins_control_privileged_roles FOR EACH STATEMENT EXECUTE FUNCTION public.twins_audit_forbid_change();
--> statement-breakpoint
ALTER TABLE public.twins_control_privileged_roles ENABLE ALWAYS TRIGGER twins_control_privileged_roles_no_update_delete;
--> statement-breakpoint
ALTER TABLE public.twins_control_privileged_roles ENABLE ALWAYS TRIGGER twins_control_privileged_roles_no_truncate;
--> statement-breakpoint
-- the migrating role is the owner path by definition; further roles are added by appending a row (never updated or deleted: a removal is a migration)
INSERT INTO public.twins_control_privileged_roles (role_name, purpose) VALUES (session_user, 'migration owner: owner CLI and owner SQL path for risk control events') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION public.twins_risk_control_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
BEGIN
	-- the owner path: an explicitly allow-listed login role (session_user, never current_user: inside a definer function current_user is the function owner)
	IF EXISTS (SELECT 1 FROM public.twins_control_privileged_roles WHERE role_name = session_user) THEN RETURN NEW; END IF;
	-- everyone else: only the exact shape the planning cycle writes
	IF NEW.scope = 'USER' AND NEW.user_id IS NOT NULL AND uid IS NOT NULL AND NEW.user_id = uid
	   AND NEW.scope_key IS NOT DISTINCT FROM NEW.user_id::text AND NEW.action = 'SET' AND NEW.actor_kind = 'SYSTEM' AND NEW.actor = 'planning-cycle'
	   AND NEW.kind IN ('DAILY_LOSS_HALT', 'DRAWDOWN_HALT') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'risk_control_events: this session may append only a USER-scope SET halt written by the planning cycle' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER risk_control_events_guard BEFORE INSERT ON public.risk_control_events FOR EACH ROW EXECUTE FUNCTION public.twins_risk_control_guard();
--> statement-breakpoint
ALTER TABLE public.risk_control_events ENABLE ALWAYS TRIGGER risk_control_events_guard;
--> statement-breakpoint
ALTER TABLE public.risk_control_events ENABLE ALWAYS TRIGGER risk_control_events_no_update_delete;
--> statement-breakpoint
ALTER TABLE public.risk_control_events ENABLE ALWAYS TRIGGER risk_control_events_no_truncate;
--> statement-breakpoint
-- the door. Fixed columns, not parameters: scope USER, scope_key = the user, action SET, actor 'planning-cycle', actor_kind SYSTEM. The caller can choose only the halt kind (two values), the reason and the expiry.
-- DAILY_LOSS_HALT needs an expiry (the next IST day, set by the planning cycle) within a sane window of the database clock; DRAWDOWN_HALT has none (an owner clears it). Idempotent: an identical halt already recorded is returned, not appended again.
-- The expiry window is wide on purpose: the planning cycle takes its clock as an input (tests pin it to 2031), so the database clock cannot be the sole reference; a long daily halt is only ever restrictive.
CREATE FUNCTION public.twins_set_user_halt(p_kind text, p_reason text, p_expires timestamptz) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
	prev record;
	nid uuid;
BEGIN
	IF uid IS NULL THEN RAISE EXCEPTION 'twins_set_user_halt: no user bound to this transaction' USING ERRCODE = 'insufficient_privilege'; END IF;
	IF p_kind IS NULL OR p_kind NOT IN ('DAILY_LOSS_HALT', 'DRAWDOWN_HALT') THEN RAISE EXCEPTION 'twins_set_user_halt: only DAILY_LOSS_HALT or DRAWDOWN_HALT' USING ERRCODE = 'check_violation'; END IF;
	IF p_reason IS NULL OR length(p_reason) < 10 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'twins_set_user_halt: a reason of 10 to 500 characters is required' USING ERRCODE = 'check_violation'; END IF;
	IF p_kind = 'DAILY_LOSS_HALT' THEN
		IF p_expires IS NULL OR p_expires <= now() - interval '2 days' OR p_expires >= now() + interval '10 years' THEN RAISE EXCEPTION 'twins_set_user_halt: a daily-loss halt needs an expiry within a sane window' USING ERRCODE = 'check_violation'; END IF;
	ELSIF p_expires IS NOT NULL THEN
		RAISE EXCEPTION 'twins_set_user_halt: a drawdown halt has no expiry (an owner clears it)' USING ERRCODE = 'check_violation';
	END IF;
	PERFORM pg_advisory_xact_lock(hashtextextended('twins_set_user_halt:' || uid::text || ':' || p_kind, 0));
	SELECT e.id, e.action, e.expires_at INTO prev FROM public.risk_control_events e
		WHERE e.user_id = uid AND e.scope = 'USER' AND e.scope_key = uid::text AND e.kind = p_kind
		ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1;
	IF FOUND AND prev.action = 'SET' AND prev.expires_at IS NOT DISTINCT FROM p_expires THEN RETURN prev.id; END IF;
	nid := gen_random_uuid();
	INSERT INTO public.risk_control_events (id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at)
		VALUES (nid, uid, 'USER', uid::text, p_kind, 'SET', p_reason, 'planning-cycle', 'SYSTEM', p_expires);
	RETURN nid;
END;
$$;
--> statement-breakpoint
-- ownership: the writer role owns exactly this function. Postgres needs CREATE on the schema for a non-superuser migrator's ALTER ... OWNER TO, so it is granted for this one statement and revoked at once.
GRANT CREATE ON SCHEMA public TO twins_control_writer;
--> statement-breakpoint
ALTER FUNCTION public.twins_set_user_halt(text, text, timestamptz) OWNER TO twins_control_writer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM twins_control_writer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_set_user_halt(text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_risk_control_guard() FROM PUBLIC;
--> statement-breakpoint
COMMENT ON FUNCTION public.twins_set_user_halt(text, text, timestamptz) IS 'The only runtime door for risk_control_events: USER scope, SET, SYSTEM actor planning-cycle, halt kinds only. SECURITY DEFINER, owned by twins_control_writer, fixed search_path. Does not authenticate twins.user_id.';
