CREATE TABLE "telegram_intake_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_type" text NOT NULL,
	"intake_source" text NOT NULL,
	"source_message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_type" text DEFAULT 'telegram_chat' NOT NULL,
	"author_id" text,
	"raw_payload" jsonb NOT NULL,
	"correlation_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_intake_outbox_status_check" CHECK ("telegram_intake_outbox"."status" in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
	CONSTRAINT "telegram_intake_outbox_type_check" CHECK ("telegram_intake_outbox"."message_type" in ('message', 'edit', 'deletion')),
	CONSTRAINT "telegram_intake_outbox_source_check" CHECK ("telegram_intake_outbox"."intake_source" in ('bot_webhook', 'user_capture')),
	CONSTRAINT "telegram_intake_outbox_attempts_check" CHECK ("telegram_intake_outbox"."attempt_count" >= 0 and "telegram_intake_outbox"."max_attempts" between 1 and 100),
	CONSTRAINT "telegram_intake_outbox_lock_check" CHECK (("telegram_intake_outbox"."status" = 'PROCESSING') = ("telegram_intake_outbox"."locked_at" is not null and "telegram_intake_outbox"."locked_by" is not null)),
	CONSTRAINT "telegram_intake_outbox_completed_check" CHECK (("telegram_intake_outbox"."status" = 'COMPLETED') = ("telegram_intake_outbox"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_intake_outbox_identity_unique" ON "telegram_intake_outbox" USING btree ("channel_id","source_message_id","message_type");--> statement-breakpoint
CREATE INDEX "telegram_intake_outbox_due_idx" ON "telegram_intake_outbox" USING btree ("status","available_at");--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 2 / Task 2: the durable intake outbox is a work queue, so its processing columns change, but
-- (1) the identity and payload columns never change, (2) COMPLETED and DEAD_LETTER rows never change at all, (3) only the documented status transitions
-- are possible, (4) a row is never deleted or truncated. ENABLE ALWAYS: a session cannot switch these off with session_replication_role.
CREATE FUNCTION "telegram_intake_outbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION 'telegram_intake_outbox rows are never deleted' USING ERRCODE = '42501';
	END IF;
	IF OLD.status IN ('COMPLETED', 'DEAD_LETTER') THEN
		RAISE EXCEPTION 'telegram_intake_outbox: % is a terminal status', OLD.status USING ERRCODE = '42501';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.message_type IS DISTINCT FROM OLD.message_type OR NEW.intake_source IS DISTINCT FROM OLD.intake_source
		OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.channel_type IS DISTINCT FROM OLD.channel_type
		OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
		OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'telegram_intake_outbox: identity and payload columns are immutable' USING ERRCODE = '42501';
	END IF;
	IF NOT ((OLD.status IN ('PENDING', 'FAILED') AND NEW.status IN (OLD.status, 'PROCESSING'))
		OR (OLD.status = 'PROCESSING' AND NEW.status IN ('COMPLETED', 'FAILED', 'PENDING', 'DEAD_LETTER'))) THEN
		RAISE EXCEPTION 'telegram_intake_outbox: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '42501';
	END IF;
	IF NEW.attempt_count < OLD.attempt_count AND NOT (OLD.status = 'PROCESSING' AND NEW.status = 'PENDING' AND NEW.attempt_count = OLD.attempt_count - 1) THEN
		RAISE EXCEPTION 'telegram_intake_outbox: attempt_count only decreases when a refused claim is released' USING ERRCODE = '42501';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "telegram_intake_outbox_guard" BEFORE UPDATE OR DELETE ON "telegram_intake_outbox" FOR EACH ROW EXECUTE FUNCTION "telegram_intake_outbox_guard"();--> statement-breakpoint
CREATE TRIGGER "telegram_intake_outbox_no_truncate" BEFORE TRUNCATE ON "telegram_intake_outbox" FOR EACH STATEMENT EXECUTE FUNCTION "telegram_intake_outbox_guard"();--> statement-breakpoint
ALTER TABLE "telegram_intake_outbox" ENABLE ALWAYS TRIGGER "telegram_intake_outbox_guard", ENABLE ALWAYS TRIGGER "telegram_intake_outbox_no_truncate";
