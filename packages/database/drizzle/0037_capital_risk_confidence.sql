CREATE TABLE "risk_control_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"scope" text NOT NULL,
	"scope_key" text,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"actor_kind" text NOT NULL,
	"expires_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_control_events_scope_check" CHECK ("risk_control_events"."scope" in ('USER', 'MARKET', 'SOURCE', 'STRATEGY')),
	CONSTRAINT "risk_control_events_kind_check" CHECK ("risk_control_events"."kind" in ('RESTRICTION', 'DAILY_LOSS_HALT', 'DRAWDOWN_HALT', 'KILL_SWITCH')),
	CONSTRAINT "risk_control_events_action_check" CHECK ("risk_control_events"."action" in ('SET', 'CLEAR')),
	CONSTRAINT "risk_control_events_actor_kind_check" CHECK ("risk_control_events"."actor_kind" in ('OWNER', 'SYSTEM')),
	CONSTRAINT "risk_control_events_user_scope_check" CHECK ("risk_control_events"."scope" <> 'USER' or "risk_control_events"."user_id" is not null),
	CONSTRAINT "risk_control_events_reason_check" CHECK (length("risk_control_events"."reason") >= 10),
	CONSTRAINT "risk_control_events_clear_policy_check" CHECK ("risk_control_events"."action" <> 'CLEAR' or "risk_control_events"."actor_kind" = 'OWNER' or "risk_control_events"."kind" in ('RESTRICTION', 'DAILY_LOSS_HALT')),
	CONSTRAINT "risk_control_events_expiry_check" CHECK ("risk_control_events"."expires_at" is null or "risk_control_events"."action" = 'SET')
);
--> statement-breakpoint
ALTER TABLE "user_capital_profiles" ADD COLUMN "max_position_notional_pct" numeric;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD COLUMN "max_drawdown_pct" numeric;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD COLUMN "max_portfolio_exposure_pct" numeric;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD COLUMN "max_correlated_risk_pct" numeric;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD COLUMN "verdict" text DEFAULT 'BLOCKED' NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD COLUMN "research_package_id" uuid;--> statement-breakpoint
ALTER TABLE "simulations" ADD COLUMN "risk_assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_control_events" ADD CONSTRAINT "risk_control_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_control_events_state_idx" ON "risk_control_events" USING btree ("scope","scope_key","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "risk_control_events_user_idx" ON "risk_control_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_research_package_id_research_packages_id_fk" FOREIGN KEY ("research_package_id") REFERENCES "public"."research_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_assessment_owner_fk" FOREIGN KEY ("risk_assessment_id","user_id") REFERENCES "public"."risk_assessments"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capital_profiles" ADD CONSTRAINT "user_capital_profiles_position_pct_check" CHECK ("user_capital_profiles"."max_position_notional_pct" is null or ("user_capital_profiles"."max_position_notional_pct" > 0 and "user_capital_profiles"."max_position_notional_pct" <= 100));--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_extra_limits_check" CHECK (("user_risk_policies"."max_drawdown_pct" is null or ("user_risk_policies"."max_drawdown_pct" > 0 and "user_risk_policies"."max_drawdown_pct" <= 100)) and ("user_risk_policies"."max_portfolio_exposure_pct" is null or ("user_risk_policies"."max_portfolio_exposure_pct" > 0 and "user_risk_policies"."max_portfolio_exposure_pct" <= 100)) and ("user_risk_policies"."max_correlated_risk_pct" is null or ("user_risk_policies"."max_correlated_risk_pct" > 0 and "user_risk_policies"."max_correlated_risk_pct" <= 5)));--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_verdict_check" CHECK ("risk_assessments"."verdict" in ('PASS', 'RESTRICTED', 'BLOCKED') and "risk_assessments"."passed" = ("risk_assessments"."verdict" = 'PASS'));
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 06, ADR-015). Control history is append-only (twins_audit_forbid_change); a control is set and cleared by new rows. The _no_update_delete suffix keeps the runtime role at SELECT + INSERT.
--> statement-breakpoint
CREATE TRIGGER "risk_control_events_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_control_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "risk_control_events_no_truncate" BEFORE TRUNCATE ON "risk_control_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Row-level security, shared-or-owner: platform controls (user_id null) are visible to everyone and written with no user bound; a user's controls are visible and writable only for that user.
--> statement-breakpoint
ALTER TABLE "risk_control_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "risk_control_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "risk_control_events_shared_or_owner" ON "risk_control_events" USING (user_id is null or user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK ((user_id is null and nullif(current_setting('twins.user_id', true), '')::uuid is null) or user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
