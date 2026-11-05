CREATE TABLE "paper_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"r_multiple" numeric NOT NULL,
	"pnl" numeric NOT NULL,
	"close_reason" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_outcomes_outcome_check" CHECK ("paper_outcomes"."outcome" in ('WIN', 'LOSS', 'BREAKEVEN'))
);
--> statement-breakpoint
CREATE TABLE "paper_trade_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"price" numeric,
	"quantity" numeric,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_trade_events_type_check" CHECK ("paper_trade_events"."type" in ('CREATED', 'ENTRY_FILLED', 'STOP_MOVED', 'TARGET_HIT', 'STOPPED_OUT', 'SQUARED_OFF', 'CLOSED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"risk_decision_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"state" text NOT NULL,
	"trade" jsonb NOT NULL,
	"last_price" numeric,
	"last_price_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_trades_value_check" CHECK ("paper_trades"."side" in ('BUY', 'SELL') and "paper_trades"."state" in ('PENDING_ENTRY', 'OPEN', 'CLOSED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "paper_outcomes" ADD CONSTRAINT "paper_outcomes_trade_id_paper_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."paper_trades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_trade_events" ADD CONSTRAINT "paper_trade_events_trade_id_paper_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."paper_trades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_outcomes_trade_unique" ON "paper_outcomes" USING btree ("trade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_trade_events_seq_unique" ON "paper_trade_events" USING btree ("trade_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_trades_decision_unique" ON "paper_trades" USING btree ("risk_decision_id");--> statement-breakpoint
CREATE INDEX "paper_trades_state_idx" ON "paper_trades" USING btree ("state");--> statement-breakpoint
-- HAND-APPENDED: paper trading history is append-only (the shared trigger function), and a finished paper trade can never be changed or deleted.
CREATE TRIGGER "paper_trade_events_no_update_delete" BEFORE UPDATE OR DELETE ON "paper_trade_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "paper_outcomes_no_update_delete" BEFORE UPDATE OR DELETE ON "paper_outcomes" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE FUNCTION "twins_paper_trade_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'paper_trades rows are never deleted' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.state IN ('CLOSED', 'CANCELLED') THEN
		RAISE EXCEPTION 'a finished paper trade cannot be changed' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.id <> OLD.id OR NEW.risk_decision_id <> OLD.risk_decision_id OR NEW.symbol <> OLD.symbol OR NEW.side <> OLD.side THEN
		RAISE EXCEPTION 'the identity of a paper trade cannot be changed' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "paper_trades_guard" BEFORE UPDATE OR DELETE ON "paper_trades" FOR EACH ROW EXECUTE FUNCTION "twins_paper_trade_guard"();
