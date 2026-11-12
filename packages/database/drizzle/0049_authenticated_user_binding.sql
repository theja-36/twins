-- HAND-WRITTEN (closes F5, the "unauthenticated twins.user_id" limitation recorded in ADR-015 / migration 0047). Additive in behaviour for correct callers; fails CLOSED for everyone else.
--
-- THE PROBLEM: every row-level-security policy and every definer "door" read the acting user from `current_setting('twins.user_id')`. A custom setting is not a credential: any code running as the runtime role
-- could `set_config('twins.user_id', <anyone>, true)` and act as that user. Postgres has no way to restrict who sets a custom (placeholder) setting, so the setting cannot be made trustworthy.
--
-- THE FIX: the acting user is no longer a setting at all. It is a ROW in twins_txn_identity, keyed by the transaction's own xid (an id the caller cannot choose), written only by two SECURITY DEFINER doors:
--   * twins_bind_session(token)  : the API role proves the user with the user's own raw session token. The database hashes it, finds a live (unrevoked, unexpired) session of an ACTIVE user, and binds THAT user.
--                                  The caller cannot name a user; it can only present a credential. Granted to the API role only.
--   * twins_bind_system_user(uid): for the worker / scheduler cycles that act for a user without a request (planning, outcomes). Granted ONLY to the separate system role (infrastructure/staging/system-role.sql),
--                                  never to the API role. A compromised API process therefore cannot act as a user whose session token it has not been handed.
-- Policies and doors now read twins_bound_user_id(), which returns the identity bound to THIS transaction (or NULL). A transaction binds at most once and cannot switch user; the row dies with a rollback and never
-- matches a later transaction (new xid), so a pooled connection cannot carry an identity over. Rows from an earlier server run (or a restored copy) are ignored (boot time) and purged.
--
-- WHAT THIS DOES NOT DO: it does not make the system role trustworthy for arbitrary users (it is the intended all-users background identity; protect its credential), and a compromised API process can still use
-- the tokens of requests it is currently serving, as any bearer-token service can. See ADR-015 amendment 2.
--> statement-breakpoint
CREATE UNLOGGED TABLE public.twins_txn_identity (
	xid xid8 PRIMARY KEY,
	boot timestamptz NOT NULL DEFAULT pg_postmaster_start_time(),
	user_id uuid NOT NULL,
	via text NOT NULL CONSTRAINT twins_txn_identity_via_check CHECK (via IN ('SESSION', 'SYSTEM')),
	bound_by name NOT NULL DEFAULT session_user,
	bound_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
REVOKE ALL ON public.twins_txn_identity FROM PUBLIC;
--> statement-breakpoint
-- readable (RLS-limited to the caller's own transaction) so policy expressions can call the reader as any role; NOT writable by anyone but the owner-run doors below
GRANT SELECT ON public.twins_txn_identity TO PUBLIC;
--> statement-breakpoint
ALTER TABLE public.twins_txn_identity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY twins_txn_identity_own_transaction ON public.twins_txn_identity FOR SELECT USING (xid = pg_current_xact_id_if_assigned() AND boot = pg_postmaster_start_time());
--> statement-breakpoint
CREATE FUNCTION public.twins_bound_user_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
	SELECT i.user_id FROM public.twins_txn_identity i WHERE i.xid = pg_current_xact_id_if_assigned() AND i.boot = pg_postmaster_start_time()
$$;
--> statement-breakpoint
CREATE FUNCTION public.twins_bind_session(p_token text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	uid uuid;
	prev uuid;
BEGIN
	IF p_token IS NULL OR p_token !~ '^tws_[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'twins_bind_session: not authenticated' USING ERRCODE = 'insufficient_privilege'; END IF;
	-- the raw token is the credential: the database hashes it itself (a stored hash, which the runtime role can read, is NOT accepted as a credential)
	SELECT s.user_id INTO uid FROM public.user_sessions s JOIN public.users u ON u.id = s.user_id
		WHERE s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active;
	IF uid IS NULL THEN RAISE EXCEPTION 'twins_bind_session: not authenticated' USING ERRCODE = 'insufficient_privilege'; END IF;
	prev := public.twins_bound_user_id();
	IF prev IS NOT NULL THEN
		IF prev = uid THEN RETURN uid; END IF; -- the same user again is a no-op; a different one is never allowed
		RAISE EXCEPTION 'twins_bind_session: this transaction is already bound to another user' USING ERRCODE = 'insufficient_privilege';
	END IF;
	-- purge identities of finished transactions; SKIP LOCKED so two concurrent binders never wait on each other's deletes
	DELETE FROM public.twins_txn_identity WHERE ctid = ANY (ARRAY(SELECT t.ctid FROM public.twins_txn_identity t WHERE t.xid < pg_snapshot_xmin(pg_current_snapshot()) OR t.boot <> pg_postmaster_start_time() FOR UPDATE SKIP LOCKED));
	INSERT INTO public.twins_txn_identity (xid, user_id, via) VALUES (pg_current_xact_id(), uid, 'SESSION');
	RETURN uid;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.twins_bind_system_user(p_user uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	prev uuid;
BEGIN
	IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user) THEN RAISE EXCEPTION 'twins_bind_system_user: no such user' USING ERRCODE = 'insufficient_privilege'; END IF;
	prev := public.twins_bound_user_id();
	IF prev IS NOT NULL THEN
		IF prev = p_user THEN RETURN p_user; END IF;
		RAISE EXCEPTION 'twins_bind_system_user: this transaction is already bound to another user' USING ERRCODE = 'insufficient_privilege';
	END IF;
	-- purge identities of finished transactions; SKIP LOCKED so two concurrent binders never wait on each other's deletes
	DELETE FROM public.twins_txn_identity WHERE ctid = ANY (ARRAY(SELECT t.ctid FROM public.twins_txn_identity t WHERE t.xid < pg_snapshot_xmin(pg_current_snapshot()) OR t.boot <> pg_postmaster_start_time() FOR UPDATE SKIP LOCKED));
	INSERT INTO public.twins_txn_identity (xid, user_id, via) VALUES (pg_current_xact_id(), p_user, 'SYSTEM');
	RETURN p_user;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_bind_session(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.twins_bind_system_user(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Re-point every policy and definer door from the settable GUC to the transaction-bound identity. Mechanical and exhaustive: the loop rewrites the single expression form used throughout and the final check REFUSES to
-- finish the migration if any policy or function in public still reads the setting.
DO $$
DECLARE
	p record;
	f record;
	q text;
	w text;
	def text;
	old_policy constant text := '(NULLIF(current_setting(''twins.user_id''::text, true), ''''::text))::uuid';
	new_policy constant text := '(SELECT public.twins_bound_user_id())';
	old_fn constant text := 'nullif(current_setting(''twins.user_id'', true), '''')::uuid';
	new_fn constant text := 'public.twins_bound_user_id()';
BEGIN
	FOR p IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%twins.user_id%' OR with_check LIKE '%twins.user_id%') LOOP
		q := replace(p.qual, old_policy, new_policy);
		w := replace(p.with_check, old_policy, new_policy);
		IF q LIKE '%twins.user_id%' OR w LIKE '%twins.user_id%' THEN RAISE EXCEPTION '0049: policy %.% uses an unexpected twins.user_id expression', p.tablename, p.policyname; END IF;
		EXECUTE format('ALTER POLICY %I ON %I.%I%s%s', p.policyname, p.schemaname, p.tablename,
			CASE WHEN q IS NULL THEN '' ELSE ' USING (' || q || ')' END, CASE WHEN w IS NULL THEN '' ELSE ' WITH CHECK (' || w || ')' END);
	END LOOP;
	FOR f IN SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%twins.user_id%' LOOP
		def := replace(pg_get_functiondef(f.oid), old_fn, new_fn);
		IF def LIKE '%twins.user_id%' THEN RAISE EXCEPTION '0049: function % uses an unexpected twins.user_id expression', f.oid::regprocedure; END IF;
		EXECUTE def; -- CREATE OR REPLACE: owner, ACL and settings are kept
	END LOOP;
	IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%twins.user_id%' OR with_check LIKE '%twins.user_id%'))
	   OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%twins.user_id%') THEN
		RAISE EXCEPTION '0049: a policy or function still reads the twins.user_id setting';
	END IF;
END
$$;
--> statement-breakpoint
-- A runtime role that already exists keeps working between this migration and the infrastructure role scripts: the API role (twins_app) may bind by session token; only a separately created system role may bind a user directly.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twins_app') THEN GRANT EXECUTE ON FUNCTION public.twins_bind_session(text) TO twins_app; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twins_system') THEN GRANT EXECUTE ON FUNCTION public.twins_bind_system_user(uuid) TO twins_system; END IF;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.twins_bind_session(text) IS 'F5: binds the transaction to the user who owns a live session token (the database hashes the token). The caller cannot name a user. API role only.';
--> statement-breakpoint
COMMENT ON FUNCTION public.twins_bind_system_user(uuid) IS 'F5: binds the transaction to a named active user for background cycles. Executable by the system role only, never by the API role.';
--> statement-breakpoint
COMMENT ON FUNCTION public.twins_bound_user_id() IS 'The user bound to the current transaction by a bind door, or NULL. Replaces the settable twins.user_id setting.';
