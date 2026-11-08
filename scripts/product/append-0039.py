#!/usr/bin/env python3
"""Appends the hand-written part of migration 0039 (outcome learning invariants) to the drizzle-generated SQL.
Regenerate flow (not yet applied anywhere): remove the 0039 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name outcome_learning` (inside packages/database), run this script.
Referenced unique indexes are moved ahead of the foreign keys. Rollback: drop the triggers/functions twins_outcome_attribution_guard, twins_learning_job_guard, drop learning_job_runs, learning_insights, outcome_attributions, drop index trade_outcomes_id_user_unique, delete the journal entry."""
import sys
p = "packages/database/drizzle/0039_outcome_learning.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
SEP = "\n--> statement-breakpoint\n"
GEN = "--> statement-breakpoint\n"
REFERENCED = ["trade_outcomes_id_user_unique"]
stmts = s.split(GEN)
moved = [x for x in stmts if any(f'CREATE UNIQUE INDEX "{r}"' in x for r in REFERENCED)]
rest = [x for x in stmts if x not in moved]
last_table = max(i for i, x in enumerate(rest) if x.lstrip().startswith("CREATE TABLE"))
s = GEN.join(rest[: last_table + 1] + moved + rest[last_table + 1 :]).rstrip("\n")
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 08, ADR-017). Outcome attributions and insights are append-only evidence (twins_audit_forbid_change); a correction is a new version. The _no_update_delete suffix keeps the runtime role at SELECT + INSERT.")
for t in ["outcome_attributions", "learning_insights"]:
    o.append(f'CREATE TRIGGER "{t}_no_update_delete" BEFORE UPDATE OR DELETE ON "{t}" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
    o.append(f'CREATE TRIGGER "{t}_no_truncate" BEFORE TRUNCATE ON "{t}" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
    o.append(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;'); o.append(f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;')
    o.append(f'CREATE POLICY "{t}_owner_only" ON "{t}" USING (user_id = {CUR}) WITH CHECK (user_id = {CUR});')
o.append("-- HAND-APPENDED. Paper and live stay apart: until a live execution exists, an attribution can only be PAPER.")
o.append('ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_paper_only_check" CHECK ("mode" = \'PAPER\');')
o.append("-- HAND-APPENDED. Attribution version guard: version 1 starts a position's history; version N+1 must follow version N of the SAME position, decision, candidate, instrument, side and mode (a correction cannot re-point a record), must name it in supersedes_id, and a FINAL record can never be replaced by a PARTIAL one.")
o.append('''CREATE FUNCTION "twins_outcome_attribution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	prev record;
BEGIN
	IF NEW.version = 1 THEN
		IF EXISTS (SELECT 1 FROM outcome_attributions o WHERE o.paper_position_id = NEW.paper_position_id) THEN
			RAISE EXCEPTION 'this position already has an attribution: a change is a new version' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	SELECT * INTO prev FROM outcome_attributions o WHERE o.paper_position_id = NEW.paper_position_id AND o.version = NEW.version - 1;
	IF NOT FOUND OR prev.id IS DISTINCT FROM NEW.supersedes_id THEN
		RAISE EXCEPTION 'a new version must follow and name the previous version of the same position' USING ERRCODE = 'check_violation';
	END IF;
	IF prev.user_id <> NEW.user_id OR prev.account_id <> NEW.account_id OR prev.decision_id <> NEW.decision_id OR prev.candidate_id <> NEW.candidate_id OR prev.instrument <> NEW.instrument OR prev.side <> NEW.side OR prev.mode <> NEW.mode OR prev.candidate_source <> NEW.candidate_source THEN
		RAISE EXCEPTION 'a correction cannot change which position, decision, candidate, instrument, side or mode the outcome belongs to' USING ERRCODE = 'check_violation';
	END IF;
	IF prev.finality = 'FINAL' AND NEW.finality <> 'FINAL' THEN
		RAISE EXCEPTION 'a FINAL outcome cannot be replaced by a PARTIAL one' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "outcome_attributions_guard" BEFORE INSERT ON "outcome_attributions" FOR EACH ROW EXECUTE FUNCTION "twins_outcome_attribution_guard"();')
o.append("-- HAND-APPENDED. Learning job runs move only RUNNING -> COMPLETED / FAILED / ABANDONED; a finished run is final; identity never changes.")
o.append('''CREATE FUNCTION "twins_learning_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'RUNNING' THEN RAISE EXCEPTION 'a learning job run starts RUNNING' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.job <> OLD.job OR NEW.started_at <> OLD.started_at THEN RAISE EXCEPTION 'the identity of a job run cannot change' USING ERRCODE = 'check_violation'; END IF;
	IF OLD.status <> 'RUNNING' THEN RAISE EXCEPTION 'a % job run is final', OLD.status USING ERRCODE = 'check_violation'; END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "learning_job_runs_guard" BEFORE INSERT OR UPDATE ON "learning_job_runs" FOR EACH ROW EXECUTE FUNCTION "twins_learning_job_guard"();')
o.append('CREATE TRIGGER "learning_job_runs_no_delete" BEFORE DELETE ON "learning_job_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
open(p, "w").write(SEP.join(o) + "\n")
