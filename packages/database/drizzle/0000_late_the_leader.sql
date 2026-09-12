CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."backtest_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."data_quality_status" AS ENUM('ok', 'stale', 'incomplete', 'conflicting', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('BUY', 'SELL', 'WAIT', 'REJECT');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('market_observation', 'macro_observation', 'news_evidence');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'submitted', 'partially_filled', 'filled', 'cancelled', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."provider_health_status" AS ENUM('healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('market', 'broker', 'news', 'macro', 'telegram', 'ai');--> statement-breakpoint
CREATE TYPE "public"."signal_direction" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('pending', 'analyzed', 'decided', 'expired', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."source_tier" AS ENUM('A', 'B', 'C', 'D', 'E');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('paper', 'shadow', 'live');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"status" "provider_health_status" DEFAULT 'down' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trading_mode" "trading_mode" NOT NULL,
	"broker_connection_id" uuid,
	"base_currency" text DEFAULT 'INR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"exchange" text NOT NULL,
	"instrument_type" text NOT NULL,
	"name" text,
	"isin" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"lot_size" numeric,
	"tick_size" numeric,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source" text NOT NULL,
	"timeframe" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open" numeric,
	"high" numeric,
	"low" numeric,
	"close" numeric,
	"volume" numeric,
	"open_interest" numeric,
	"data_quality_status" "data_quality_status" DEFAULT 'ok' NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "macro_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"region" text NOT NULL,
	"series_code" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" numeric NOT NULL,
	"unit" text,
	"data_quality_status" "data_quality_status" DEFAULT 'ok' NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_event_instruments" (
	"news_event_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	CONSTRAINT "news_event_instruments_news_event_id_instrument_id_pk" PRIMARY KEY("news_event_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "news_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"event_time" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relevance_score" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"news_source_id" uuid NOT NULL,
	"news_event_id" uuid,
	"source_url" text NOT NULL,
	"headline" text NOT NULL,
	"body_excerpt" text,
	"source_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_hash" text NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tier" "source_tier" NOT NULL,
	"homepage_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"telegram_source_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"message_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_text" text NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_identifier" text NOT NULL,
	"display_name" text,
	"trust_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"evidence_kind" "evidence_kind" NOT NULL,
	"market_observation_id" uuid,
	"macro_observation_id" uuid,
	"news_evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_evidence_exactly_one_reference" CHECK ((
        (case when "signal_evidence"."market_observation_id" is not null then 1 else 0 end) +
        (case when "signal_evidence"."macro_observation_id" is not null then 1 else 0 end) +
        (case when "signal_evidence"."news_evidence_id" is not null then 1 else 0 end)
      ) = 1),
	CONSTRAINT "signal_evidence_kind_matches_reference" CHECK ((
        ("signal_evidence"."evidence_kind" = 'market_observation' and "signal_evidence"."market_observation_id" is not null) or
        ("signal_evidence"."evidence_kind" = 'macro_observation' and "signal_evidence"."macro_observation_id" is not null) or
        ("signal_evidence"."evidence_kind" = 'news_evidence' and "signal_evidence"."news_evidence_id" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"telegram_message_id" uuid,
	"instrument_id" uuid NOT NULL,
	"direction" "signal_direction" NOT NULL,
	"entry_price" numeric,
	"stop_loss" numeric,
	"targets" jsonb,
	"timeframe" text,
	"extracted_confidence" numeric,
	"status" "signal_status" DEFAULT 'pending' NOT NULL,
	"signal_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"ai_provider" text NOT NULL,
	"ai_model" text NOT NULL,
	"bull_thesis" text,
	"bear_thesis" text,
	"supporting_evidence_ids" jsonb,
	"contradicting_evidence_ids" jsonb,
	"market_regime" text,
	"macro_context" text,
	"risk_context" text,
	"confidence" numeric,
	"confidence_label" text,
	"raw_ai_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"analysis_id" uuid,
	"outcome" "decision_outcome" NOT NULL,
	"rationale" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"decision_id" uuid NOT NULL,
	"approved" boolean NOT NULL,
	"reasons" jsonb,
	"max_position_size" numeric,
	"risk_per_trade" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"broker_fill_id" text,
	"fill_price" numeric NOT NULL,
	"fill_quantity" numeric NOT NULL,
	"fill_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"risk_decision_id" uuid,
	"trading_mode" "trading_mode" NOT NULL,
	"side" "order_side" NOT NULL,
	"order_type" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"broker_order_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"equity" numeric NOT NULL,
	"cash" numeric,
	"positions_value" numeric,
	"realized_pnl" numeric,
	"unrealized_pnl" numeric,
	"drawdown" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"trading_mode" "trading_mode" NOT NULL,
	"quantity" numeric DEFAULT '0' NOT NULL,
	"average_price" numeric,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"queue_name" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_name" text NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"status" "provider_health_status" NOT NULL,
	"latency_ms" numeric,
	"error_rate" numeric,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_message" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backtest_id" uuid NOT NULL,
	"metric_set" jsonb NOT NULL,
	"equity_curve" jsonb,
	"trades_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"strategy_config" jsonb NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"status" "backtest_status" DEFAULT 'queued' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_broker_connection_id_broker_connections_id_fk" FOREIGN KEY ("broker_connection_id") REFERENCES "public"."broker_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_observations" ADD CONSTRAINT "market_observations_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_event_instruments" ADD CONSTRAINT "news_event_instruments_news_event_id_news_events_id_fk" FOREIGN KEY ("news_event_id") REFERENCES "public"."news_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_event_instruments" ADD CONSTRAINT "news_event_instruments_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_evidence" ADD CONSTRAINT "news_evidence_news_source_id_news_sources_id_fk" FOREIGN KEY ("news_source_id") REFERENCES "public"."news_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_evidence" ADD CONSTRAINT "news_evidence_news_event_id_news_events_id_fk" FOREIGN KEY ("news_event_id") REFERENCES "public"."news_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_telegram_source_id_telegram_sources_id_fk" FOREIGN KEY ("telegram_source_id") REFERENCES "public"."telegram_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_market_observation_id_market_observations_id_fk" FOREIGN KEY ("market_observation_id") REFERENCES "public"."market_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_macro_observation_id_macro_observations_id_fk" FOREIGN KEY ("macro_observation_id") REFERENCES "public"."macro_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_news_evidence_id_news_evidence_id_fk" FOREIGN KEY ("news_evidence_id") REFERENCES "public"."news_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_backtest_id_backtests_id_fk" FOREIGN KEY ("backtest_id") REFERENCES "public"."backtests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_exchange_symbol_unique" ON "instruments" USING btree ("exchange","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "market_observations_dedupe_unique" ON "market_observations" USING btree ("instrument_id","source","timeframe","observed_at");--> statement-breakpoint
CREATE INDEX "market_observations_instrument_observed_idx" ON "market_observations" USING btree ("instrument_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "macro_observations_dedupe_unique" ON "macro_observations" USING btree ("source","series_code","observed_at");--> statement-breakpoint
CREATE INDEX "macro_observations_region_series_idx" ON "macro_observations" USING btree ("region","series_code");--> statement-breakpoint
CREATE UNIQUE INDEX "news_evidence_source_dedupe_unique" ON "news_evidence" USING btree ("news_source_id","dedupe_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "news_sources_name_unique" ON "news_sources" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_source_external_id_unique" ON "telegram_messages" USING btree ("telegram_source_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_sources_channel_unique" ON "telegram_sources" USING btree ("channel_identifier");--> statement-breakpoint
CREATE INDEX "signal_evidence_signal_idx" ON "signal_evidence" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signals_instrument_status_idx" ON "signals" USING btree ("instrument_id","status");--> statement-breakpoint
CREATE INDEX "signals_telegram_message_idx" ON "signals" USING btree ("telegram_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_order_broker_fill_unique" ON "fills" USING btree ("order_id","broker_fill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_unique" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_account_status_idx" ON "orders" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_snapshots_account_time_unique" ON "portfolio_snapshots" USING btree ("account_id","snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_account_instrument_mode_unique" ON "positions" USING btree ("account_id","instrument_id","trading_mode");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_queue_status_idx" ON "jobs" USING btree ("queue_name","status");--> statement-breakpoint
CREATE INDEX "provider_health_provider_idx" ON "provider_health" USING btree ("provider_name","checked_at");