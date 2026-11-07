CREATE TABLE "shadow_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"risk_decision_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL,
	"used_for_decisions" boolean DEFAULT false NOT NULL,
	CONSTRAINT "shadow_observations_kind_check" CHECK ("shadow_observations"."kind" in ('agent_engine', 'reduce_only_sizing')),
	CONSTRAINT "shadow_observations_not_used_check" CHECK ("shadow_observations"."used_for_decisions" = false),
	CONSTRAINT "shadow_observations_version_check" CHECK ("shadow_observations"."decision_version" >= 1),
	CONSTRAINT "shadow_observations_size_check" CHECK (pg_column_size("shadow_observations"."result") <= 16384)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_observations_run_unique" ON "shadow_observations" USING btree ("kind","risk_decision_id","decision_version");
--> statement-breakpoint
-- HAND-APPENDED (HB-25). Append-only like the other audit-style tables: UPDATE / DELETE / TRUNCATE are rejected by the existing twins_audit_forbid_change() trigger function. The trigger name ends in
-- _no_update_delete, so infrastructure/staging/app-role.sql grants the runtime role SELECT and INSERT only (no UPDATE, no DELETE). Not hash-chained and no foreign key, on purpose (see the schema comment).
CREATE TRIGGER "shadow_observations_no_update_delete" BEFORE UPDATE OR DELETE ON "shadow_observations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "shadow_observations_no_truncate" BEFORE TRUNCATE ON "shadow_observations" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
