CREATE TABLE "opportunity_candidate_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_candidate_events_to_check" CHECK ("opportunity_candidate_events"."to_state" in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION', 'EXPIRED', 'WITHDRAWN', 'INVALIDATED', 'SUPERSEDED'))
);
--> statement-breakpoint
ALTER TABLE "opportunity_candidates" DROP CONSTRAINT "opportunity_candidates_state_check";--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "invalidation" jsonb;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "state_reason" text;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "research_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD COLUMN "rank_score" numeric;--> statement-breakpoint
ALTER TABLE "opportunity_scans" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "opportunity_scans" ADD COLUMN "universe_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_scans" ADD COLUMN "skipped" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_scans" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "opportunity_candidate_events" ADD CONSTRAINT "opportunity_candidate_events_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_candidate_events_candidate_idx" ON "opportunity_candidate_events" USING btree ("candidate_id","occurred_at");--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opp_candidates_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_candidates_dedupe_unique" ON "opportunity_candidates" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_scans_slot_unique" ON "opportunity_scans" USING btree ("scan_kind","slot_key");--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_attempts_check" CHECK ("opportunity_candidates"."research_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_state_check" CHECK ("opportunity_candidates"."state" in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION', 'EXPIRED', 'WITHDRAWN', 'INVALIDATED', 'SUPERSEDED'));
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 05, ADR-014). The lifecycle history is append-only (existing twins_audit_forbid_change); the _no_update_delete suffix keeps the runtime role at SELECT + INSERT.
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidate_events_no_update_delete" BEFORE UPDATE OR DELETE ON "opportunity_candidate_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidate_events_no_truncate" BEFORE TRUNCATE ON "opportunity_candidate_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Candidate lifecycle guard: starts NEW; the thesis (instrument, side, entry, stop-loss, targets, invalidation, expiry, identity) never changes after insert; only legal state transitions; finished states are final; ending a candidate needs a reason; SUPERSEDED names its successor.
--> statement-breakpoint
CREATE FUNCTION "twins_candidate_lifecycle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidates_lifecycle_guard" BEFORE INSERT OR UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_lifecycle_guard"();
--> statement-breakpoint
-- HAND-APPENDED. Every state change writes its history row from the database itself, so no code path can change a state without leaving the audit record.
--> statement-breakpoint
CREATE FUNCTION "twins_candidate_lifecycle_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO opportunity_candidate_events (id, candidate_id, from_state, to_state, reason) VALUES (gen_random_uuid(), NEW.id, NULL, NEW.state, NEW.state_reason);
	ELSIF NEW.state <> OLD.state THEN
		INSERT INTO opportunity_candidate_events (id, candidate_id, from_state, to_state, reason) VALUES (gen_random_uuid(), NEW.id, OLD.state, NEW.state, NEW.state_reason);
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "opportunity_candidates_lifecycle_audit" AFTER INSERT OR UPDATE ON "opportunity_candidates" FOR EACH ROW EXECUTE FUNCTION "twins_candidate_lifecycle_audit"();
