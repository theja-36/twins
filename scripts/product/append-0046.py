#!/usr/bin/env python3
"""Appends the hand-written part of migration 0046 (Stage 08: A1 / G-49 exactly-one trade outcome per paper position, A2 reproducible analytics snapshots) to the drizzle-generated SQL.
Regenerate flow: remove the 0046 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name outcome_integrity_analytics_snapshots` (in packages/database), then run this script.
Rollback (forward-only: write a new migration, never edit 0046): drop policy analytics_snapshots_owner_only, drop triggers analytics_snapshots_no_update_delete / _no_truncate, drop table analytics_snapshots, drop index trade_outcomes_paper_position_unique."""
import sys
p = "packages/database/drizzle/0046_outcome_integrity_analytics_snapshots.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 08" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
pre = """-- HAND-WRITTEN PRE-FLIGHT (Master Build Stage 08, G-49). trade_outcomes is append-only, so duplicate outcomes for one paper position cannot be repaired by this migration. If any exist, stop with a precise message instead of a bare index error.
DO $$
DECLARE dup integer;
BEGIN
	SELECT count(*) INTO dup FROM (SELECT paper_position_id FROM trade_outcomes WHERE paper_position_id IS NOT NULL GROUP BY paper_position_id HAVING count(*) > 1) d;
	IF dup > 0 THEN RAISE EXCEPTION 'migration 0046 refused: % paper position(s) already have more than one trade outcome; resolve them with the owner before applying (trade_outcomes is append-only)', dup USING ERRCODE = 'check_violation'; END IF;
END
$$;"""
o = [pre, s]
o.append("-- HAND-APPENDED (Master Build Stage 08, A2). A snapshot is an immutable record of an analytics report and of exactly what it was built from: append-only, never edited or deleted (a later state of the evidence is a NEW snapshot).")
o.append('CREATE TRIGGER "analytics_snapshots_no_update_delete" BEFORE UPDATE OR DELETE ON "analytics_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append('CREATE TRIGGER "analytics_snapshots_no_truncate" BEFORE TRUNCATE ON "analytics_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append("-- HAND-APPENDED. Owner-only row-level security, forced on the table owner too; with no user bound the policy matches nothing (fail closed).")
o.append('ALTER TABLE "analytics_snapshots" ENABLE ROW LEVEL SECURITY;')
o.append('ALTER TABLE "analytics_snapshots" FORCE ROW LEVEL SECURITY;')
o.append(f'CREATE POLICY "analytics_snapshots_owner_only" ON "analytics_snapshots" USING (user_id = {CUR}) WITH CHECK (user_id = {CUR});')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
