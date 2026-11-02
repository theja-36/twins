-- HAND-WRITTEN. P1 hardening: the runtime roles must not be able to write the execution tables (orders, fills, positions).
-- Finding (2026-11-01 staging rehearsal): app-role.sql's generic loop granted SELECT, INSERT and UPDATE on every non-append-only table, so `twins_app` could INSERT into orders / fills / positions.
-- The `orders_require_risk_decision` trigger still stood in the way of an order without an approved decision, and no execution code exists, but privilege separation should not rely on a trigger.
-- This migration REVOKEs INSERT / UPDATE / DELETE / TRUNCATE on those three tables from the runtime role (twins_app) and the approval-bot role (twins_bot) when they exist, so a deployment closes the
-- gap even before app-role.sql is re-applied; app-role.sql now lists the three tables as read-only so a re-run does not grant them back. The owner role keeps full access: a future, separately authorised
-- execution service gets its own role and grants. Idempotent; nothing is created, no data changes, and the roles are skipped when absent (CI and development databases).
DO $$
DECLARE
	r text;
	t text;
BEGIN
	FOREACH r IN ARRAY ARRAY['twins_app', 'twins_bot'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			FOREACH t IN ARRAY ARRAY['orders', 'fills', 'positions'] LOOP
				EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I', t, r);
			END LOOP;
		END IF;
	END LOOP;
END
$$;
