-- READ-ONLY catalogue audit of every function in schema public, focused on SECURITY DEFINER functions (risk-control hardening, F7).
-- It changes nothing: it runs in a READ ONLY transaction and only reads the system catalogues. Run it as the database owner, e.g.
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/ops/audit-definer-functions.sql
-- (the connection string is never printed by this script). The output is a report for a human to review; ANY FIX is a separate, explicitly approved migration and is NOT part of migration 0047.
--
-- Flags (per SECURITY DEFINER function):
--   NO_SEARCH_PATH      the function has no fixed search_path (a definer function must fix it to defeat search-path hijacking);
--   SEARCH_PATH_PUBLIC  its fixed search_path lists schema public (pg_catalog is still searched first implicitly; stricter is `pg_catalog, pg_temp` with schema-qualified names);
--   PUBLIC_EXECUTE      PUBLIC (every role) may execute it (Postgres grants EXECUTE to PUBLIC by default; only an explicit REVOKE removes it);
--   OWNER_SUPERUSER     it is owned by a superuser, so it runs with every privilege and bypasses row-level security (its body is then the only control);
--   RUNTIME_EXECUTE     the runtime role (twins_app) may execute it;
--   BOT_EXECUTE         the approval-bot role (twins_bot) may execute it;
--   TRUSTS_USER_BINDING its body reads the transaction setting twins.user_id (since migration 0049 NO function should: this flag now signals a regression to the settable, unauthenticated setting).
BEGIN READ ONLY;
\pset format unaligned
\pset fieldsep '|'
\pset tuples_only off
\echo == 1. inventory: every function in schema public
select p.proname as function, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_userbyid(p.proowner) as owner, coalesce((select r.rolsuper from pg_roles r where r.oid = p.proowner), false) as owner_superuser,
       p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '') as config, l.lanname as language, (p.prorettype = 'trigger'::regtype) as is_trigger_function
  from pg_proc p join pg_language l on l.oid = p.prolang
 where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
 order by p.prosecdef desc, p.proname;
\echo == 2. SECURITY DEFINER functions with their flags (one row per function; flags empty = none)
with d as (
  select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proowner, p.proconfig, p.proacl, p.prosrc,
         exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
         exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%') as has_sp,
         exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%' and c ~ '(^|[=, ])public([, ]|$)') as sp_public,
         coalesce((select r.rolsuper from pg_roles r where r.oid = p.proowner), false) as owner_super
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef)
select proname as function, args as arguments, pg_get_userbyid(proowner) as owner,
       concat_ws(' ', case when not has_sp then 'NO_SEARCH_PATH' end, case when sp_public then 'SEARCH_PATH_PUBLIC' end, case when public_exec then 'PUBLIC_EXECUTE' end, case when owner_super then 'OWNER_SUPERUSER' end,
                 case when to_regrole('twins_app') is not null and has_function_privilege('twins_app', oid, 'EXECUTE') then 'RUNTIME_EXECUTE' end,
                 case when to_regrole('twins_bot') is not null and has_function_privilege('twins_bot', oid, 'EXECUTE') then 'BOT_EXECUTE' end,
                 case when prosrc ilike '%twins.user_id%' then 'TRUSTS_USER_BINDING' end) as flags
  from d order by proname;
\echo == 3. counts
select count(*) filter (where p.prosecdef) as security_definer_functions,
       count(*) filter (where p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')) as without_fixed_search_path,
       count(*) filter (where p.prosecdef and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as executable_by_public,
       count(*) filter (where p.prosecdef and coalesce((select r.rolsuper from pg_roles r where r.oid = p.proowner), false)) as owned_by_superuser
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f';
\echo == 4. the risk-control door and guard (migration 0047) for comparison
select p.proname as function, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '') as config,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('twins_set_user_halt', 'twins_risk_control_guard') order by 1;
ROLLBACK;
