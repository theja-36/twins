CREATE TABLE "decision_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"action" text NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"permission_mode" text NOT NULL,
	"revalidation" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_approvals_action_check" CHECK ("decision_approvals"."action" in ('APPROVE', 'REJECT')),
	CONSTRAINT "decision_approvals_owner_check" CHECK ("decision_approvals"."approver_user_id" = "decision_approvals"."user_id"),
	CONSTRAINT "decision_approvals_mode_check" CHECK ("decision_approvals"."permission_mode" = 'PAPER'),
	CONSTRAINT "decision_approvals_revalidation_check" CHECK ("decision_approvals"."action" <> 'APPROVE' or ("decision_approvals"."revalidation"->>'passed') = 'true')
);
--> statement-breakpoint
CREATE TABLE "decision_invalidations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refusal_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_requests_mode_check" CHECK ("execution_requests"."mode" in ('PAPER', 'ASSISTED_LIVE', 'CONTROLLED_AUTO')),
	CONSTRAINT "execution_requests_state_check" CHECK ("execution_requests"."state" in ('REQUESTED', 'ELIGIBLE', 'REJECTED', 'COMPLETED', 'FAILED')),
	CONSTRAINT "execution_requests_live_disabled_check" CHECK ("execution_requests"."mode" = 'PAPER' or "execution_requests"."state" = 'REJECTED')
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"costs" numeric DEFAULT '0' NOT NULL,
	"price_source" text NOT NULL,
	"price_as_of" timestamp with time zone NOT NULL,
	"filled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_fills_value_check" CHECK ("paper_fills"."quantity" > 0 and "paper_fills"."price" > 0 and "paper_fills"."costs" >= 0),
	CONSTRAINT "paper_fills_source_check" CHECK ("paper_fills"."price_source" in ('FIXTURE', 'LIVE', 'HISTORICAL'))
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"execution_request_id" uuid NOT NULL,
	"position_id" uuid,
	"mode" text DEFAULT 'PAPER' NOT NULL,
	"purpose" text NOT NULL,
	"exit_reason" text,
	"instrument" text NOT NULL,
	"exchange" text NOT NULL,
	"side" text NOT NULL,
	"order_type" text NOT NULL,
	"quantity" numeric NOT NULL,
	"limit_price" numeric,
	"filled_quantity" numeric DEFAULT '0' NOT NULL,
	"avg_fill_price" numeric,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"state_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_orders_status_check" CHECK ("paper_orders"."status" in ('PROPOSED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "paper_orders_mode_check" CHECK ("paper_orders"."mode" = 'PAPER'),
	CONSTRAINT "paper_orders_purpose_check" CHECK (("paper_orders"."purpose" = 'ENTRY' and "paper_orders"."exit_reason" is null) or ("paper_orders"."purpose" = 'EXIT' and "paper_orders"."exit_reason" is not null and "paper_orders"."position_id" is not null)),
	CONSTRAINT "paper_orders_side_check" CHECK ("paper_orders"."side" in ('BUY', 'SELL')),
	CONSTRAINT "paper_orders_type_check" CHECK (("paper_orders"."order_type" = 'MARKET' and "paper_orders"."limit_price" is null) or ("paper_orders"."order_type" = 'LIMIT' and "paper_orders"."limit_price" > 0)),
	CONSTRAINT "paper_orders_qty_check" CHECK ("paper_orders"."quantity" > 0 and "paper_orders"."filled_quantity" >= 0 and "paper_orders"."filled_quantity" <= "paper_orders"."quantity"),
	CONSTRAINT "paper_orders_fill_state_check" CHECK (("paper_orders"."status" <> 'FILLED' or "paper_orders"."filled_quantity" = "paper_orders"."quantity") and ("paper_orders"."status" <> 'PARTIALLY_FILLED' or ("paper_orders"."filled_quantity" > 0 and "paper_orders"."filled_quantity" < "paper_orders"."quantity")) and ("paper_orders"."status" not in ('PROPOSED', 'SUBMITTED', 'ACCEPTED') or "paper_orders"."filled_quantity" = 0))
);
--> statement-breakpoint
CREATE TABLE "paper_position_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_position_events_kind_check" CHECK ("paper_position_events"."kind" in ('OPENED', 'ENTRY_FILL', 'PARTIAL_EXIT', 'CLOSED', 'STOP_MOVED', 'TARGET_HIT', 'STOP_HIT', 'TIME_EXIT', 'EXPIRY_EXIT', 'RISK_BREACH', 'PRICE_UNAVAILABLE', 'RECONCILED', 'RECONCILIATION_MISMATCH'))
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"mode" text DEFAULT 'PAPER' NOT NULL,
	"instrument" text NOT NULL,
	"exchange" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"initial_quantity" numeric NOT NULL,
	"avg_entry_price" numeric NOT NULL,
	"initial_stop" numeric NOT NULL,
	"stop_loss" numeric NOT NULL,
	"targets" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"realized_costs" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"exit_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_positions_status_check" CHECK ("paper_positions"."status" in ('OPEN', 'CLOSED')),
	CONSTRAINT "paper_positions_mode_check" CHECK ("paper_positions"."mode" = 'PAPER'),
	CONSTRAINT "paper_positions_side_check" CHECK ("paper_positions"."side" in ('BUY', 'SELL')),
	CONSTRAINT "paper_positions_qty_check" CHECK ("paper_positions"."quantity" >= 0 and "paper_positions"."initial_quantity" > 0 and "paper_positions"."avg_entry_price" > 0 and "paper_positions"."stop_loss" > 0 and "paper_positions"."initial_stop" > 0),
	CONSTRAINT "paper_positions_closed_check" CHECK (("paper_positions"."status" = 'OPEN' and "paper_positions"."quantity" > 0 and "paper_positions"."closed_at" is null and "paper_positions"."exit_reason" is null) or ("paper_positions"."status" = 'CLOSED' and "paper_positions"."quantity" = 0 and "paper_positions"."closed_at" is not null and "paper_positions"."exit_reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_requests_id_user_unique" ON "execution_requests" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_orders_id_user_unique" ON "paper_orders" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_id_user_unique" ON "paper_positions" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" DROP CONSTRAINT "trade_monitoring_events_kind_check";--> statement-breakpoint
ALTER TABLE "trade_outcomes" DROP CONSTRAINT "trade_outcomes_source_check";--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD COLUMN "paper_position_id" uuid;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "stop_loss_validation" jsonb;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "permitted_size" jsonb;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "research_package_id" uuid;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "versions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD CONSTRAINT "decision_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD CONSTRAINT "decision_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD CONSTRAINT "decision_approvals_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_invalidations" ADD CONSTRAINT "decision_invalidations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_invalidations" ADD CONSTRAINT "decision_invalidations_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD CONSTRAINT "execution_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD CONSTRAINT "execution_requests_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD CONSTRAINT "execution_requests_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_order_fk" FOREIGN KEY ("order_id","user_id") REFERENCES "public"."paper_orders"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_request_fk" FOREIGN KEY ("execution_request_id","user_id") REFERENCES "public"."execution_requests"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_position_events" ADD CONSTRAINT "paper_position_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_position_events" ADD CONSTRAINT "paper_position_events_position_fk" FOREIGN KEY ("position_id","user_id") REFERENCES "public"."paper_positions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_approvals_decision_unique" ON "decision_approvals" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_approvals_key_unique" ON "decision_approvals" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "decision_approvals_user_idx" ON "decision_approvals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_approvals_id_user_unique" ON "decision_approvals" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_invalidations_decision_unique" ON "decision_invalidations" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_requests_decision_mode_unique" ON "execution_requests" USING btree ("decision_id","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_requests_key_unique" ON "execution_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "paper_fills_order_idx" ON "paper_fills" USING btree ("order_id","filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_orders_key_unique" ON "paper_orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "paper_orders_decision_idx" ON "paper_orders" USING btree ("decision_id","status");--> statement-breakpoint
CREATE INDEX "paper_position_events_position_idx" ON "paper_position_events" USING btree ("position_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_decision_unique" ON "paper_positions" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "paper_positions_open_idx" ON "paper_positions" USING btree ("status","user_id");--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_research_package_id_research_packages_id_fk" FOREIGN KEY ("research_package_id") REFERENCES "public"."research_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" ADD CONSTRAINT "trade_monitoring_events_kind_check" CHECK ("trade_monitoring_events"."kind" in ('ENTRY_FILLED', 'STOP_HIT', 'TARGET_HIT', 'TRAIL_MOVED', 'TIME_EXIT', 'RISK_BREACH', 'PARTIAL_EXIT', 'RECONCILIATION_MISMATCH', 'PRICE_UNAVAILABLE', 'STOP_MOVED', 'EXPIRY_EXIT', 'ORDER_REJECTED', 'ALERT'));--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_source_check" CHECK (("trade_outcomes"."mode" = 'PAPER' and (("trade_outcomes"."paper_trade_id" is not null) <> ("trade_outcomes"."paper_position_id" is not null)) and "trade_outcomes"."order_id" is null) or ("trade_outcomes"."mode" = 'LIVE' and "trade_outcomes"."order_id" is not null and "trade_outcomes"."paper_trade_id" is null and "trade_outcomes"."paper_position_id" is null));
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 07, ADR-016). Owner-tied reference from a PAPER trade outcome to the paper position it closes.
--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_paper_position_fk" FOREIGN KEY ("paper_position_id", "user_id") REFERENCES "paper_positions"("id", "user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- HAND-APPENDED. Append-only evidence: approvals, invalidations, fills and position events reject UPDATE / DELETE / TRUNCATE (twins_audit_forbid_change); the _no_update_delete suffix keeps the runtime role at SELECT + INSERT.
--> statement-breakpoint
CREATE TRIGGER "decision_approvals_no_update_delete" BEFORE UPDATE OR DELETE ON "decision_approvals" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "decision_approvals_no_truncate" BEFORE TRUNCATE ON "decision_approvals" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "decision_invalidations_no_update_delete" BEFORE UPDATE OR DELETE ON "decision_invalidations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "decision_invalidations_no_truncate" BEFORE TRUNCATE ON "decision_invalidations" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_fills_no_update_delete" BEFORE UPDATE OR DELETE ON "paper_fills" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_fills_no_truncate" BEFORE TRUNCATE ON "paper_fills" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_position_events_no_update_delete" BEFORE UPDATE OR DELETE ON "paper_position_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_position_events_no_truncate" BEFORE TRUNCATE ON "paper_position_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_orders_no_delete" BEFORE DELETE ON "paper_orders" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_orders_no_truncate" BEFORE TRUNCATE ON "paper_orders" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_positions_no_delete" BEFORE DELETE ON "paper_positions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "paper_positions_no_truncate" BEFORE TRUNCATE ON "paper_positions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "execution_requests_no_delete" BEFORE DELETE ON "execution_requests" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "execution_requests_no_truncate" BEFORE TRUNCATE ON "execution_requests" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Row-level security: every new table is owner-only (fail closed with no user bound; FORCE applies it to the table owner).
--> statement-breakpoint
ALTER TABLE "decision_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "decision_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "decision_approvals_owner_only" ON "decision_approvals" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_invalidations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "decision_invalidations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "decision_invalidations_owner_only" ON "decision_invalidations" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "execution_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "execution_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "execution_requests_owner_only" ON "execution_requests" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "paper_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "paper_orders_owner_only" ON "paper_orders" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "paper_fills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_fills" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "paper_fills_owner_only" ON "paper_fills" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "paper_positions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_positions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "paper_positions_owner_only" ON "paper_positions" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "paper_position_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_position_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "paper_position_events_owner_only" ON "paper_position_events" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
-- HAND-APPENDED. user_decisions guard v2 (replaces the 0033 function). A QUALIFIED decision can only be CREATED with: the full mandatory stop-loss validation recorded as VALID, a risk assessment of the same owner and candidate that is not BLOCKED, a research package, a permitted size of at least one lot, and a still-active candidate. APPROVED / REJECTED are reachable only with a recorded approval row (written by twins_record_decision_approval) that is inside the validity window and not invalidated. Every column except workflow_state is immutable.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "twins_user_decision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	ap record;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.workflow_state <> 'PENDING' THEN
			RAISE EXCEPTION 'a decision must start PENDING' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.outcome = 'QUALIFIED' THEN
			IF NOT EXISTS (SELECT 1 FROM opportunity_candidates c WHERE c.id = NEW.candidate_id AND c.stop_loss IS NOT NULL AND c.stop_loss > 0) THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs a candidate with a stop-loss' USING ERRCODE = 'check_violation';
			END IF;
			IF NOT EXISTS (SELECT 1 FROM opportunity_candidates c WHERE c.id = NEW.candidate_id AND c.state IN ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') AND c.expires_at > now()) THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs an active, unexpired candidate' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.stop_loss_validation IS NULL OR (NEW.stop_loss_validation->>'result') IS DISTINCT FROM 'VALID' OR (NEW.stop_loss_validation->>'ruleVersion') IS NULL THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs a VALID mandatory stop-loss validation' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.permitted_size IS NULL OR COALESCE((NEW.permitted_size->>'lots')::numeric, 0) < 1 THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs a permitted size of at least one lot' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.research_package_id IS NULL THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs its research package' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.risk_assessment_id IS NULL OR NOT EXISTS (SELECT 1 FROM risk_assessments r WHERE r.id = NEW.risk_assessment_id AND r.user_id = NEW.user_id AND r.candidate_id = NEW.candidate_id AND r.verdict <> 'BLOCKED') THEN
				RAISE EXCEPTION 'a QUALIFIED decision needs a risk assessment of this owner and candidate that is not BLOCKED' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.candidate_id <> OLD.candidate_id
	   OR NEW.outcome <> OLD.outcome OR NEW.explanation IS DISTINCT FROM OLD.explanation
	   OR NEW.valid_from <> OLD.valid_from OR NEW.valid_until <> OLD.valid_until OR NEW.created_at <> OLD.created_at
	   OR NEW.confidence_assessment_id IS DISTINCT FROM OLD.confidence_assessment_id OR NEW.risk_assessment_id IS DISTINCT FROM OLD.risk_assessment_id
	   OR NEW.simulation_id IS DISTINCT FROM OLD.simulation_id OR NEW.risk_decision_id IS DISTINCT FROM OLD.risk_decision_id
	   OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.stop_loss_validation IS DISTINCT FROM OLD.stop_loss_validation
	   OR NEW.permitted_size IS DISTINCT FROM OLD.permitted_size OR NEW.research_package_id IS DISTINCT FROM OLD.research_package_id
	   OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs OR NEW.versions IS DISTINCT FROM OLD.versions THEN
		RAISE EXCEPTION 'only workflow_state of a decision may change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.workflow_state <> OLD.workflow_state AND OLD.workflow_state <> 'PENDING' THEN
		RAISE EXCEPTION 'a decision in a final state cannot change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.workflow_state <> OLD.workflow_state AND NEW.workflow_state IN ('APPROVED', 'REJECTED') THEN
		SELECT * INTO ap FROM decision_approvals a WHERE a.decision_id = NEW.id AND a.user_id = NEW.user_id;
		IF NOT FOUND OR ap.action <> (CASE WHEN NEW.workflow_state = 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END) THEN
			RAISE EXCEPTION 'a decision reaches % only through a recorded approval action', NEW.workflow_state USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.workflow_state = 'APPROVED' AND (now() > NEW.valid_until OR EXISTS (SELECT 1 FROM decision_invalidations i WHERE i.decision_id = NEW.id)) THEN
			RAISE EXCEPTION 'an expired or invalidated decision cannot be approved' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- HAND-APPENDED. The doors. The runtime role keeps SELECT only on user_decisions / user_decision_events (app-role.sql); decisions are created, ended and approved ONLY through these SECURITY DEFINER functions. Each one acts only for the user bound to the transaction (twins.user_id), so a function cannot be used on another user's decision.
--> statement-breakpoint
CREATE FUNCTION "twins_create_user_decision"(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
	did uuid := gen_random_uuid();
	old record;
BEGIN
	IF uid IS NULL OR (p->>'user_id')::uuid IS DISTINCT FROM uid THEN
		RAISE EXCEPTION 'twins_create_user_decision: the decision must be for the user bound to this transaction' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF (p->>'supersedes_id') IS NOT NULL THEN
		SELECT * INTO old FROM user_decisions d WHERE d.id = (p->>'supersedes_id')::uuid AND d.user_id = uid FOR UPDATE;
		IF NOT FOUND OR old.workflow_state <> 'PENDING' OR old.candidate_id <> (p->>'candidate_id')::uuid OR old.account_id <> (p->>'account_id')::uuid THEN
			RAISE EXCEPTION 'twins_create_user_decision: only a PENDING decision of the same candidate and account can be superseded' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	INSERT INTO user_decisions (id, user_id, account_id, candidate_id, outcome, workflow_state, confidence_assessment_id, risk_assessment_id, simulation_id, explanation, stop_loss_validation, permitted_size, research_package_id, evidence_refs, versions, valid_from, valid_until, supersedes_id)
	VALUES (did, uid, (p->>'account_id')::uuid, (p->>'candidate_id')::uuid, p->>'outcome', 'PENDING', (p->>'confidence_assessment_id')::uuid, (p->>'risk_assessment_id')::uuid, (p->>'simulation_id')::uuid, p->'explanation', p->'stop_loss_validation', p->'permitted_size', (p->>'research_package_id')::uuid, COALESCE(p->'evidence_refs', '[]'::jsonb), COALESCE(p->'versions', '{}'::jsonb), now(), (p->>'valid_until')::timestamptz, (p->>'supersedes_id')::uuid);
	INSERT INTO user_decision_events (id, user_id, decision_id, from_state, to_state, actor, reason) VALUES (gen_random_uuid(), uid, did, NULL, 'PENDING', COALESCE(p->>'actor', 'decision-engine'), p->>'reason');
	IF (p->>'supersedes_id') IS NOT NULL THEN
		UPDATE user_decisions SET workflow_state = 'SUPERSEDED', updated_at = now() WHERE id = old.id;
		INSERT INTO user_decision_events (id, user_id, decision_id, from_state, to_state, actor, reason) VALUES (gen_random_uuid(), uid, old.id, 'PENDING', 'SUPERSEDED', COALESCE(p->>'actor', 'decision-engine'), 'superseded by ' || did::text);
	END IF;
	RETURN did;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "twins_end_user_decision"(p_decision uuid, p_to text, p_actor text, p_reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
	d record;
BEGIN
	IF uid IS NULL THEN RAISE EXCEPTION 'twins_end_user_decision: no user bound to this transaction' USING ERRCODE = 'insufficient_privilege'; END IF;
	IF p_to NOT IN ('EXPIRED', 'SUPERSEDED', 'CANCELLED') THEN RAISE EXCEPTION 'twins_end_user_decision: only EXPIRED, SUPERSEDED or CANCELLED' USING ERRCODE = 'check_violation'; END IF;
	IF p_reason IS NULL OR length(p_reason) < 5 THEN RAISE EXCEPTION 'twins_end_user_decision: a reason is required' USING ERRCODE = 'check_violation'; END IF;
	SELECT * INTO d FROM user_decisions WHERE id = p_decision AND user_id = uid FOR UPDATE;
	IF NOT FOUND OR d.workflow_state <> 'PENDING' THEN RETURN false; END IF;
	UPDATE user_decisions SET workflow_state = p_to, updated_at = now() WHERE id = p_decision;
	INSERT INTO user_decision_events (id, user_id, decision_id, from_state, to_state, actor, reason) VALUES (gen_random_uuid(), uid, p_decision, 'PENDING', p_to, p_actor, p_reason);
	RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "twins_invalidate_decision"(p_decision uuid, p_code text, p_detail jsonb, p_actor text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
	d record;
BEGIN
	IF uid IS NULL THEN RAISE EXCEPTION 'twins_invalidate_decision: no user bound to this transaction' USING ERRCODE = 'insufficient_privilege'; END IF;
	SELECT * INTO d FROM user_decisions WHERE id = p_decision AND user_id = uid FOR UPDATE;
	IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
	IF d.workflow_state = 'PENDING' THEN
		UPDATE user_decisions SET workflow_state = 'CANCELLED', updated_at = now() WHERE id = p_decision;
		INSERT INTO user_decision_events (id, user_id, decision_id, from_state, to_state, actor, reason) VALUES (gen_random_uuid(), uid, p_decision, 'PENDING', 'CANCELLED', p_actor, 'invalidated: ' || p_code);
		RETURN 'CANCELLED';
	ELSIF d.workflow_state = 'APPROVED' THEN
		INSERT INTO decision_invalidations (id, user_id, decision_id, reason_code, detail) VALUES (gen_random_uuid(), uid, p_decision, p_code, COALESCE(p_detail, '{}'::jsonb)) ON CONFLICT (decision_id) DO NOTHING;
		RETURN 'INVALIDATED';
	END IF;
	RETURN 'UNCHANGED';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "twins_record_decision_approval"(p_decision uuid, p_action text, p_revalidation jsonb, p_key text, p_reason text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	uid uuid := nullif(current_setting('twins.user_id', true), '')::uuid;
	d record;
	ex record;
BEGIN
	IF uid IS NULL THEN RAISE EXCEPTION 'twins_record_decision_approval: no user bound to this transaction' USING ERRCODE = 'insufficient_privilege'; END IF;
	IF p_action NOT IN ('APPROVE', 'REJECT') THEN RAISE EXCEPTION 'twins_record_decision_approval: action must be APPROVE or REJECT' USING ERRCODE = 'check_violation'; END IF;
	IF p_key IS NULL OR length(p_key) < 8 THEN RAISE EXCEPTION 'twins_record_decision_approval: an idempotency key is required' USING ERRCODE = 'check_violation'; END IF;
	SELECT * INTO d FROM user_decisions WHERE id = p_decision AND user_id = uid FOR UPDATE;
	IF NOT FOUND THEN RAISE EXCEPTION 'twins_record_decision_approval: decision not found for this user' USING ERRCODE = 'no_data_found'; END IF;
	SELECT * INTO ex FROM decision_approvals WHERE decision_id = p_decision;
	IF FOUND THEN
		IF ex.idempotency_key = p_key AND ex.action = p_action THEN RETURN ex.action; END IF; -- an exact retry is a no-op
		RAISE EXCEPTION 'twins_record_decision_approval: this decision has already been actioned' USING ERRCODE = 'unique_violation';
	END IF;
	IF d.workflow_state <> 'PENDING' THEN RAISE EXCEPTION 'twins_record_decision_approval: the decision is %, not PENDING', d.workflow_state USING ERRCODE = 'check_violation'; END IF;
	IF d.outcome <> 'QUALIFIED' THEN RAISE EXCEPTION 'twins_record_decision_approval: only a QUALIFIED decision enters approval' USING ERRCODE = 'check_violation'; END IF;
	IF now() > d.valid_until THEN RAISE EXCEPTION 'twins_record_decision_approval: the decision has expired' USING ERRCODE = 'check_violation'; END IF;
	IF NOT EXISTS (SELECT 1 FROM user_execution_permissions x WHERE x.account_id = d.account_id AND x.user_id = uid AND x.mode = 'PAPER' AND x.enabled) THEN
		RAISE EXCEPTION 'twins_record_decision_approval: the user has not enabled PAPER execution for this account' USING ERRCODE = 'insufficient_privilege';
	END IF;
	INSERT INTO decision_approvals (id, user_id, decision_id, action, approver_user_id, permission_mode, revalidation, idempotency_key, reason) VALUES (gen_random_uuid(), uid, p_decision, p_action, uid, 'PAPER', p_revalidation, p_key, p_reason);
	UPDATE user_decisions SET workflow_state = CASE WHEN p_action = 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END, updated_at = now() WHERE id = p_decision;
	INSERT INTO user_decision_events (id, user_id, decision_id, from_state, to_state, actor, reason) VALUES (gen_random_uuid(), uid, p_decision, 'PENDING', CASE WHEN p_action = 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END, 'user:' || uid::text, p_reason);
	RETURN p_action;
END;
$$;
--> statement-breakpoint
-- HAND-APPENDED. Execution request guard: starts REQUESTED (or REJECTED); a live mode can only be REJECTED; only legal transitions; identity is immutable.
--> statement-breakpoint
CREATE FUNCTION "twins_execution_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.state NOT IN ('REQUESTED', 'REJECTED') THEN RAISE EXCEPTION 'an execution request starts REQUESTED or REJECTED' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.decision_id <> OLD.decision_id OR NEW.mode <> OLD.mode OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'the identity of an execution request cannot change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state = OLD.state THEN RETURN NEW; END IF;
	IF NOT ((OLD.state = 'REQUESTED' AND NEW.state IN ('ELIGIBLE', 'REJECTED')) OR (OLD.state = 'ELIGIBLE' AND NEW.state IN ('COMPLETED', 'FAILED'))) THEN
		RAISE EXCEPTION 'illegal execution request transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_requests_guard" BEFORE INSERT OR UPDATE ON "execution_requests" FOR EACH ROW EXECUTE FUNCTION "twins_execution_request_guard"();
--> statement-breakpoint
-- HAND-APPENDED. Paper order guard. An ENTRY order needs an ELIGIBLE execution request of the same owner / account / decision, an APPROVED QUALIFIED decision that is inside its window and not invalidated, and a total entry quantity within the permitted size. An EXIT order needs an open position on the opposite side and never more than is open (exits stay possible after a decision expires). Status moves only along the legal order lifecycle, fills only grow, identity is immutable.
--> statement-breakpoint
CREATE FUNCTION "twins_paper_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	d record;
	r record;
	pos record;
	already numeric;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'PROPOSED' OR NEW.filled_quantity <> 0 THEN RAISE EXCEPTION 'a paper order starts PROPOSED and unfilled' USING ERRCODE = 'check_violation'; END IF;
		SELECT * INTO r FROM execution_requests e WHERE e.id = NEW.execution_request_id AND e.user_id = NEW.user_id;
		IF NOT FOUND OR r.mode <> 'PAPER' OR r.decision_id <> NEW.decision_id OR r.account_id <> NEW.account_id OR NOT ((NEW.purpose = 'ENTRY' AND r.state = 'ELIGIBLE') OR (NEW.purpose = 'EXIT' AND r.state IN ('ELIGIBLE', 'COMPLETED'))) THEN
			RAISE EXCEPTION 'a paper order needs a PAPER execution request for the same decision and account (ELIGIBLE for an entry; ELIGIBLE or COMPLETED for an exit)' USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO d FROM user_decisions u WHERE u.id = NEW.decision_id AND u.user_id = NEW.user_id;
		IF NOT FOUND OR d.workflow_state <> 'APPROVED' OR d.outcome <> 'QUALIFIED' THEN RAISE EXCEPTION 'a paper order needs an APPROVED QUALIFIED decision' USING ERRCODE = 'check_violation'; END IF;
		IF NEW.purpose = 'ENTRY' THEN
			IF now() > d.valid_until THEN RAISE EXCEPTION 'the decision has expired: no new entry' USING ERRCODE = 'check_violation'; END IF;
			IF EXISTS (SELECT 1 FROM decision_invalidations i WHERE i.decision_id = NEW.decision_id) THEN RAISE EXCEPTION 'the decision was invalidated: no new entry' USING ERRCODE = 'check_violation'; END IF;
			SELECT COALESCE(sum(quantity), 0) INTO already FROM paper_orders o WHERE o.decision_id = NEW.decision_id AND o.purpose = 'ENTRY' AND o.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED');
			IF already + NEW.quantity > COALESCE((d.permitted_size->>'quantity')::numeric, 0) THEN RAISE EXCEPTION 'the entry quantity exceeds the size the decision permits' USING ERRCODE = 'check_violation'; END IF;
			IF NEW.side <> (SELECT c.side FROM opportunity_candidates c WHERE c.id = d.candidate_id) THEN RAISE EXCEPTION 'the entry side differs from the decision candidate' USING ERRCODE = 'check_violation'; END IF;
		ELSE
			SELECT * INTO pos FROM paper_positions p WHERE p.id = NEW.position_id AND p.user_id = NEW.user_id;
			IF NOT FOUND OR pos.status <> 'OPEN' OR pos.decision_id <> NEW.decision_id OR NEW.side = pos.side OR NEW.quantity > pos.quantity THEN
				RAISE EXCEPTION 'an exit order needs an open position, the opposite side and no more than the open quantity' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.decision_id <> OLD.decision_id OR NEW.execution_request_id <> OLD.execution_request_id
	   OR NEW.position_id IS DISTINCT FROM OLD.position_id OR NEW.mode <> OLD.mode OR NEW.purpose <> OLD.purpose OR NEW.exit_reason IS DISTINCT FROM OLD.exit_reason OR NEW.instrument <> OLD.instrument
	   OR NEW.exchange <> OLD.exchange OR NEW.side <> OLD.side OR NEW.order_type <> OLD.order_type OR NEW.quantity <> OLD.quantity OR NEW.limit_price IS DISTINCT FROM OLD.limit_price
	   OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'the definition of a paper order cannot change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.filled_quantity < OLD.filled_quantity THEN RAISE EXCEPTION 'filled quantity cannot decrease' USING ERRCODE = 'check_violation'; END IF;
	IF NEW.status <> OLD.status THEN
		IF OLD.status IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN RAISE EXCEPTION 'a % paper order cannot change state', OLD.status USING ERRCODE = 'check_violation'; END IF;
		IF NOT ((OLD.status = 'PROPOSED' AND NEW.status IN ('SUBMITTED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
		     OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
		     OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
		     OR (OLD.status = 'PARTIALLY_FILLED' AND NEW.status IN ('FILLED', 'CANCELLED', 'EXPIRED'))) THEN
			RAISE EXCEPTION 'illegal paper order transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
		END IF;
	ELSIF OLD.status IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN
		RAISE EXCEPTION 'a % paper order cannot change', OLD.status USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "paper_orders_guard" BEFORE INSERT OR UPDATE ON "paper_orders" FOR EACH ROW EXECUTE FUNCTION "twins_paper_order_guard"();
--> statement-breakpoint
-- HAND-APPENDED. A fill can only be applied to an ACCEPTED or PARTIALLY_FILLED order and never beyond its remaining quantity; an AFTER trigger then updates the order's filled quantity, average price and status in the same statement, so the order state is always derived from its fills.
--> statement-breakpoint
CREATE FUNCTION "twins_paper_fill_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	o record;
BEGIN
	SELECT * INTO o FROM paper_orders WHERE id = NEW.order_id AND user_id = NEW.user_id FOR UPDATE;
	IF NOT FOUND OR o.status NOT IN ('ACCEPTED', 'PARTIALLY_FILLED') THEN RAISE EXCEPTION 'a fill needs an ACCEPTED or PARTIALLY_FILLED paper order' USING ERRCODE = 'check_violation'; END IF;
	IF NEW.quantity > o.quantity - o.filled_quantity THEN RAISE EXCEPTION 'a fill cannot exceed the remaining order quantity' USING ERRCODE = 'check_violation'; END IF;
	IF o.order_type = 'LIMIT' AND ((o.side = 'BUY' AND NEW.price > o.limit_price) OR (o.side = 'SELL' AND NEW.price < o.limit_price)) THEN RAISE EXCEPTION 'a fill cannot be worse than the limit price' USING ERRCODE = 'check_violation'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "paper_fills_guard" BEFORE INSERT ON "paper_fills" FOR EACH ROW EXECUTE FUNCTION "twins_paper_fill_guard"();
--> statement-breakpoint
CREATE FUNCTION "twins_paper_fill_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	o record;
	nf numeric;
BEGIN
	SELECT * INTO o FROM paper_orders WHERE id = NEW.order_id AND user_id = NEW.user_id;
	nf := o.filled_quantity + NEW.quantity;
	UPDATE paper_orders SET filled_quantity = nf,
		avg_fill_price = (COALESCE(o.avg_fill_price, 0) * o.filled_quantity + NEW.price * NEW.quantity) / nf,
		status = CASE WHEN nf = o.quantity THEN 'FILLED' ELSE 'PARTIALLY_FILLED' END, updated_at = now()
	WHERE id = NEW.order_id;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "paper_fills_apply" AFTER INSERT ON "paper_fills" FOR EACH ROW EXECUTE FUNCTION "twins_paper_fill_apply"();
--> statement-breakpoint
-- HAND-APPENDED. Paper position guard: it can only be created for an APPROVED decision whose entry order has a fill; the initial stop, side, instrument and initial quantity never change; the stop can only TIGHTEN (up for a long, down for a short); a closed position is final; open quantity never grows beyond what was ever filled on entry.
--> statement-breakpoint
CREATE FUNCTION "twins_paper_position_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	filled numeric;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT COALESCE(sum(filled_quantity), 0) INTO filled FROM paper_orders o WHERE o.decision_id = NEW.decision_id AND o.user_id = NEW.user_id AND o.purpose = 'ENTRY';
		IF filled <= 0 THEN RAISE EXCEPTION 'a position needs a filled entry order' USING ERRCODE = 'check_violation'; END IF;
		IF NOT EXISTS (SELECT 1 FROM user_decisions d WHERE d.id = NEW.decision_id AND d.user_id = NEW.user_id AND d.workflow_state = 'APPROVED') THEN RAISE EXCEPTION 'a position needs an APPROVED decision' USING ERRCODE = 'check_violation'; END IF;
		IF NEW.stop_loss <> NEW.initial_stop OR NEW.status <> 'OPEN' THEN RAISE EXCEPTION 'a position opens OPEN at its initial stop' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.decision_id <> OLD.decision_id OR NEW.mode <> OLD.mode OR NEW.instrument <> OLD.instrument OR NEW.exchange <> OLD.exchange
	   OR NEW.side <> OLD.side OR NEW.initial_quantity <> OLD.initial_quantity OR NEW.initial_stop <> OLD.initial_stop OR NEW.targets IS DISTINCT FROM OLD.targets OR NEW.rules IS DISTINCT FROM OLD.rules OR NEW.opened_at <> OLD.opened_at THEN
		RAISE EXCEPTION 'the definition of a position cannot change' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'a closed position cannot change' USING ERRCODE = 'check_violation'; END IF;
	IF (OLD.side = 'BUY' AND NEW.stop_loss < OLD.stop_loss) OR (OLD.side = 'SELL' AND NEW.stop_loss > OLD.stop_loss) THEN RAISE EXCEPTION 'a stop-loss can only be tightened' USING ERRCODE = 'check_violation'; END IF;
	IF NEW.quantity > NEW.initial_quantity THEN RAISE EXCEPTION 'open quantity cannot exceed the initial quantity' USING ERRCODE = 'check_violation'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "paper_positions_guard" BEFORE INSERT OR UPDATE ON "paper_positions" FOR EACH ROW EXECUTE FUNCTION "twins_paper_position_guard"();
