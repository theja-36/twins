#!/usr/bin/env python3
"""Appends the hand-written part of migration 0037 (append-only + row-level security for risk_control_events) to the drizzle-generated SQL.
Regenerate flow (not yet applied anywhere): remove the 0037 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name capital_risk_confidence` (inside packages/database), run this script.
Rollback (additive): DROP TABLE "risk_control_events"; ALTER TABLE simulations DROP COLUMN risk_assessment_id; risk_assessments DROP COLUMN research_package_id, verdict; user_risk_policies DROP the three limit columns; user_capital_profiles DROP max_position_notional_pct; delete the journal entry."""
import sys
p = "packages/database/drizzle/0037_capital_risk_confidence.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
SEP = "\n--> statement-breakpoint\n"
t = "risk_control_events"
o = [s,
  "-- HAND-APPENDED (Master Build Stage 06, ADR-015). Control history is append-only (twins_audit_forbid_change); a control is set and cleared by new rows. The _no_update_delete suffix keeps the runtime role at SELECT + INSERT.",
  f'CREATE TRIGGER "{t}_no_update_delete" BEFORE UPDATE OR DELETE ON "{t}" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();',
  f'CREATE TRIGGER "{t}_no_truncate" BEFORE TRUNCATE ON "{t}" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();',
  "-- HAND-APPENDED. Row-level security, shared-or-owner: platform controls (user_id null) are visible to everyone and written with no user bound; a user's controls are visible and writable only for that user.",
  f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;',
  f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;',
  f'CREATE POLICY "{t}_shared_or_owner" ON "{t}" USING (user_id is null or user_id = {CUR}) WITH CHECK ((user_id is null and {CUR} is null) or user_id = {CUR});',
]
open(p, "w").write(SEP.join(o) + "\n")
