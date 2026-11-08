CREATE TABLE "learning_insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"insight_key" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"outcome_count" integer NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"provenance" jsonb NOT NULL,
	"method" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"reliability" text NOT NULL,
	"severity" text DEFAULT 'INFO' NOT NULL,
	"statement" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"limitations" jsonb NOT NULL,
	"recommendation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_insights_kind_check" CHECK ("learning_insights"."kind" in ('PERFORMANCE', 'STRATEGY', 'CHANNEL', 'PATTERN', 'REGIME', 'AGENT', 'DECISION_QUALITY', 'RISK_EXECUTION', 'DRIFT', 'DATA_QUALITY', 'CALIBRATION', 'RESEARCH_AREA')),
	CONSTRAINT "learning_insights_reliability_check" CHECK ("learning_insights"."reliability" in ('INSUFFICIENT_DATA', 'NOT_VALIDATED_FIXTURE', 'LOW', 'MODERATE', 'ADEQUATE', 'NOT_CALIBRATED', 'UNAVAILABLE')),
	CONSTRAINT "learning_insights_severity_check" CHECK ("learning_insights"."severity" in ('INFO', 'WARNING')),
	CONSTRAINT "learning_insights_recommendation_check" CHECK ("learning_insights"."recommendation" is null or "learning_insights"."recommendation" = 'REVIEW'),
	CONSTRAINT "learning_insights_count_check" CHECK ("learning_insights"."outcome_count" >= 0),
	CONSTRAINT "learning_insights_adequate_check" CHECK ("learning_insights"."reliability" <> 'ADEQUATE' or "learning_insights"."outcome_count" >= 30)
);
--> statement-breakpoint
CREATE TABLE "learning_job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_kind" text,
	CONSTRAINT "learning_job_runs_status_check" CHECK ("learning_job_runs"."status" in ('RUNNING', 'COMPLETED', 'FAILED', 'ABANDONED')),
	CONSTRAINT "learning_job_runs_finished_check" CHECK (("learning_job_runs"."status" = 'RUNNING') = ("learning_job_runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "outcome_attributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"paper_position_id" uuid NOT NULL,
	"outcome_id" uuid,
	"decision_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"finality" text NOT NULL,
	"mode" text NOT NULL,
	"data_source" text NOT NULL,
	"candidate_source" text NOT NULL,
	"setup" text,
	"detector_version" text,
	"channel_id" text,
	"playbook_ref" jsonb,
	"instrument" text NOT NULL,
	"timeframe_seconds" integer,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric,
	"gross_pnl" numeric,
	"costs" numeric,
	"net_pnl" numeric,
	"risk_amount" numeric,
	"r_multiple" numeric,
	"holding_seconds" integer,
	"exit_reason" text,
	"trade" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"regime" jsonb,
	"agent_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"predicted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_score" numeric,
	"confidence_at" timestamp with time zone,
	"decided_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"data_quality" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_attributions_finality_check" CHECK ("outcome_attributions"."finality" in ('PARTIAL', 'FINAL')),
	CONSTRAINT "outcome_attributions_mode_check" CHECK ("outcome_attributions"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "outcome_attributions_data_source_check" CHECK ("outcome_attributions"."data_source" in ('FIXTURE', 'LIVE', 'HISTORICAL')),
	CONSTRAINT "outcome_attributions_candidate_source_check" CHECK ("outcome_attributions"."candidate_source" in ('TELEGRAM', 'INDEPENDENT')),
	CONSTRAINT "outcome_attributions_version_check" CHECK ("outcome_attributions"."version" >= 1 and (("outcome_attributions"."version" = 1 and "outcome_attributions"."supersedes_id" is null and "outcome_attributions"."correction_reason" is null) or ("outcome_attributions"."version" > 1 and "outcome_attributions"."supersedes_id" is not null and length("outcome_attributions"."correction_reason") >= 10))),
	CONSTRAINT "outcome_attributions_final_check" CHECK (("outcome_attributions"."finality" = 'FINAL' and "outcome_attributions"."outcome_id" is not null and "outcome_attributions"."exit_price" is not null and "outcome_attributions"."net_pnl" is not null and "outcome_attributions"."gross_pnl" is not null and "outcome_attributions"."closed_at" is not null and "outcome_attributions"."holding_seconds" is not null and "outcome_attributions"."exit_reason" is not null and "outcome_attributions"."closed_at" >= "outcome_attributions"."opened_at") or ("outcome_attributions"."finality" = 'PARTIAL' and "outcome_attributions"."outcome_id" is null and "outcome_attributions"."closed_at" is null)),
	CONSTRAINT "outcome_attributions_value_check" CHECK ("outcome_attributions"."quantity" > 0 and "outcome_attributions"."entry_price" > 0 and ("outcome_attributions"."holding_seconds" is null or "outcome_attributions"."holding_seconds" >= 0) and ("outcome_attributions"."confidence_score" is null or ("outcome_attributions"."confidence_score" >= 0 and "outcome_attributions"."confidence_score" <= 100)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trade_outcomes_id_user_unique" ON "trade_outcomes" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "learning_insights" ADD CONSTRAINT "learning_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_outcome_fk" FOREIGN KEY ("outcome_id","user_id") REFERENCES "public"."trade_outcomes"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_position_fk" FOREIGN KEY ("paper_position_id","user_id") REFERENCES "public"."paper_positions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."outcome_attributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_insights_key_unique" ON "learning_insights" USING btree ("user_id","insight_key");--> statement-breakpoint
CREATE INDEX "learning_insights_user_idx" ON "learning_insights" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_job_runs_one_running" ON "learning_job_runs" USING btree ("job") WHERE "learning_job_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "learning_job_runs_job_idx" ON "learning_job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_attributions_position_version_unique" ON "outcome_attributions" USING btree ("paper_position_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_attributions_id_user_unique" ON "outcome_attributions" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX "outcome_attributions_user_idx" ON "outcome_attributions" USING btree ("user_id","mode","closed_at");
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 08, ADR-017). Outcome attributions and insights are append-only evidence (twins_audit_forbid_change); a correction is a new version. The _no_update_delete suffix keeps the runtime role at SELECT + INSERT.
--> statement-breakpoint
CREATE TRIGGER "outcome_attributions_no_update_delete" BEFORE UPDATE OR DELETE ON "outcome_attributions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "outcome_attributions_no_truncate" BEFORE TRUNCATE ON "outcome_attributions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
ALTER TABLE "outcome_attributions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outcome_attributions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outcome_attributions_owner_only" ON "outcome_attributions" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER "learning_insights_no_update_delete" BEFORE UPDATE OR DELETE ON "learning_insights" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "learning_insights_no_truncate" BEFORE TRUNCATE ON "learning_insights" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
ALTER TABLE "learning_insights" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "learning_insights" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "learning_insights_owner_only" ON "learning_insights" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
-- HAND-APPENDED. Paper and live stay apart: until a live execution exists, an attribution can only be PAPER.
--> statement-breakpoint
ALTER TABLE "outcome_attributions" ADD CONSTRAINT "outcome_attributions_paper_only_check" CHECK ("mode" = 'PAPER');
--> statement-breakpoint
-- HAND-APPENDED. Attribution version guard: version 1 starts a position's history; version N+1 must follow version N of the SAME position, decision, candidate, instrument, side and mode (a correction cannot re-point a record), must name it in supersedes_id, and a FINAL record can never be replaced by a PARTIAL one.
--> statement-breakpoint
CREATE FUNCTION "twins_outcome_attribution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE TRIGGER "outcome_attributions_guard" BEFORE INSERT ON "outcome_attributions" FOR EACH ROW EXECUTE FUNCTION "twins_outcome_attribution_guard"();
--> statement-breakpoint
-- HAND-APPENDED. Learning job runs move only RUNNING -> COMPLETED / FAILED / ABANDONED; a finished run is final; identity never changes.
--> statement-breakpoint
CREATE FUNCTION "twins_learning_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'RUNNING' THEN RAISE EXCEPTION 'a learning job run starts RUNNING' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.job <> OLD.job OR NEW.started_at <> OLD.started_at THEN RAISE EXCEPTION 'the identity of a job run cannot change' USING ERRCODE = 'check_violation'; END IF;
	IF OLD.status <> 'RUNNING' THEN RAISE EXCEPTION 'a % job run is final', OLD.status USING ERRCODE = 'check_violation'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "learning_job_runs_guard" BEFORE INSERT OR UPDATE ON "learning_job_runs" FOR EACH ROW EXECUTE FUNCTION "twins_learning_job_guard"();
--> statement-breakpoint
CREATE TRIGGER "learning_job_runs_no_delete" BEFORE DELETE ON "learning_job_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
