CREATE TABLE "system_control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"control_name" text NOT NULL,
	"previous_value" boolean,
	"new_value" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_control_events_name_check" CHECK ("system_control_events"."control_name" in ('TRADING_ENABLED', 'INTAKE_ENABLED', 'KILL_SWITCH_ACTIVE')),
	CONSTRAINT "system_control_events_type_check" CHECK ("system_control_events"."event_type" in ('seed', 'change')),
	CONSTRAINT "system_control_events_previous_check" CHECK (("system_control_events"."event_type" = 'seed') = ("system_control_events"."previous_value" is null))
);
--> statement-breakpoint
CREATE TABLE "system_controls" (
	"control_name" text PRIMARY KEY NOT NULL,
	"value" boolean NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_controls_name_check" CHECK ("system_controls"."control_name" in ('TRADING_ENABLED', 'INTAKE_ENABLED', 'KILL_SWITCH_ACTIVE')),
	CONSTRAINT "system_controls_version_check" CHECK ("system_controls"."version" >= 1),
	CONSTRAINT "system_controls_reason_check" CHECK (char_length(btrim("system_controls"."reason")) between 8 and 500),
	CONSTRAINT "system_controls_changed_by_check" CHECK ("system_controls"."changed_by" ~ '^[A-Za-z0-9._@:-]{2,64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "system_control_events_control_version_unique" ON "system_control_events" USING btree ("control_name","version");--> statement-breakpoint
CREATE INDEX "system_control_events_control_time_idx" ON "system_control_events" USING btree ("control_name","changed_at");--> statement-breakpoint
-- HAND-WRITTEN (drizzle cannot represent triggers or seed data; everything above this line is drizzle-kit output).
-- system_controls holds exactly three rows (the runtime safety controls). The rows can never be deleted or truncated, a value can only change
-- through an UPDATE that bumps version by exactly 1, flips the value and states a NEW reason (the CHECK constraints above already require a
-- reason and changed_by), and changed_at is always stamped by the database. Every insert/update writes an immutable system_control_events row
-- from the trigger itself, so no code path (or raw SQL) can change a control without an audit event. system_control_events is append-only:
-- UPDATE, DELETE and TRUNCATE are rejected with SQLSTATE 23001 (restrict_violation), like the other append-only tables (0007, 0008).
CREATE FUNCTION "system_controls_before_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.control_name IS DISTINCT FROM OLD.control_name THEN
		RAISE EXCEPTION 'system_controls: control_name is immutable' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
		RAISE EXCEPTION 'system_controls: version must increase by exactly 1' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.value IS NOT DISTINCT FROM OLD.value THEN
		RAISE EXCEPTION 'system_controls: a change must flip the value' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
		RAISE EXCEPTION 'system_controls: a change must state a new reason' USING ERRCODE = 'restrict_violation';
	END IF;
	NEW.changed_at := clock_timestamp();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "system_controls_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO system_control_events (control_name, previous_value, new_value, reason, changed_by, changed_at, version, event_type)
		VALUES (NEW.control_name, NULL, NEW.value, NEW.reason, NEW.changed_by, NEW.changed_at, NEW.version, 'seed');
	ELSE
		INSERT INTO system_control_events (control_name, previous_value, new_value, reason, changed_by, changed_at, version, event_type)
		VALUES (NEW.control_name, OLD.value, NEW.value, NEW.reason, NEW.changed_by, NEW.changed_at, NEW.version, 'change');
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "system_controls_no_remove"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'system_controls rows are permanent: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "system_control_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "system_controls_before_update" BEFORE UPDATE ON "system_controls" FOR EACH ROW EXECUTE FUNCTION "system_controls_before_update"();--> statement-breakpoint
CREATE TRIGGER "system_controls_audit_insert" AFTER INSERT ON "system_controls" FOR EACH ROW EXECUTE FUNCTION "system_controls_audit"();--> statement-breakpoint
CREATE TRIGGER "system_controls_audit_update" AFTER UPDATE ON "system_controls" FOR EACH ROW EXECUTE FUNCTION "system_controls_audit"();--> statement-breakpoint
CREATE TRIGGER "system_controls_no_delete" BEFORE DELETE ON "system_controls" FOR EACH ROW EXECUTE FUNCTION "system_controls_no_remove"();--> statement-breakpoint
CREATE TRIGGER "system_controls_no_truncate" BEFORE TRUNCATE ON "system_controls" FOR EACH STATEMENT EXECUTE FUNCTION "system_controls_no_remove"();--> statement-breakpoint
CREATE TRIGGER "system_control_events_no_update_delete" BEFORE UPDATE OR DELETE ON "system_control_events" FOR EACH ROW EXECUTE FUNCTION "system_control_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "system_control_events_no_truncate" BEFORE TRUNCATE ON "system_control_events" FOR EACH STATEMENT EXECUTE FUNCTION "system_control_events_append_only"();--> statement-breakpoint
-- Seed (the audit trigger records one 'seed' event per row). Defaults: trading OFF, intake ON, kill switch OFF.
INSERT INTO "system_controls" ("control_name", "value", "version", "reason", "changed_by") VALUES
	('TRADING_ENABLED', false, 1, 'initial seed: migration 0009 default (trading off)', 'migration'),
	('INTAKE_ENABLED', true, 1, 'initial seed: migration 0009 default (intake on)', 'migration'),
	('KILL_SWITCH_ACTIVE', false, 1, 'initial seed: migration 0009 default (kill switch off)', 'migration');
