-- HAND-WRITTEN PRE-FLIGHT (Master Build Stage 08, G-49). trade_outcomes is append-only, so duplicate outcomes for one paper position cannot be repaired by this migration. If any exist, stop with a precise message instead of a bare index error.
DO $$
DECLARE dup integer;
BEGIN
	SELECT count(*) INTO dup FROM (SELECT paper_position_id FROM trade_outcomes WHERE paper_position_id IS NOT NULL GROUP BY paper_position_id HAVING count(*) > 1) d;
	IF dup > 0 THEN RAISE EXCEPTION 'migration 0046 refused: % paper position(s) already have more than one trade outcome; resolve them with the owner before applying (trade_outcomes is append-only)', dup USING ERRCODE = 'check_violation'; END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "analytics_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"evidence_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"algorithm_versions" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"watermarks" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"report_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_snapshots_mode_check" CHECK ("analytics_snapshots"."mode" = 'PAPER'),
	CONSTRAINT "analytics_snapshots_creator_check" CHECK ("analytics_snapshots"."created_by" in ('API', 'LEARNING_CYCLE', 'OPERATOR')),
	CONSTRAINT "analytics_snapshots_hash_check" CHECK ("analytics_snapshots"."evidence_hash" ~ '^[0-9a-f]{64}$' and "analytics_snapshots"."input_hash" ~ '^[0-9a-f]{64}$' and "analytics_snapshots"."config_hash" ~ '^[0-9a-f]{64}$' and "analytics_snapshots"."report_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_snapshots_input_unique" ON "analytics_snapshots" USING btree ("user_id","input_hash");--> statement-breakpoint
CREATE INDEX "analytics_snapshots_latest_idx" ON "analytics_snapshots" USING btree ("user_id","mode","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_outcomes_paper_position_unique" ON "trade_outcomes" USING btree ("paper_position_id") WHERE "trade_outcomes"."paper_position_id" is not null;
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 08, A2). A snapshot is an immutable record of an analytics report and of exactly what it was built from: append-only, never edited or deleted (a later state of the evidence is a NEW snapshot).
--> statement-breakpoint
CREATE TRIGGER "analytics_snapshots_no_update_delete" BEFORE UPDATE OR DELETE ON "analytics_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "analytics_snapshots_no_truncate" BEFORE TRUNCATE ON "analytics_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Owner-only row-level security, forced on the table owner too; with no user bound the policy matches nothing (fail closed).
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "analytics_snapshots_owner_only" ON "analytics_snapshots" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
