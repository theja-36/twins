#!/usr/bin/env python3
"""Appends the hand-written part of migration 0040 (auth security: the privilege doors, G-13) to the drizzle-generated SQL.
Regenerate flow (not yet applied anywhere): remove the 0040 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name auth_security` (inside packages/database), run this script.
Rollback: drop trigger users_privilege_guard_update / users_privilege_guard_insert, drop functions twins_users_privilege_guard, twins_create_user, twins_set_user_role, twins_set_user_active, twins_clear_login_failures, drop table auth_login_failures, delete the journal entry."""
import sys
p = "packages/database/drizzle/0040_auth_security.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 01" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 01, G-13). users.role and users.is_active change ONLY through the doors below. The runtime role loses INSERT/UPDATE on users (app-role.sql: SELECT + UPDATE(password_hash, display_name, updated_at)); this trigger is the second layer in case a future grant is too wide: it refuses any role / is_active change, and any ADMIN insert, unless a door has opened it inside the same transaction.")
o.append('''CREATE FUNCTION "twins_users_privilege_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF coalesce(current_setting('twins.privilege_door', true), '') = 'open' THEN RETURN NEW; END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.role <> 'TRADER' OR NEW.is_active IS NOT TRUE THEN
			RAISE EXCEPTION 'a privileged user is created only through twins_create_user' USING ERRCODE = 'insufficient_privilege';
		END IF;
	ELSIF NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
		RAISE EXCEPTION 'users.role and users.is_active change only through twins_set_user_role / twins_set_user_active' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "users_privilege_guard_update" BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "twins_users_privilege_guard"();')
o.append('CREATE TRIGGER "users_privilege_guard_insert" BEFORE INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "twins_users_privilege_guard"();')
o.append("-- HAND-APPENDED. Creating a user. A TRADER may be created by anyone (registration or an administrator). An ADMIN only by an active ADMIN bound to this transaction (twins.user_id = p_actor), or, with no actor, when NO active administrator exists (the first-administrator bootstrap). Returns NULL for a duplicate email.")
o.append('''CREATE FUNCTION "twins_create_user"(p_email text, p_hash text, p_name text, p_role text, p_actor uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := ''' + CUR + ''';
	a record;
	nid uuid := gen_random_uuid();
BEGIN
	IF p_role NOT IN ('ADMIN', 'TRADER') THEN RAISE EXCEPTION 'twins_create_user: unknown role' USING ERRCODE = 'check_violation'; END IF;
	IF p_role = 'ADMIN' THEN
		IF p_actor IS NULL THEN
			IF EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN' AND is_active) THEN RAISE EXCEPTION 'twins_create_user: an administrator already exists' USING ERRCODE = 'insufficient_privilege'; END IF;
		ELSE
			SELECT * INTO a FROM users WHERE id = p_actor;
			IF uid IS NULL OR uid <> p_actor OR NOT FOUND OR a.role <> 'ADMIN' OR NOT a.is_active THEN RAISE EXCEPTION 'twins_create_user: only an active administrator can create an administrator' USING ERRCODE = 'insufficient_privilege'; END IF;
		END IF;
	END IF;
	IF EXISTS (SELECT 1 FROM users WHERE email = p_email) THEN RETURN NULL; END IF;
	PERFORM set_config('twins.privilege_door', 'open', true);
	INSERT INTO users (id, email, password_hash, display_name, role, is_active) VALUES (nid, p_email, p_hash, p_name, p_role, true);
	PERFORM set_config('twins.privilege_door', '', true);
	INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) VALUES (gen_random_uuid(), 'auth.user_created', 'user', nid, 'user', coalesce(p_actor::text, 'self'), jsonb_build_object('role', p_role));
	RETURN nid;
END;
$$;''')
o.append("-- HAND-APPENDED. The role and active doors. The actor must be the user bound to this transaction AND an active ADMIN; never the target; the last active ADMIN is never demoted or deactivated. Both write an audit event in the same transaction.")
for name, col, typ, evt in [("twins_set_user_role", "role", "text", "auth.role_changed"), ("twins_set_user_active", "is_active", "boolean", "auth.active_changed")]:
    last = "IF t.role = 'ADMIN' AND t.is_active AND p_value <> 'ADMIN' AND (SELECT count(*) FROM users WHERE role = 'ADMIN' AND is_active) <= 1 THEN RETURN false; END IF;" if col == "role" else "IF t.role = 'ADMIN' AND t.is_active AND NOT p_value AND (SELECT count(*) FROM users WHERE role = 'ADMIN' AND is_active) <= 1 THEN RETURN false; END IF;"
    chk = "IF p_value NOT IN ('ADMIN', 'TRADER') THEN RAISE EXCEPTION 'twins_set_user_role: unknown role' USING ERRCODE = 'check_violation'; END IF;" if col == "role" else ""
    before = "to_jsonb(t.role)" if col == "role" else "to_jsonb(t.is_active)"
    o.append(f'''CREATE FUNCTION "{name}"(p_actor uuid, p_target uuid, p_value {typ}) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := {CUR};
	a record;
	t record;
BEGIN
	{chk}
	IF uid IS NULL OR uid <> p_actor OR p_actor = p_target THEN RETURN false; END IF;
	SELECT * INTO a FROM users WHERE id = p_actor;
	IF NOT FOUND OR a.role <> 'ADMIN' OR NOT a.is_active THEN RETURN false; END IF;
	SELECT * INTO t FROM users WHERE id = p_target FOR UPDATE;
	IF NOT FOUND THEN RETURN false; END IF;
	{last}
	PERFORM set_config('twins.privilege_door', 'open', true);
	UPDATE users SET {col} = p_value, updated_at = now() WHERE id = p_target;
	PERFORM set_config('twins.privilege_door', '', true);
	INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, before_state, after_state) VALUES (gen_random_uuid(), '{evt}', 'user', p_target, 'user', p_actor::text, jsonb_build_object('{col}', {before}), jsonb_build_object('{col}', to_jsonb(p_value)));
	RETURN true;
END;
$$;''')
o.append("-- HAND-APPENDED. Clearing a user's failed-login rows after a successful login (the runtime role has no DELETE on the log). Old rows (over a day) are purged at the same time.")
o.append('''CREATE FUNCTION "twins_clear_login_failures"(p_key text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
	DELETE FROM auth_login_failures WHERE key_hash = p_key OR at < now() - interval '1 day';
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END;
$$;''')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
