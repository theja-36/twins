CREATE TABLE "telegram_message_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"telegram_source_id" uuid NOT NULL,
	"telegram_message_id" uuid,
	"external_message_id" text NOT NULL,
	"event_type" text NOT NULL,
	"capture_method" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_edit_date" timestamp with time zone,
	"content_sha256" text,
	"raw_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_message_events_event_type_check" CHECK ("telegram_message_events"."event_type" in ('seen', 'edited_observed', 'deleted_observed')),
	CONSTRAINT "telegram_message_events_capture_method_check" CHECK ("telegram_message_events"."capture_method" in ('api_live', 'api_history')),
	CONSTRAINT "telegram_message_events_content_sha256_check" CHECK ("telegram_message_events"."content_sha256" is null or "telegram_message_events"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "telegram_message_events_raw_meta_size_check" CHECK (octet_length("telegram_message_events"."raw_meta"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "capture_method" text DEFAULT 'bot_webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "first_seen_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_message_events" ADD CONSTRAINT "telegram_message_events_telegram_source_id_telegram_sources_id_fk" FOREIGN KEY ("telegram_source_id") REFERENCES "public"."telegram_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_events" ADD CONSTRAINT "telegram_message_events_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_message_events_idempotency_key_unique" ON "telegram_message_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "telegram_message_events_message_idx" ON "telegram_message_events" USING btree ("telegram_source_id","external_message_id","observed_at");--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_capture_method_check" CHECK ("telegram_messages"."capture_method" in ('bot_webhook', 'api_live', 'api_history'));--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_imported_at_check" CHECK (("telegram_messages"."capture_method" = 'api_history') = ("telegram_messages"."imported_at" is not null));--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_observed_at_check" CHECK ("telegram_messages"."capture_method" = 'bot_webhook' or "telegram_messages"."observed_at" is not null);--> statement-breakpoint
-- HAND-WRITTEN (drizzle cannot represent triggers; everything above this line is drizzle-kit output).
-- telegram_message_events is APPEND-ONLY: observations are never edited or removed, and a deletion observed in Telegram is
-- just one more row. The trigger rejects UPDATE and DELETE (and TRUNCATE) with SQLSTATE 23001 (restrict_violation).
CREATE FUNCTION "telegram_message_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'telegram_message_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "telegram_message_events_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_message_events" FOR EACH ROW EXECUTE FUNCTION "telegram_message_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "telegram_message_events_no_truncate" BEFORE TRUNCATE ON "telegram_message_events" FOR EACH STATEMENT EXECUTE FUNCTION "telegram_message_events_append_only"();
