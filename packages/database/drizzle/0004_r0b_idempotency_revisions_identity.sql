ALTER TABLE "telegram_messages" ADD COLUMN "origin_message_id" text;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "edit_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_sources" ADD COLUMN "chat_id" text;--> statement-breakpoint
-- Hand-edited after generation: historical rows get the explicit label 'legacy-unversioned'
-- (parser provenance was never recorded; it is NOT inferred). The default is dropped
-- immediately so new inserts must state their parser version.
ALTER TABLE "signals" ADD COLUMN "parser_version" text DEFAULT 'legacy-unversioned' NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ALTER COLUMN "parser_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "signal_validations" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "telegram_messages_origin_idx" ON "telegram_messages" USING btree ("telegram_source_id","origin_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_sources_chat_id_unique" ON "telegram_sources" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_telegram_message_parser_unique" ON "signals" USING btree ("telegram_message_id","parser_version");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_validations_idempotency_key_unique" ON "signal_validations" USING btree ("idempotency_key");