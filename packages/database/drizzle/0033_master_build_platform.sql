CREATE TABLE "user_capital_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"total_capital" numeric NOT NULL,
	"available_capital" numeric NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_capital_profiles_version_check" CHECK ("user_capital_profiles"."version" >= 1),
	CONSTRAINT "user_capital_profiles_amounts_check" CHECK ("user_capital_profiles"."total_capital" >= 0 and "user_capital_profiles"."available_capital" >= 0 and "user_capital_profiles"."available_capital" <= "user_capital_profiles"."total_capital")
);
--> statement-breakpoint
CREATE TABLE "user_execution_permissions" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_execution_permissions_account_id_mode_pk" PRIMARY KEY("account_id","mode"),
	CONSTRAINT "user_execution_permissions_mode_check" CHECK ("user_execution_permissions"."mode" in ('PAPER', 'ASSISTED_LIVE', 'CONTROLLED_AUTO')),
	CONSTRAINT "user_execution_permissions_live_disabled_check" CHECK ("user_execution_permissions"."mode" = 'PAPER' or "user_execution_permissions"."enabled" = false)
);
--> statement-breakpoint
CREATE TABLE "user_risk_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"risk_percent" numeric NOT NULL,
	"max_risk_per_trade" numeric,
	"max_daily_loss" numeric NOT NULL,
	"max_concurrent_positions" integer NOT NULL,
	"max_lots" integer NOT NULL,
	"min_reward_to_risk" numeric NOT NULL,
	"allowed_underlyings" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_risk_policies_version_check" CHECK ("user_risk_policies"."version" >= 1),
	CONSTRAINT "user_risk_policies_risk_check" CHECK ("user_risk_policies"."risk_percent" > 0 and "user_risk_policies"."risk_percent" <= 5),
	CONSTRAINT "user_risk_policies_limits_check" CHECK ("user_risk_policies"."max_daily_loss" > 0 and "user_risk_policies"."max_concurrent_positions" >= 1 and "user_risk_policies"."max_lots" >= 1 and "user_risk_policies"."min_reward_to_risk" > 0 and ("user_risk_policies"."max_risk_per_trade" is null or "user_risk_policies"."max_risk_per_trade" > 0))
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "user_sessions_lifetime_check" CHECK ("user_sessions"."expires_at" > "user_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"underlying" text NOT NULL,
	"timeframe" text NOT NULL,
	"direction" text NOT NULL,
	"regime" text NOT NULL,
	"volatility_regime" text DEFAULT 'UNKNOWN' NOT NULL,
	"implied_volatility" numeric,
	"event_risk" text DEFAULT 'UNKNOWN' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detector_version" text NOT NULL,
	"data_source" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_regimes_timeframe_check" CHECK ("market_regimes"."timeframe" in ('5m', '15m', '1h', '1d')),
	CONSTRAINT "market_regimes_direction_check" CHECK ("market_regimes"."direction" in ('BULLISH', 'BEARISH', 'NEUTRAL', 'UNKNOWN')),
	CONSTRAINT "market_regimes_regime_check" CHECK ("market_regimes"."regime" in ('TRENDING_UP', 'TRENDING_DOWN', 'RANGE_BOUND', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'RISK_OFF', 'UNKNOWN')),
	CONSTRAINT "market_regimes_vol_check" CHECK ("market_regimes"."volatility_regime" in ('LOW', 'NORMAL', 'HIGH', 'EXTREME', 'UNKNOWN')),
	CONSTRAINT "market_regimes_event_check" CHECK ("market_regimes"."event_risk" in ('NONE', 'LOW', 'ELEVATED', 'HIGH', 'UNKNOWN')),
	CONSTRAINT "market_regimes_source_check" CHECK ("market_regimes"."data_source" in ('FIXTURE', 'LIVE', 'HISTORICAL'))
);
--> statement-breakpoint
CREATE TABLE "opportunity_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'NEW' NOT NULL,
	"claim_id" uuid,
	"scan_id" uuid,
	"underlying" text NOT NULL,
	"exchange" text DEFAULT 'NSE' NOT NULL,
	"strike" numeric,
	"option_type" text,
	"expiry" date,
	"side" text NOT NULL,
	"entry_kind" text NOT NULL,
	"entry_low" numeric,
	"entry_high" numeric,
	"stop_loss" numeric,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup" text,
	"classification_confidence" numeric,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_source" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_candidates_source_check" CHECK ("opportunity_candidates"."source" in ('TELEGRAM', 'INDEPENDENT')),
	CONSTRAINT "opportunity_candidates_state_check" CHECK ("opportunity_candidates"."state" in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION', 'EXPIRED', 'WITHDRAWN')),
	CONSTRAINT "opportunity_candidates_origin_check" CHECK (("opportunity_candidates"."source" = 'TELEGRAM' and "opportunity_candidates"."claim_id" is not null and "opportunity_candidates"."scan_id" is null) or ("opportunity_candidates"."source" = 'INDEPENDENT' and "opportunity_candidates"."scan_id" is not null and "opportunity_candidates"."claim_id" is null)),
	CONSTRAINT "opportunity_candidates_side_check" CHECK ("opportunity_candidates"."side" in ('BUY', 'SELL')),
	CONSTRAINT "opportunity_candidates_option_check" CHECK ("opportunity_candidates"."option_type" is null or "opportunity_candidates"."option_type" in ('CE', 'PE')),
	CONSTRAINT "opportunity_candidates_entry_check" CHECK ("opportunity_candidates"."entry_kind" in ('above', 'below', 'at', 'range', 'market')),
	CONSTRAINT "opportunity_candidates_data_source_check" CHECK ("opportunity_candidates"."data_source" in ('FIXTURE', 'LIVE', 'HISTORICAL')),
	CONSTRAINT "opportunity_candidates_expiry_check" CHECK ("opportunity_candidates"."expires_at" > "opportunity_candidates"."created_at")
);
--> statement-breakpoint
CREATE TABLE "opportunity_scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_kind" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detector_version" text NOT NULL,
	"data_source" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "opportunity_scans_status_check" CHECK ("opportunity_scans"."status" in ('RUNNING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "opportunity_scans_source_check" CHECK ("opportunity_scans"."data_source" in ('FIXTURE', 'LIVE', 'HISTORICAL')),
	CONSTRAINT "opportunity_scans_count_check" CHECK ("opportunity_scans"."candidate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playbook_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"playbook_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"content" jsonb NOT NULL,
	"performance" jsonb,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"confidence" numeric,
	"limitations" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_versions_state_check" CHECK ("playbook_versions"."state" in ('DRAFT', 'EVALUATING', 'ACTIVE', 'RETIRED', 'ROLLED_BACK')),
	CONSTRAINT "playbook_versions_version_check" CHECK ("playbook_versions"."version" >= 1 and "playbook_versions"."sample_size" >= 0),
	CONSTRAINT "playbook_versions_active_evidence_check" CHECK ("playbook_versions"."state" <> 'ACTIVE' or ("playbook_versions"."performance" is not null and "playbook_versions"."sample_size" > 0))
);
--> statement-breakpoint
CREATE TABLE "research_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"agent_results" jsonb NOT NULL,
	"assessment" text NOT NULL,
	"halt_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_packages_version_check" CHECK ("research_packages"."version" >= 1),
	CONSTRAINT "research_packages_assessment_check" CHECK ("research_packages"."assessment" in ('RESEARCH_SUPPORTIVE', 'RESEARCH_NEUTRAL', 'RESEARCH_CAUTION', 'RESEARCH_ADVERSE', 'RESEARCH_INCOMPLETE', 'RESEARCH_BLOCKED'))
);
--> statement-breakpoint
CREATE TABLE "signal_classifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"horizon" text NOT NULL,
	"setup" text NOT NULL,
	"risk_profile" text DEFAULT 'UNKNOWN' NOT NULL,
	"entry_condition" jsonb,
	"exit_pattern" jsonb,
	"structure_valid" boolean NOT NULL,
	"confidence" numeric,
	"classifier_version" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_classifications_type_check" CHECK ("signal_classifications"."signal_type" in ('OPTIONS_BUY', 'OPTIONS_SELL', 'FUTURES', 'EQUITY', 'UPDATE', 'UNKNOWN')),
	CONSTRAINT "signal_classifications_horizon_check" CHECK ("signal_classifications"."horizon" in ('INTRADAY', 'POSITIONAL', 'SCALPING', 'UNKNOWN')),
	CONSTRAINT "signal_classifications_setup_check" CHECK ("signal_classifications"."setup" in ('BREAKOUT', 'REVERSAL', 'MOMENTUM', 'GAP', 'SCALP', 'OTHER', 'UNKNOWN')),
	CONSTRAINT "signal_classifications_risk_check" CHECK ("signal_classifications"."risk_profile" in ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE', 'UNKNOWN')),
	CONSTRAINT "signal_classifications_confidence_check" CHECK ("signal_classifications"."confidence" is null or ("signal_classifications"."confidence" >= 0 and "signal_classifications"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "strategy_drift_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"playbook_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"metric" text NOT NULL,
	"baseline" numeric NOT NULL,
	"observed" numeric NOT NULL,
	"details" jsonb,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_drift_events_kind_check" CHECK ("strategy_drift_events"."kind" in ('DRIFT', 'DEGRADATION'))
);
--> statement-breakpoint
CREATE TABLE "strategy_playbooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"telegram_source_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_playbooks_kind_check" CHECK ("strategy_playbooks"."source_kind" in ('TELEGRAM_CHANNEL', 'INDEPENDENT')),
	CONSTRAINT "strategy_playbooks_owner_check" CHECK (("strategy_playbooks"."source_kind" = 'TELEGRAM_CHANNEL' and "strategy_playbooks"."telegram_source_id" is not null) or ("strategy_playbooks"."source_kind" = 'INDEPENDENT' and "strategy_playbooks"."telegram_source_id" is null))
);
--> statement-breakpoint
CREATE TABLE "confidence_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"score" numeric NOT NULL,
	"components" jsonb NOT NULL,
	"supporting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradicting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"historical_comparison" jsonb,
	"explanation" text NOT NULL,
	"calibration_status" text DEFAULT 'UNCALIBRATED' NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confidence_assessments_score_check" CHECK ("confidence_assessments"."score" >= 0 and "confidence_assessments"."score" <= 100),
	CONSTRAINT "confidence_assessments_calibration_check" CHECK ("confidence_assessments"."calibration_status" in ('UNCALIBRATED', 'CALIBRATING', 'CALIBRATED'))
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"passed" boolean NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"scenarios" jsonb NOT NULL,
	"cost_model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_monitoring_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"decision_id" uuid,
	"mode" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_monitoring_events_kind_check" CHECK ("trade_monitoring_events"."kind" in ('ENTRY_FILLED', 'STOP_HIT', 'TARGET_HIT', 'TRAIL_MOVED', 'TIME_EXIT', 'RISK_BREACH', 'PARTIAL_EXIT', 'RECONCILIATION_MISMATCH')),
	CONSTRAINT "trade_monitoring_events_mode_check" CHECK ("trade_monitoring_events"."mode" in ('PAPER', 'LIVE'))
);
--> statement-breakpoint
CREATE TABLE "trade_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"decision_id" uuid,
	"mode" text NOT NULL,
	"paper_trade_id" uuid,
	"order_id" uuid,
	"instrument" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric NOT NULL,
	"pnl" numeric NOT NULL,
	"r_multiple" numeric,
	"exit_reason" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_outcomes_mode_check" CHECK ("trade_outcomes"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "trade_outcomes_source_check" CHECK (("trade_outcomes"."mode" = 'PAPER' and "trade_outcomes"."paper_trade_id" is not null and "trade_outcomes"."order_id" is null) or ("trade_outcomes"."mode" = 'LIVE' and "trade_outcomes"."order_id" is not null and "trade_outcomes"."paper_trade_id" is null)),
	CONSTRAINT "trade_outcomes_time_check" CHECK ("trade_outcomes"."closed_at" >= "trade_outcomes"."opened_at" and "trade_outcomes"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_decision_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_decision_events_to_check" CHECK ("user_decision_events"."to_state" in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')),
	CONSTRAINT "user_decision_events_from_check" CHECK ("user_decision_events"."from_state" is null or "user_decision_events"."from_state" in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "user_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"workflow_state" text DEFAULT 'PENDING' NOT NULL,
	"confidence_assessment_id" uuid,
	"risk_assessment_id" uuid,
	"simulation_id" uuid,
	"risk_decision_id" uuid,
	"explanation" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_decisions_outcome_check" CHECK ("user_decisions"."outcome" in ('QUALIFIED', 'WAIT', 'REJECT', 'EVALUATION_ONLY', 'NO_TRADE')),
	CONSTRAINT "user_decisions_state_check" CHECK ("user_decisions"."workflow_state" in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')),
	CONSTRAINT "user_decisions_window_check" CHECK ("user_decisions"."valid_until" > "user_decisions"."valid_from"),
	CONSTRAINT "user_decisions_approved_qualified_check" CHECK ("user_decisions"."workflow_state" <> 'APPROVED' or "user_decisions"."outcome" = 'QUALIFIED')
);
--> statement-breakpoint
CREATE TABLE "confidence_calibration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"sample_size" integer NOT NULL,
	"out_of_sample" boolean NOT NULL,
	"bins" jsonb NOT NULL,
	"brier_score" numeric,
	"calibration_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confidence_calibration_runs_status_check" CHECK ("confidence_calibration_runs"."calibration_status" in ('UNCALIBRATED', 'CALIBRATING', 'CALIBRATED')),
	CONSTRAINT "confidence_calibration_runs_sample_check" CHECK ("confidence_calibration_runs"."sample_size" >= 0),
	CONSTRAINT "confidence_calibration_runs_oos_check" CHECK ("confidence_calibration_runs"."calibration_status" <> 'CALIBRATED' or "confidence_calibration_runs"."out_of_sample" = true)
);
--> statement-breakpoint
CREATE TABLE "counterfactual_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid,
	"decision_id" uuid,
	"question" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterfactual_reviews_subject_check" CHECK ("counterfactual_reviews"."candidate_id" is not null or "counterfactual_reviews"."decision_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "learning_version_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"learning_version_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_version_events_to_check" CHECK ("learning_version_events"."to_state" in ('PROPOSED', 'EVALUATING', 'ACTIVE', 'REJECTED', 'ROLLED_BACK'))
);
--> statement-breakpoint
CREATE TABLE "learning_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"version" integer NOT NULL,
	"state" text DEFAULT 'PROPOSED' NOT NULL,
	"evaluation" jsonb,
	"influences_live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "learning_versions_kind_check" CHECK ("learning_versions"."kind" in ('PLAYBOOK', 'CONFIDENCE_MODEL', 'SCORING_WEIGHTS', 'SOURCE_PROFILE')),
	CONSTRAINT "learning_versions_state_check" CHECK ("learning_versions"."state" in ('PROPOSED', 'EVALUATING', 'ACTIVE', 'REJECTED', 'ROLLED_BACK')),
	CONSTRAINT "learning_versions_version_check" CHECK ("learning_versions"."version" >= 1),
	CONSTRAINT "learning_versions_live_active_check" CHECK ("learning_versions"."influences_live" = false or "learning_versions"."state" = 'ACTIVE'),
	CONSTRAINT "learning_versions_active_evaluation_check" CHECK ("learning_versions"."state" <> 'ACTIVE' or ("learning_versions"."evaluation" is not null and "learning_versions"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid,
	"user_id" uuid,
	"mode" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performance_snapshots_scope_check" CHECK ("performance_snapshots"."scope" in ('CHANNEL', 'STRATEGY', 'AGENT', 'USER', 'PLATFORM')),
	CONSTRAINT "performance_snapshots_mode_check" CHECK ("performance_snapshots"."mode" in ('PAPER', 'LIVE', 'HISTORICAL')),
	CONSTRAINT "performance_snapshots_period_check" CHECK ("performance_snapshots"."period_end" > "performance_snapshots"."period_start"),
	CONSTRAINT "performance_snapshots_user_scope_check" CHECK (("performance_snapshots"."scope" = 'USER') = ("performance_snapshots"."user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'TRADER' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_assessments_id_user_unique" ON "risk_assessments" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "simulations_id_user_unique" ON "simulations" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_decisions_id_user_unique" ON "user_decisions" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_id_user_unique" ON "accounts" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_id_account_unique" ON "orders" USING btree ("id","account_id");--> statement-breakpoint
ALTER TABLE "user_capital_profiles" ADD CONSTRAINT "user_capital_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capital_profiles" ADD CONSTRAINT "user_capital_profiles_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_execution_permissions" ADD CONSTRAINT "user_execution_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_execution_permissions" ADD CONSTRAINT "user_execution_permissions_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_claim_id_options_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_candidates" ADD CONSTRAINT "opportunity_candidates_scan_id_opportunity_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."opportunity_scans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_playbook_id_strategy_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."strategy_playbooks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_packages" ADD CONSTRAINT "research_packages_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_classifications" ADD CONSTRAINT "signal_classifications_claim_id_options_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_drift_events" ADD CONSTRAINT "strategy_drift_events_playbook_id_strategy_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."strategy_playbooks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_playbooks" ADD CONSTRAINT "strategy_playbooks_telegram_source_id_telegram_sources_id_fk" FOREIGN KEY ("telegram_source_id") REFERENCES "public"."telegram_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confidence_assessments" ADD CONSTRAINT "confidence_assessments_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" ADD CONSTRAINT "trade_monitoring_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" ADD CONSTRAINT "trade_monitoring_events_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" ADD CONSTRAINT "trade_monitoring_events_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_paper_trade_id_paper_trades_id_fk" FOREIGN KEY ("paper_trade_id") REFERENCES "public"."paper_trades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_order_fk" FOREIGN KEY ("order_id","account_id") REFERENCES "public"."orders"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decision_events" ADD CONSTRAINT "user_decision_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decision_events" ADD CONSTRAINT "user_decision_events_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_candidate_id_opportunity_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_confidence_fk" FOREIGN KEY ("confidence_assessment_id") REFERENCES "public"."confidence_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_risk_assessment_fk" FOREIGN KEY ("risk_assessment_id","user_id") REFERENCES "public"."risk_assessments"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_simulation_fk" FOREIGN KEY ("simulation_id","user_id") REFERENCES "public"."simulations"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_supersedes_fk" FOREIGN KEY ("supersedes_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_reviews" ADD CONSTRAINT "counterfactual_reviews_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."opportunity_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_reviews" ADD CONSTRAINT "counterfactual_reviews_decision_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."user_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_version_events" ADD CONSTRAINT "learning_version_events_version_fk" FOREIGN KEY ("learning_version_id") REFERENCES "public"."learning_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_capital_profiles_account_version_unique" ON "user_capital_profiles" USING btree ("account_id","version");--> statement-breakpoint
CREATE INDEX "user_capital_profiles_account_idx" ON "user_capital_profiles" USING btree ("account_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "user_risk_policies_account_version_unique" ON "user_risk_policies" USING btree ("account_id","version");--> statement-breakpoint
CREATE INDEX "user_risk_policies_account_idx" ON "user_risk_policies" USING btree ("account_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_regimes_observation_unique" ON "market_regimes" USING btree ("underlying","timeframe","as_of","detector_version","data_source");--> statement-breakpoint
CREATE INDEX "market_regimes_latest_idx" ON "market_regimes" USING btree ("underlying","timeframe","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_candidates_claim_unique" ON "opportunity_candidates" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "opportunity_candidates_state_idx" ON "opportunity_candidates" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "opportunity_candidates_source_idx" ON "opportunity_candidates" USING btree ("source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_versions_unique" ON "playbook_versions" USING btree ("playbook_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_packages_candidate_version_unique" ON "research_packages" USING btree ("candidate_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_classifications_claim_version_unique" ON "signal_classifications" USING btree ("claim_id","classifier_version");--> statement-breakpoint
CREATE INDEX "strategy_drift_events_playbook_idx" ON "strategy_drift_events" USING btree ("playbook_id","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_playbooks_source_name_unique" ON "strategy_playbooks" USING btree ("telegram_source_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_playbooks_independent_name_unique" ON "strategy_playbooks" USING btree ("name") WHERE "strategy_playbooks"."telegram_source_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "confidence_assessments_candidate_model_unique" ON "confidence_assessments" USING btree ("candidate_id","model_version");--> statement-breakpoint
CREATE INDEX "risk_assessments_user_candidate_idx" ON "risk_assessments" USING btree ("user_id","candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "simulations_user_candidate_idx" ON "simulations" USING btree ("user_id","candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "trade_monitoring_events_user_idx" ON "trade_monitoring_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "trade_outcomes_user_idx" ON "trade_outcomes" USING btree ("user_id","mode","closed_at");--> statement-breakpoint
CREATE INDEX "user_decision_events_decision_idx" ON "user_decision_events" USING btree ("decision_id","at");--> statement-breakpoint
CREATE INDEX "user_decision_events_user_idx" ON "user_decision_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "user_decisions_user_idx" ON "user_decisions" USING btree ("user_id","workflow_state","valid_until");--> statement-breakpoint
CREATE INDEX "user_decisions_candidate_idx" ON "user_decisions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "learning_version_events_version_idx" ON "learning_version_events" USING btree ("learning_version_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_versions_unique" ON "learning_versions" USING btree ("kind","subject_id","version");--> statement-breakpoint
CREATE INDEX "performance_snapshots_scope_idx" ON "performance_snapshots" USING btree ("scope","scope_id","mode","period_end");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('ADMIN', 'TRADER'));
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 02, ADR-002/003/008/011/012). Append-only evidence tables reject UPDATE / DELETE / TRUNCATE through the existing twins_audit_forbid_change() function; the trigger names end in _no_update_delete so infrastructure/staging/app-role.sql grants the runtime role SELECT and INSERT only.
--> statement-breakpoint
CREATE TRIGGER "user_capital_profiles_no_update_delete" BEFORE UPDATE OR DELETE ON "user_capital_profiles" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_capital_profiles_no_truncate" BEFORE TRUNCATE ON "user_capital_profiles" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_risk_policies_no_update_delete" BEFORE UPDATE OR DELETE ON "user_risk_policies" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_risk_policies_no_truncate" BEFORE TRUNCATE ON "user_risk_policies" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "risk_assessments_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_assessments" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "risk_assessments_no_truncate" BEFORE TRUNCATE ON "risk_assessments" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "simulations_no_update_delete" BEFORE UPDATE OR DELETE ON "simulations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "simulations_no_truncate" BEFORE TRUNCATE ON "simulations" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_decision_events_no_update_delete" BEFORE UPDATE OR DELETE ON "user_decision_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_decision_events_no_truncate" BEFORE TRUNCATE ON "user_decision_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "trade_monitoring_events_no_update_delete" BEFORE UPDATE OR DELETE ON "trade_monitoring_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "trade_monitoring_events_no_truncate" BEFORE TRUNCATE ON "trade_monitoring_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "trade_outcomes_no_update_delete" BEFORE UPDATE OR DELETE ON "trade_outcomes" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "trade_outcomes_no_truncate" BEFORE TRUNCATE ON "trade_outcomes" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "strategy_drift_events_no_update_delete" BEFORE UPDATE OR DELETE ON "strategy_drift_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "strategy_drift_events_no_truncate" BEFORE TRUNCATE ON "strategy_drift_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "learning_version_events_no_update_delete" BEFORE UPDATE OR DELETE ON "learning_version_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "learning_version_events_no_truncate" BEFORE TRUNCATE ON "learning_version_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "signal_classifications_no_update_delete" BEFORE UPDATE OR DELETE ON "signal_classifications" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "signal_classifications_no_truncate" BEFORE TRUNCATE ON "signal_classifications" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "market_regimes_no_update_delete" BEFORE UPDATE OR DELETE ON "market_regimes" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "market_regimes_no_truncate" BEFORE TRUNCATE ON "market_regimes" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "confidence_assessments_no_update_delete" BEFORE UPDATE OR DELETE ON "confidence_assessments" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "confidence_assessments_no_truncate" BEFORE TRUNCATE ON "confidence_assessments" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "confidence_calibration_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "confidence_calibration_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "confidence_calibration_runs_no_truncate" BEFORE TRUNCATE ON "confidence_calibration_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "counterfactual_reviews_no_update_delete" BEFORE UPDATE OR DELETE ON "counterfactual_reviews" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "counterfactual_reviews_no_truncate" BEFORE TRUNCATE ON "counterfactual_reviews" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "research_packages_no_update_delete" BEFORE UPDATE OR DELETE ON "research_packages" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "research_packages_no_truncate" BEFORE TRUNCATE ON "research_packages" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "performance_snapshots_no_update_delete" BEFORE UPDATE OR DELETE ON "performance_snapshots" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "performance_snapshots_no_truncate" BEFORE TRUNCATE ON "performance_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. user_decisions guard: a decision is created PENDING; afterwards ONLY workflow_state (and updated_at) may change, and a decision in a final state never changes again. This stops outcome, owner, evidence links and validity window from being edited after the fact, and stops a row being inserted already APPROVED. The approval itself (a recorded human approval) is added in Stage 07 as the only door; until then the runtime role has no write grant on this table (app-role.sql).
--> statement-breakpoint
CREATE FUNCTION "twins_user_decision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.workflow_state <> 'PENDING' THEN
			RAISE EXCEPTION 'a decision must start PENDING' USING ERRCODE = 'check_violation';
		END IF;
		-- mandatory stop-loss floor: a QUALIFIED decision cannot be created for a candidate that has no positive stop-loss. This is only a floor; the full rule (basis, validity) stays in packages/stop-loss and the Stage 07 producer must call it first.
		IF NEW.outcome = 'QUALIFIED' AND NOT EXISTS (SELECT 1 FROM opportunity_candidates c WHERE c.id = NEW.candidate_id AND c.stop_loss IS NOT NULL AND c.stop_loss > 0) THEN
			RAISE EXCEPTION 'a QUALIFIED decision needs a candidate with a stop-loss' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.account_id <> OLD.account_id OR NEW.candidate_id <> OLD.candidate_id
	   OR NEW.outcome <> OLD.outcome OR NEW.explanation IS DISTINCT FROM OLD.explanation
	   OR NEW.valid_from <> OLD.valid_from OR NEW.valid_until <> OLD.valid_until OR NEW.created_at <> OLD.created_at
	   OR NEW.confidence_assessment_id IS DISTINCT FROM OLD.confidence_assessment_id OR NEW.risk_assessment_id IS DISTINCT FROM OLD.risk_assessment_id
	   OR NEW.simulation_id IS DISTINCT FROM OLD.simulation_id OR NEW.risk_decision_id IS DISTINCT FROM OLD.risk_decision_id
	   OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
		RAISE EXCEPTION 'only workflow_state of a decision may change' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.workflow_state <> OLD.workflow_state AND OLD.workflow_state <> 'PENDING' THEN
		RAISE EXCEPTION 'a decision in a final state cannot change' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_decisions_guard" BEFORE INSERT OR UPDATE ON "user_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_user_decision_guard"();
--> statement-breakpoint
CREATE TRIGGER "user_decisions_no_delete" BEFORE DELETE ON "user_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "user_decisions_no_truncate" BEFORE TRUNCATE ON "user_decisions" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Until the Stage 07 approval doors exist, the runtime and bot roles must not write user_decisions or user_decision_events (same pattern as migration 0029 for the execution tables; app-role.sql lists them as read-only so a re-run does not grant them back). The roles are skipped when absent (CI and development databases).
--> statement-breakpoint
DO $$
DECLARE
	r text;
	t text;
BEGIN
	FOREACH r IN ARRAY ARRAY['twins_app', 'twins_bot'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			FOREACH t IN ARRAY ARRAY['user_decisions', 'user_decision_events'] LOOP
				EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I', t, r);
			END LOOP;
		END IF;
	END LOOP;
END
$$;
--> statement-breakpoint
-- HAND-APPENDED. Row-level security on every user-private table: a row is visible and writable only when its user_id equals the transaction's `twins.user_id` setting. With no setting the policy matches nothing (fail closed). FORCE applies it to the table owner too. The application sets the setting per transaction (packages/database withUser); system actors act for a user only by naming that user. Composite (account_id, user_id) foreign keys additionally guarantee that a row can never name another user's account.
--> statement-breakpoint
ALTER TABLE "user_capital_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_capital_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_capital_profiles_owner_only" ON "user_capital_profiles" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_risk_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_risk_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_risk_policies_owner_only" ON "user_risk_policies" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_execution_permissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_execution_permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_execution_permissions_owner_only" ON "user_execution_permissions" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "risk_assessments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "risk_assessments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "risk_assessments_owner_only" ON "risk_assessments" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "simulations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "simulations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "simulations_owner_only" ON "simulations" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_decisions_owner_only" ON "user_decisions" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_decision_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_decision_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_decision_events_owner_only" ON "user_decision_events" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trade_monitoring_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trade_monitoring_events_owner_only" ON "trade_monitoring_events" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "trade_outcomes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trade_outcomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trade_outcomes_owner_only" ON "trade_outcomes" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
--> statement-breakpoint
-- HAND-APPENDED. performance_snapshots: shared rows (no user) are readable by all; a user's own rows only by that user; a SHARED row can be written only with NO user context (system actors), never from a user session.
--> statement-breakpoint
ALTER TABLE "performance_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "performance_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "performance_snapshots_shared_or_owner" ON "performance_snapshots" USING (user_id is null or user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK ((user_id is null and nullif(current_setting('twins.user_id', true), '')::uuid is null) or user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
