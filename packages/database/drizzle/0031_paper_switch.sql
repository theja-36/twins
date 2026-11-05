CREATE TABLE "paper_switch" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_switch_single_row_check" CHECK ("paper_switch"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "paper_switch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"previous_enabled" boolean NOT NULL,
	"enabled" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "paper_switch_events_version_unique" ON "paper_switch_events" USING btree ("version");--> statement-breakpoint
-- HAND-APPENDED. The switch is seeded OFF; its history is append-only; the ONLY way to change it is the SECURITY DEFINER function below, which validates the actor and the reason and writes
-- the audit event in the same statement as the change. The runtime role gets SELECT on both tables and EXECUTE on the function (app-role.sql), never UPDATE.
INSERT INTO "paper_switch" ("id", "enabled", "version", "reason", "changed_by") VALUES (1, false, 1, 'seeded OFF by migration 0031', 'service:migration');--> statement-breakpoint
INSERT INTO "paper_switch_events" ("version", "previous_enabled", "enabled", "reason", "changed_by") VALUES (1, false, false, 'seeded OFF by migration 0031', 'service:migration');--> statement-breakpoint
CREATE TRIGGER "paper_switch_events_no_update_delete" BEFORE UPDATE OR DELETE ON "paper_switch_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE FUNCTION "twins_paper_switch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'the paper switch row is never deleted' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.id <> OLD.id OR NEW.version <> OLD.version + 1 THEN
		RAISE EXCEPTION 'the paper switch version must advance by exactly one' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "paper_switch_guard" BEFORE UPDATE OR DELETE ON "paper_switch" FOR EACH ROW EXECUTE FUNCTION "twins_paper_switch_guard"();--> statement-breakpoint
CREATE FUNCTION "twins_paper_set_switch"(p_enabled boolean, p_actor text, p_reason text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	cur boolean;
	ver integer;
BEGIN
	IF p_enabled IS NULL THEN
		RAISE EXCEPTION 'twins_paper_set_switch: enabled must be true or false' USING ERRCODE = 'check_violation';
	END IF;
	IF p_actor IS NULL OR p_actor !~ '^(operator|service):[A-Za-z0-9._-]{1,64}$' THEN
		RAISE EXCEPTION 'twins_paper_set_switch: actor must be operator:<name> or service:<name>' USING ERRCODE = 'check_violation';
	END IF;
	IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 500 THEN
		RAISE EXCEPTION 'twins_paper_set_switch: a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
	END IF;
	SELECT enabled, version INTO cur, ver FROM paper_switch WHERE id = 1 FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'twins_paper_set_switch: the switch row is missing' USING ERRCODE = 'check_violation';
	END IF;
	IF cur = p_enabled THEN
		RETURN 'unchanged';
	END IF;
	UPDATE paper_switch SET enabled = p_enabled, version = ver + 1, reason = btrim(p_reason), changed_by = p_actor, changed_at = now() WHERE id = 1;
	INSERT INTO paper_switch_events (version, previous_enabled, enabled, reason, changed_by) VALUES (ver + 1, cur, p_enabled, btrim(p_reason), p_actor);
	RETURN CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "twins_paper_set_switch"(boolean, text, text) FROM PUBLIC;
