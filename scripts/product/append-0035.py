#!/usr/bin/env python3
"""Appends the hand-written part of migration 0035 (append-only triggers and row-level security for ai_usage_records) to the drizzle-generated SQL.
Regenerate flow (migration not yet applied anywhere): remove the 0035 files + journal entry, `drizzle-kit generate --name ai_usage_records` (run inside packages/database), run this script.
Rollback (additive migration, nothing references the table): DROP TABLE "ai_usage_records"; then delete the journal entry."""
import sys
p = "packages/database/drizzle/0035_ai_usage_records.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
SEP = "\n--> statement-breakpoint\n"
t = "ai_usage_records"
o = [s,
  "-- HAND-APPENDED (Master Build Stage 04, ADR-005/ADR-013). The usage ledger is append-only: it rejects UPDATE / DELETE / TRUNCATE through the existing twins_audit_forbid_change function. Stores no prompt or response text.",
  f'CREATE TRIGGER "{t}_no_update_delete" BEFORE UPDATE OR DELETE ON "{t}" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();',
  f'CREATE TRIGGER "{t}_no_truncate" BEFORE TRUNCATE ON "{t}" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();',
  "-- HAND-APPENDED. Row-level security, shared-or-owner: a user sees and writes their own rows; platform rows (user_id null) are visible to everyone and may only be written with no user bound.",
  f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;',
  f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;',
  f'CREATE POLICY "{t}_shared_or_owner" ON "{t}" USING (user_id is null or user_id = {CUR}) WITH CHECK ((user_id is null and {CUR} is null) or user_id = {CUR});',
]
open(p, "w").write(SEP.join(o) + "\n")
