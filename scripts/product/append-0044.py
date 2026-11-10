#!/usr/bin/env python3
"""Appends the hand-written part of migration 0044 (Stage 04: G-43 research run key, G-44 per-agent run records) to the drizzle-generated SQL.
Regenerate flow: remove the 0044 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name research_run_records` (in packages/database), then run this script.
Rollback (forward-only: write a new migration, never edit 0044): drop triggers research_agent_runs_no_update_delete / _no_truncate, drop table research_agent_runs, drop index research_packages_candidate_run_key_unique, drop constraint research_packages_run_key_check, drop column research_packages.run_key."""
import sys
p = "packages/database/drizzle/0044_research_run_records.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 04" in s: sys.exit("already appended")
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 04, G-44). The per-agent run records of a research package are append-only evidence: they are written with the package, never edited or deleted (a new evaluation is a new package version with its own rows).")
o.append('CREATE TRIGGER "research_agent_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "research_agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append('CREATE TRIGGER "research_agent_runs_no_truncate" BEFORE TRUNCATE ON "research_agent_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
