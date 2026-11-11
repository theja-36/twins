#!/usr/bin/env python3
"""Appends the hand-written part of migration 0045 (Stage 07: G-27 decision WATCH / UNWATCH actions) to the drizzle-generated SQL.
Regenerate flow: remove the 0045 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name decision_watches` (in packages/database), then run this script.
Rollback (forward-only: write a new migration, never edit 0045): drop policy decision_watches_owner_only, drop triggers decision_watches_no_update_delete / _no_truncate, drop table decision_watches."""
import sys
p = "packages/database/drizzle/0045_decision_watches.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 07" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 07, G-27). A watch is a private bookmark and evidence of the user's attention: append-only (the latest event decides), never edited or deleted.")
o.append('CREATE TRIGGER "decision_watches_no_update_delete" BEFORE UPDATE OR DELETE ON "decision_watches" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append('CREATE TRIGGER "decision_watches_no_truncate" BEFORE TRUNCATE ON "decision_watches" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append("-- HAND-APPENDED. Owner-only row-level security, forced on the table owner too; with no user bound the policy matches nothing (fail closed).")
o.append('ALTER TABLE "decision_watches" ENABLE ROW LEVEL SECURITY;')
o.append('ALTER TABLE "decision_watches" FORCE ROW LEVEL SECURITY;')
o.append(f'CREATE POLICY "decision_watches_owner_only" ON "decision_watches" USING (user_id = {CUR}) WITH CHECK (user_id = {CUR});')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
