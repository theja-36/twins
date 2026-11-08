CREATE TABLE "telegram_claim_candidacy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_claim_candidacy_outcome_check" CHECK ("telegram_claim_candidacy"."outcome" in ('CREATED', 'DUPLICATE', 'EXPIRED', 'SUPERSEDED_REVISION', 'INCOMPLETE', 'CONTRADICTORY', 'UNSUPPORTED')),
	CONSTRAINT "telegram_claim_candidacy_candidate_check" CHECK (("telegram_claim_candidacy"."outcome" = 'CREATED' and "telegram_claim_candidacy"."candidate_id" is not null) or ("telegram_claim_candidacy"."outcome" = 'DUPLICATE' and "telegram_claim_candidacy"."candidate_id" is not null) or ("telegram_claim_candidacy"."outcome" not in ('CREATED', 'DUPLICATE') and "telegram_claim_candidacy"."candidate_id" is null)),
	CONSTRAINT "telegram_claim_candidacy_reasons_check" CHECK (jsonb_typeof("telegram_claim_candidacy"."reason_codes") = 'array' and ("telegram_claim_candidacy"."outcome" = 'CREATED' or jsonb_array_length("telegram_claim_candidacy"."reason_codes") > 0))
);
--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "timeframe" text;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "thesis" text;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "missing_information" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "validation_status" text DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "candidate_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_claim_candidacy" ADD CONSTRAINT "telegram_claim_candidacy_claim_id_options_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_claim_candidacy" ADD CONSTRAINT "telegram_claim_candidacy_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_claim_candidacy_claim_policy_unique" ON "telegram_claim_candidacy" USING btree ("claim_id","policy_version");--> statement-breakpoint
CREATE INDEX "telegram_claim_candidacy_outcome_idx" ON "telegram_claim_candidacy" USING btree ("outcome","evaluated_at");--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_validation_check" CHECK ("opportunity_candidates"."validation_status" in ('UNVERIFIED', 'PARTIALLY_VERIFIED', 'VERIFIED', 'NOT_APPLICABLE'));--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_version_check" CHECK ("opportunity_candidates"."candidate_version" >= 1);--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_telegram_provenance_check" CHECK ("opportunity_candidates"."source" <> 'TELEGRAM' or (jsonb_typeof("opportunity_candidates"."provenance") = 'object' and "opportunity_candidates"."provenance" ? 'messageId' and "opportunity_candidates"."provenance" ? 'channelId' and "opportunity_candidates"."thesis" is not null));
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 03, G-19). The candidacy audit is append-only evidence: a decision about a claim is never edited or deleted (a new policy version adds a new row).
--> statement-breakpoint
CREATE TRIGGER "telegram_claim_candidacy_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_claim_candidacy" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "telegram_claim_candidacy_no_truncate" BEFORE TRUNCATE ON "telegram_claim_candidacy" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. A Telegram candidate can only come from a stored PARSED CLAIM (result_kind = 'claim'): ambiguous, unsupported and non-signal messages can never become a candidate, whatever code tries.
--> statement-breakpoint
CREATE FUNCTION "twins_telegram_candidate_origin_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.source = 'TELEGRAM' AND NOT EXISTS (SELECT 1 FROM options_claims c WHERE c.id = NEW.claim_id AND c.result_kind = 'claim') THEN
		RAISE EXCEPTION 'a Telegram candidate needs a stored parsed claim (not an ambiguous, unsupported or non-signal message)' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidates_telegram_origin_guard" BEFORE INSERT ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_telegram_candidate_origin_guard"();
--> statement-breakpoint
-- HAND-APPENDED. What a candidate says about its source (thesis, timeframe, missing information, provenance, version) never changes after insert: a changed claim is a NEW candidate version that supersedes the old one. Only validation_status may advance (when a verification later succeeds).
--> statement-breakpoint
CREATE FUNCTION "twins_candidate_thesis_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.thesis IS DISTINCT FROM OLD.thesis OR NEW.timeframe IS DISTINCT FROM OLD.timeframe OR NEW.missing_information IS DISTINCT FROM OLD.missing_information
	   OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.candidate_version <> OLD.candidate_version THEN
		RAISE EXCEPTION 'the thesis, timeframe, missing information, provenance and version of a candidate never change: a changed claim is a new candidate version' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidates_thesis_guard" BEFORE UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_thesis_guard"();
