CREATE TABLE "ai_usage_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_sha256" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(16, 8) NOT NULL,
	"latency_ms" integer NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_kind" text,
	"request_id" text NOT NULL,
	"gateway_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_records_outcome_check" CHECK ("ai_usage_records"."outcome" in ('OK', 'INVALID_OUTPUT', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'BUDGET_BLOCKED')),
	CONSTRAINT "ai_usage_records_tokens_check" CHECK ("ai_usage_records"."input_tokens" >= 0 and "ai_usage_records"."output_tokens" >= 0 and "ai_usage_records"."latency_ms" >= 0 and "ai_usage_records"."attempt" >= 1),
	CONSTRAINT "ai_usage_records_cost_check" CHECK ("ai_usage_records"."cost_usd" >= 0),
	CONSTRAINT "ai_usage_records_prompt_sha_check" CHECK ("ai_usage_records"."prompt_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_records_day_idx" ON "ai_usage_records" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_records_user_idx" ON "ai_usage_records" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_records_request_idx" ON "ai_usage_records" USING btree ("request_id");
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 04, ADR-005/ADR-013). The usage ledger is append-only: it rejects UPDATE / DELETE / TRUNCATE through the existing twins_audit_forbid_change function. Stores no prompt or response text.
--> statement-breakpoint
CREATE TRIGGER "ai_usage_records_no_update_delete" BEFORE UPDATE OR DELETE ON "ai_usage_records" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "ai_usage_records_no_truncate" BEFORE TRUNCATE ON "ai_usage_records" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Row-level security, shared-or-owner: a user sees and writes their own rows; platform rows (user_id null) are visible to everyone and may only be written with no user bound.
--> statement-breakpoint
ALTER TABLE "ai_usage_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_usage_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_usage_records_shared_or_owner" ON "ai_usage_records" USING (user_id is null or user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK ((user_id is null and nullif(current_setting('twins.user_id', true), '')::uuid is null) or user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
