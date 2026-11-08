#!/usr/bin/env python3
"""Appends the hand-written part of migration 0036 (opportunity candidate lifecycle guard + append-only lifecycle history) to the drizzle-generated SQL.
Regenerate flow (migration not yet applied anywhere): remove the 0036 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name opportunity_engine` (inside packages/database), run this script.
Rollback (additive; no later migration depends on it): DROP TRIGGER opportunity_candidates_lifecycle_guard / _lifecycle_audit ON opportunity_candidates; DROP FUNCTION twins_candidate_lifecycle_guard(), twins_candidate_lifecycle_audit(); DROP TABLE opportunity_candidate_events;
ALTER TABLE opportunity_candidates / opportunity_scans DROP the added columns; restore the 5-value state check; delete the journal entry."""
import sys
p = "packages/database/drizzle/0036_opportunity_engine.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build" in s: sys.exit("already appended")
SEP = "\n--> statement-breakpoint\n"
guard = r'''CREATE FUNCTION "twins_candidate_lifecycle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.state <> 'NEW' THEN RAISE EXCEPTION 'a candidate must start NEW' USING ERRCODE = 'check_violation'; END IF;
		IF NEW.superseded_by IS NOT NULL THEN RAISE EXCEPTION 'a new candidate cannot be superseded' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	-- the thesis is immutable: a changed setup is a NEW candidate (the old one is superseded), never an edit
	IF NEW.id <> OLD.id OR NEW.source <> OLD.source OR NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.scan_id IS DISTINCT FROM OLD.scan_id
	   OR NEW.underlying <> OLD.underlying OR NEW.exchange <> OLD.exchange OR NEW.strike IS DISTINCT FROM OLD.strike OR NEW.option_type IS DISTINCT FROM OLD.option_type
	   OR NEW.expiry IS DISTINCT FROM OLD.expiry OR NEW.side <> OLD.side OR NEW.entry_kind <> OLD.entry_kind OR NEW.entry_low IS DISTINCT FROM OLD.entry_low
	   OR NEW.entry_high IS DISTINCT FROM OLD.entry_high OR NEW.stop_loss IS DISTINCT FROM OLD.stop_loss OR NEW.targets <> OLD.targets OR NEW.data_source <> OLD.data_source
	   OR NEW.correlation_id <> OLD.correlation_id OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
	   OR NEW.invalidation IS DISTINCT FROM OLD.invalidation THEN
		RAISE EXCEPTION 'the identity and thesis of a candidate cannot change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state = OLD.state THEN
		IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN RAISE EXCEPTION 'superseded_by changes only with the state' USING ERRCODE = 'check_violation'; END IF;
		IF OLD.state IN ('EXPIRED', 'WITHDRAWN', 'INVALIDATED', 'SUPERSEDED') AND (NEW.state_reason IS DISTINCT FROM OLD.state_reason) THEN RAISE EXCEPTION 'a finished candidate does not change' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF OLD.state IN ('EXPIRED', 'WITHDRAWN', 'INVALIDATED', 'SUPERSEDED') THEN RAISE EXCEPTION 'a % candidate cannot change state', OLD.state USING ERRCODE = 'check_violation'; END IF;
	IF NOT ((OLD.state = 'NEW' AND NEW.state IN ('IN_RESEARCH', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'))
	     OR (OLD.state = 'IN_RESEARCH' AND NEW.state IN ('NEW', 'READY_FOR_DECISION', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'))
	     OR (OLD.state = 'READY_FOR_DECISION' AND NEW.state IN ('EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'))) THEN
		RAISE EXCEPTION 'illegal candidate transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state IN ('EXPIRED', 'WITHDRAWN', 'INVALIDATED', 'SUPERSEDED') AND (NEW.state_reason IS NULL OR length(NEW.state_reason) = 0) THEN
		RAISE EXCEPTION 'ending a candidate needs a reason' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state = 'SUPERSEDED' AND NEW.superseded_by IS NULL THEN RAISE EXCEPTION 'a superseded candidate names its successor' USING ERRCODE = 'check_violation'; END IF;
	IF NEW.state <> 'SUPERSEDED' AND NEW.superseded_by IS NOT NULL THEN RAISE EXCEPTION 'only a superseded candidate has a successor' USING ERRCODE = 'check_violation'; END IF;
	RETURN NEW;
END $$;'''
audit = r'''CREATE FUNCTION "twins_candidate_lifecycle_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO opportunity_candidate_events (id, candidate_id, from_state, to_state, reason) VALUES (gen_random_uuid(), NEW.id, NULL, NEW.state, NEW.state_reason);
	ELSIF NEW.state <> OLD.state THEN
		INSERT INTO opportunity_candidate_events (id, candidate_id, from_state, to_state, reason) VALUES (gen_random_uuid(), NEW.id, OLD.state, NEW.state, NEW.state_reason);
	END IF;
	RETURN NULL;
END $$;'''
o = [s,
  "-- HAND-APPENDED (Master Build Stage 05, ADR-014). The lifecycle history is append-only (existing twins_audit_forbid_change); the _no_update_delete suffix keeps the runtime role at SELECT + INSERT.",
  'CREATE TRIGGER "opportunity_candidate_events_no_update_delete" BEFORE UPDATE OR DELETE ON "opportunity_candidate_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();',
  'CREATE TRIGGER "opportunity_candidate_events_no_truncate" BEFORE TRUNCATE ON "opportunity_candidate_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();',
  "-- HAND-APPENDED. Candidate lifecycle guard: starts NEW; the thesis (instrument, side, entry, stop-loss, targets, invalidation, expiry, identity) never changes after insert; only legal state transitions; finished states are final; ending a candidate needs a reason; SUPERSEDED names its successor.",
  guard,
  'CREATE TRIGGER "opportunity_candidates_lifecycle_guard" BEFORE INSERT OR UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_lifecycle_guard"();',
  "-- HAND-APPENDED. Every state change writes its history row from the database itself, so no code path can change a state without leaving the audit record.",
  audit,
  'CREATE TRIGGER "opportunity_candidates_lifecycle_audit" AFTER INSERT OR UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_lifecycle_audit"();',
]
open(p, "w").write(SEP.join(o) + "\n")
