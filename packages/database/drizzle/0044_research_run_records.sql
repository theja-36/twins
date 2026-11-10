CREATE TABLE "research_agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"research_package_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"status" text NOT NULL,
	"verdict" text NOT NULL,
	"confidence" numeric(5, 2),
	"attempts" integer NOT NULL,
	"input_snapshot_ref" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"meta" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_runs_value_check" CHECK ("research_agent_runs"."agent_id" ~ '^[a-z][a-z0-9_-]{2,40}$' and "research_agent_runs"."input_snapshot_ref" ~ '^[0-9a-f]{64}$' and "research_agent_runs"."attempts" >= 0 and "research_agent_runs"."duration_ms" >= 0 and ("research_agent_runs"."error_code" is null or "research_agent_runs"."error_code" ~ '^[A-Z][A-Z0-9_]{2,60}$') and ("research_agent_runs"."error_message" is null or char_length("research_agent_runs"."error_message") <= 300)),
	CONSTRAINT "research_agent_runs_status_check" CHECK ("research_agent_runs"."status" in ('COMPLETED', 'FAILED', 'TIMEOUT', 'SKIPPED', 'UNAVAILABLE') and "research_agent_runs"."verdict" in ('SUPPORTIVE', 'NEUTRAL', 'CAUTION', 'ADVERSE', 'BLOCKING', 'UNAVAILABLE') and (("research_agent_runs"."status" = 'COMPLETED') = ("research_agent_runs"."verdict" <> 'UNAVAILABLE')) and (("research_agent_runs"."status" = 'COMPLETED') = ("research_agent_runs"."confidence" is not null)) and ("research_agent_runs"."confidence" is null or ("research_agent_runs"."confidence" >= 0 and "research_agent_runs"."confidence" <= 100))),
	CONSTRAINT "research_agent_runs_size_check" CHECK (octet_length("research_agent_runs"."input_snapshot"::text) <= 65536 and octet_length("research_agent_runs"."output_snapshot"::text) <= 16384 and octet_length("research_agent_runs"."findings"::text) <= 65536 and octet_length("research_agent_runs"."evidence"::text) <= 16384 and octet_length("research_agent_runs"."meta"::text) <= 4096 and jsonb_typeof("research_agent_runs"."findings") = 'array' and jsonb_typeof("research_agent_runs"."evidence") = 'array')
);
--> statement-breakpoint
ALTER TABLE "research_packages" ADD COLUMN "run_key" text;--> statement-breakpoint
ALTER TABLE "research_agent_runs" ADD CONSTRAINT "research_agent_runs_research_package_id_research_packages_id_fk" FOREIGN KEY ("research_package_id") REFERENCES "public"."research_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_agent_runs_package_agent_unique" ON "research_agent_runs" USING btree ("research_package_id","agent_id");--> statement-breakpoint
CREATE INDEX "research_agent_runs_agent_idx" ON "research_agent_runs" USING btree ("agent_id","agent_version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_packages_candidate_run_key_unique" ON "research_packages" USING btree ("candidate_id","run_key") WHERE "research_packages"."run_key" is not null;--> statement-breakpoint
ALTER TABLE "research_packages" ADD CONSTRAINT "research_packages_run_key_check" CHECK ("research_packages"."run_key" is null or "research_packages"."run_key" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 04, G-44). The per-agent run records of a research package are append-only evidence: they are written with the package, never edited or deleted (a new evaluation is a new package version with its own rows).
--> statement-breakpoint
CREATE TRIGGER "research_agent_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "research_agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "research_agent_runs_no_truncate" BEFORE TRUNCATE ON "research_agent_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
