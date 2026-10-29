CREATE TABLE "telegram_intake_outbox_replays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outbox_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"previous_attempt_count" integer NOT NULL,
	"previous_last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_intake_outbox_replays_reason_check" CHECK (char_length("telegram_intake_outbox_replays"."reason") between 8 and 500),
	CONSTRAINT "telegram_intake_outbox_replays_actor_check" CHECK ("telegram_intake_outbox_replays"."requested_by" ~ '^operator:[a-z0-9][a-z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "telegram_intake_outbox_replays" ADD CONSTRAINT "telegram_intake_outbox_replays_outbox_id_telegram_intake_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."telegram_intake_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_intake_outbox_replays_outbox_idx" ON "telegram_intake_outbox_replays" USING btree ("outbox_id");--> statement-breakpoint
-- HAND-WRITTEN (everything above is drizzle-kit output). Stage 2 / Task 5: operator replay of a DEAD_LETTER outbox row.
-- 1. The replay log is append-only (ENABLE ALWAYS guards); the runtime role is not granted INSERT (app-role.sql), so only the owner-run operations CLI can record a replay.
-- 2. The outbox guard (0012) keeps DEAD_LETTER terminal EXCEPT for one transition: DEAD_LETTER -> PENDING with attempt_count 0 and every identity/payload column unchanged,
--    and only in the SAME transaction that inserted a replay-log row for that outbox row. Nothing else about a dead letter can change, and there is no bulk path.
CREATE TRIGGER "telegram_intake_outbox_replays_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_intake_outbox_replays" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "telegram_intake_outbox_replays_no_truncate" BEFORE TRUNCATE ON "telegram_intake_outbox_replays" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
ALTER TABLE "telegram_intake_outbox_replays" ENABLE ALWAYS TRIGGER "telegram_intake_outbox_replays_no_update_delete", ENABLE ALWAYS TRIGGER "telegram_intake_outbox_replays_no_truncate";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "telegram_intake_outbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	replay boolean := false;
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION 'telegram_intake_outbox rows are never deleted' USING ERRCODE = '42501';
	END IF;
	IF OLD.status = 'DEAD_LETTER' THEN
		replay := NEW.status = 'PENDING' AND NEW.attempt_count = 0 AND NEW.completed_at IS NULL AND NEW.locked_at IS NULL AND NEW.locked_by IS NULL
			AND EXISTS (SELECT 1 FROM telegram_intake_outbox_replays r WHERE r.outbox_id = OLD.id AND r.xmin::text::bigint = (txid_current() % 4294967296));
		IF NOT replay THEN
			RAISE EXCEPTION 'telegram_intake_outbox: DEAD_LETTER is terminal (only an audited operator replay can reopen it)' USING ERRCODE = '42501';
		END IF;
	ELSIF OLD.status = 'COMPLETED' THEN
		RAISE EXCEPTION 'telegram_intake_outbox: % is a terminal status', OLD.status USING ERRCODE = '42501';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.message_type IS DISTINCT FROM OLD.message_type OR NEW.intake_source IS DISTINCT FROM OLD.intake_source
		OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.channel_type IS DISTINCT FROM OLD.channel_type
		OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
		OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'telegram_intake_outbox: identity and payload columns are immutable' USING ERRCODE = '42501';
	END IF;
	IF NOT (replay
		OR (OLD.status IN ('PENDING', 'FAILED') AND NEW.status IN (OLD.status, 'PROCESSING'))
		OR (OLD.status = 'PROCESSING' AND NEW.status IN ('COMPLETED', 'FAILED', 'PENDING', 'DEAD_LETTER'))) THEN
		RAISE EXCEPTION 'telegram_intake_outbox: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '42501';
	END IF;
	IF NOT replay AND NEW.attempt_count < OLD.attempt_count AND NOT (OLD.status = 'PROCESSING' AND NEW.status = 'PENDING' AND NEW.attempt_count = OLD.attempt_count - 1) THEN
		RAISE EXCEPTION 'telegram_intake_outbox: attempt_count only decreases when a refused claim is released' USING ERRCODE = '42501';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END
$$;
