CREATE TABLE "approval_bot_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"card_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_bot_events_type_check" CHECK ("approval_bot_events"."event_type" ~ '^[a-z][a-z0-9_:]{2,60}$'),
	CONSTRAINT "approval_bot_events_detail_size_check" CHECK (octet_length("approval_bot_events"."detail"::text) <= 2048)
);
--> statement-breakpoint
CREATE TABLE "approval_bot_state" (
	"id" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"update_offset" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_bot_state_single_row_check" CHECK ("approval_bot_state"."id" = 'bot')
);
--> statement-breakpoint
CREATE TABLE "claim_review_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"claim_id" uuid,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"telegram_message_id" bigint,
	"card_text_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "claim_review_cards_kind_check" CHECK ("claim_review_cards"."kind" in ('claim', 'test')),
	CONSTRAINT "claim_review_cards_state_check" CHECK ("claim_review_cards"."state" in ('pending', 'sent', 'decided', 'expired')),
	CONSTRAINT "claim_review_cards_claim_shape_check" CHECK (("claim_review_cards"."kind" = 'claim') = ("claim_review_cards"."claim_id" is not null)),
	CONSTRAINT "claim_review_cards_nonce_check" CHECK ("claim_review_cards"."nonce" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "claim_review_cards_hash_check" CHECK ("claim_review_cards"."card_text_sha256" is null or "claim_review_cards"."card_text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "claim_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approver_telegram_user_id" bigint NOT NULL,
	"card_telegram_message_id" bigint NOT NULL,
	"update_id" bigint NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_reviews_decision_check" CHECK ("claim_reviews"."decision" in ('approve', 'reject')),
	CONSTRAINT "claim_reviews_evidence_size_check" CHECK (octet_length("claim_reviews"."evidence"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "approval_bot_events" ADD CONSTRAINT "approval_bot_events_card_id_claim_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."claim_review_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_review_cards" ADD CONSTRAINT "claim_review_cards_claim_id_options_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_card_id_claim_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."claim_review_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_claim_id_options_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."options_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_bot_events_type_idx" ON "approval_bot_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_review_cards_claim_unique" ON "claim_review_cards" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claim_review_cards_state_idx" ON "claim_review_cards" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_reviews_card_unique" ON "claim_reviews" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "claim_reviews_claim_idx" ON "claim_reviews" USING btree ("claim_id");--> statement-breakpoint
-- HAND-WRITTEN (drizzle cannot represent triggers; everything above this line is drizzle-kit output).
-- claim_reviews (decisions) and approval_bot_events (audit) are APPEND-ONLY: a row is never edited or removed. The trigger rejects
-- UPDATE, DELETE and TRUNCATE with SQLSTATE 23001 (restrict_violation). claim_review_cards and approval_bot_state are the bot's mutable state.
-- The restricted bot role and its grants are NOT part of this migration (they need a password): see infrastructure/staging/approval-bot-role.sql.
CREATE FUNCTION "approval_bot_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "claim_reviews_no_update_delete" BEFORE UPDATE OR DELETE ON "claim_reviews" FOR EACH ROW EXECUTE FUNCTION "approval_bot_append_only"();--> statement-breakpoint
CREATE TRIGGER "claim_reviews_no_truncate" BEFORE TRUNCATE ON "claim_reviews" FOR EACH STATEMENT EXECUTE FUNCTION "approval_bot_append_only"();--> statement-breakpoint
CREATE TRIGGER "approval_bot_events_no_update_delete" BEFORE UPDATE OR DELETE ON "approval_bot_events" FOR EACH ROW EXECUTE FUNCTION "approval_bot_append_only"();--> statement-breakpoint
CREATE TRIGGER "approval_bot_events_no_truncate" BEFORE TRUNCATE ON "approval_bot_events" FOR EACH STATEMENT EXECUTE FUNCTION "approval_bot_append_only"();
