-- F5 (migration 0049): the SYSTEM role is the worker and scheduler identity. It is the only runtime role that may bind a transaction to a named user (twins_bind_system_user), which the background cycles need because they
-- act for each user without an HTTP request. The API role (twins_app) must NEVER hold this: a compromised API process could then act as any user. Idempotent; run as the database OWNER, AFTER app-role.sql for the same role:
--     CREATE ROLE twins_system LOGIN;  \password twins_system
--     psql -v app_role=twins_system -f app-role.sql      -- the same table/function grants as the API role
--     psql -v system_role=twins_system -f system-role.sql
-- Net effect for the system role: it may bind a named user, and it can no longer bind by session token (it has no token to present).
REVOKE ALL ON FUNCTION twins_bind_system_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION twins_bind_system_user(uuid) TO :"system_role";
REVOKE EXECUTE ON FUNCTION twins_bind_session(text) FROM :"system_role";
