#!/usr/bin/env python3
"""Appends the hand-written part of migration 0042 (Stage 03: Telegram claims to candidates, G-19) to the drizzle-generated SQL.
Regenerate flow (not yet applied anywhere): remove the 0042 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name telegram_candidates` (inside packages/database), run this script.
Rollback (forward-only: write a new migration, never edit 0042): drop triggers telegram_claim_candidacy_no_update_delete / _no_truncate, opportunity_candidates_telegram_origin_guard, opportunity_candidates_telegram_thesis_guard and their functions; drop table telegram_claim_candidacy; drop the six added opportunity_candidates columns and their checks."""
import sys
p = "packages/database/drizzle/0042_telegram_candidates.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 03" in s: sys.exit("already appended")
o = [s]
o.append("-- HAND-APPENDED (Master Build Stage 03, G-19). The candidacy audit is append-only evidence: a decision about a claim is never edited or deleted (a new policy version adds a new row).")
o.append('CREATE TRIGGER "telegram_claim_candidacy_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_claim_candidacy" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append('CREATE TRIGGER "telegram_claim_candidacy_no_truncate" BEFORE TRUNCATE ON "telegram_claim_candidacy" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();')
o.append("-- HAND-APPENDED. A Telegram candidate can only come from a stored PARSED CLAIM (result_kind = 'claim'): ambiguous, unsupported and non-signal messages can never become a candidate, whatever code tries.")
o.append('''CREATE FUNCTION "twins_telegram_candidate_origin_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.source = 'TELEGRAM' AND NEW.claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM options_claims c WHERE c.id = NEW.claim_id AND c.result_kind = 'claim') THEN
		RAISE EXCEPTION 'a Telegram candidate needs a stored parsed claim (not an ambiguous, unsupported or non-signal message)' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "opportunity_candidates_telegram_origin_guard" BEFORE INSERT ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_telegram_candidate_origin_guard"();')
o.append("-- HAND-APPENDED. What a candidate says about its source (thesis, timeframe, missing information, provenance, version) never changes after insert: a changed claim is a NEW candidate version that supersedes the old one. Only validation_status may advance (when a verification later succeeds).")
o.append('''CREATE FUNCTION "twins_candidate_thesis_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.thesis IS DISTINCT FROM OLD.thesis OR NEW.timeframe IS DISTINCT FROM OLD.timeframe OR NEW.missing_information IS DISTINCT FROM OLD.missing_information
	   OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.candidate_version <> OLD.candidate_version THEN
		RAISE EXCEPTION 'the thesis, timeframe, missing information, provenance and version of a candidate never change: a changed claim is a new candidate version' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "opportunity_candidates_thesis_guard" BEFORE UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_thesis_guard"();')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
