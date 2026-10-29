-- HAND-WRITTEN (drizzle cannot represent triggers, functions, event triggers or backfills). Stage 1 / Task 3: immutable audit trail + tamper evidence.
--
-- 1. APPEND-ONLY: audit_events, signal_validations, telegram_messages, options_claims (system_control_events already is, 0009) reject UPDATE, DELETE and
--    TRUNCATE (SQLSTATE 23001). The guard triggers are ENABLE ALWAYS, so session_replication_role = replica does not bypass them. A correction is a NEW
--    row (a correction/void event), never an edit.
-- 2. HASH CHAIN: every row of those five tables carries chain_index, previous_hash, payload_hash and event_hash, assigned by a BEFORE INSERT trigger (the
--    caller cannot supply or influence them, raw SQL included):
--      payload       = to_json(ARRAY[<fixed list of the row's content columns rendered as text>])::text     (deterministic canonical JSON array; see twins_audit_payload_*)
--      payload_hash  = sha256(payload)                                  (hex)
--      event_hash    = sha256('TWINS-AUDIT-V1' LF chain LF chain_index LF previous_hash LF payload_hash)   (hex)
--      previous_hash = event_hash of the row with chain_index - 1; genesis = 64 zeros
--    Index assignment is serialized by a per-chain advisory lock held to the end of the inserting transaction, and the next index is derived from the table
--    itself, so INSERT ... ON CONFLICT DO NOTHING never leaves a gap. audit_chain_heads records the latest (index, hash) per chain (written only by the
--    chain trigger) so deleting the newest rows is detected too. Pre-existing rows are chained in (created_at, id) order by this migration: tamper
--    evidence for them starts here. Adding a content column to a chained table later REQUIRES a new payload version (see docs/twins/IMMUTABLE_AUDIT.md).
-- 3. OPERATOR CONTEXT: system_control_events records the change mechanism, source process, declared operator context and the database-observed session.
-- 4. DDL WATCH: (superuser only) an event trigger records DDL that mentions a protected object in audit_events, so schema-level tampering is not silent.
-- The verifier is packages/audit-chain (npm run audit:verify).

-- ---------------------------------------------------------------- columns
ALTER TABLE "audit_events" ADD COLUMN "chain_index" bigint, ADD COLUMN "previous_hash" text, ADD COLUMN "payload_hash" text, ADD COLUMN "event_hash" text;--> statement-breakpoint
ALTER TABLE "signal_validations" ADD COLUMN "chain_index" bigint, ADD COLUMN "previous_hash" text, ADD COLUMN "payload_hash" text, ADD COLUMN "event_hash" text;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "chain_index" bigint, ADD COLUMN "previous_hash" text, ADD COLUMN "payload_hash" text, ADD COLUMN "event_hash" text;--> statement-breakpoint
ALTER TABLE "options_claims" ADD COLUMN "chain_index" bigint, ADD COLUMN "previous_hash" text, ADD COLUMN "payload_hash" text, ADD COLUMN "event_hash" text;--> statement-breakpoint
ALTER TABLE "system_control_events" ADD COLUMN "chain_index" bigint, ADD COLUMN "previous_hash" text, ADD COLUMN "payload_hash" text, ADD COLUMN "event_hash" text,
	ADD COLUMN "change_mechanism" text NOT NULL DEFAULT 'legacy', ADD COLUMN "source_process" text NOT NULL DEFAULT 'legacy', ADD COLUMN "operator_context" jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN "db_session_user" text, ADD COLUMN "db_client_addr" text, ADD COLUMN "db_application_name" text;--> statement-breakpoint
-- ---------------------------------------------------------------- canonical payload functions
CREATE FUNCTION "twins_audit_ts"(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_audit_events"(r "audit_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.event_type, r.entity_type, r.entity_id::text, r.actor_type::text, r.actor_id, r.before_state::text, r.after_state::text, r.metadata::text, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_signal_validations"(r "signal_validations") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.signal_id::text, r.outcome::text, r.decision_confidence::text, r.confidence_label, r.bull_thesis::text, r.bear_thesis::text, r.counter_thesis::text,
		r.counter_thesis_severity::text, r.source_reliability::text, r.source_reliability_reason, r.rationale, r.idempotency_key, twins_audit_ts(r.validated_at), twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_telegram_messages"(r "telegram_messages") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.telegram_source_id::text, r.external_message_id, twins_audit_ts(r.message_timestamp), twins_audit_ts(r.received_at), r.origin_message_id, twins_audit_ts(r.edit_date),
		r.raw_text, r.raw_payload::text, r.capture_method, twins_audit_ts(r.observed_at), twins_audit_ts(r.imported_at), r.first_seen_edited::text, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_options_claims"(r "options_claims") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.telegram_message_id::text, r.parser_version, r.result_kind, r.claim::text, r.detail::text, r.assessment_outcome, r.reasons::text, r.verification::text,
		r.premium::text, r.provenance::text, r.approval_possible::text, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_payload_system_control_events"(r "system_control_events") RETURNS text LANGUAGE sql STABLE AS $$
	SELECT to_json(ARRAY[r.id::text, r.control_name, r.previous_value::text, r.new_value::text, r.reason, r.changed_by, twins_audit_ts(r.changed_at), r.version::text, r.event_type,
		r.change_mechanism, r.source_process, r.operator_context::text, r.db_session_user, r.db_client_addr, r.db_application_name, twins_audit_ts(r.created_at)])::text
$$;--> statement-breakpoint
-- ---------------------------------------------------------------- chain heads (written only by the chain trigger)
CREATE TABLE "audit_chain_heads" (
	"chain_name" text PRIMARY KEY NOT NULL,
	"last_index" bigint NOT NULL,
	"last_hash" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT "audit_chain_heads_name_check" CHECK ("chain_name" in ('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events')),
	CONSTRAINT "audit_chain_heads_shape_check" CHECK ("last_index" >= 0 AND "last_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
-- ---------------------------------------------------------------- backfill existing rows (guard triggers do not exist yet, except the old 0009 one)
ALTER TABLE "system_control_events" DISABLE TRIGGER "system_control_events_no_update_delete";--> statement-breakpoint
UPDATE "system_control_events" SET "change_mechanism" = 'migration', "source_process" = 'migration:0009' WHERE "event_type" = 'seed';--> statement-breakpoint
DO $$
DECLARE
	spec record; r record; idx bigint; prev text; ph text; eh text;
BEGIN
	FOR spec IN SELECT * FROM (VALUES ('audit_events'), ('signal_validations'), ('telegram_messages'), ('options_claims'), ('system_control_events')) AS v(tbl) LOOP
		idx := 0;
		prev := repeat('0', 64);
		FOR r IN EXECUTE format('SELECT t.id AS id, twins_audit_payload_%s(t) AS payload FROM %I t ORDER BY t.created_at, t.id', spec.tbl, spec.tbl) LOOP
			idx := idx + 1;
			ph := encode(sha256(convert_to(r.payload, 'UTF8')), 'hex');
			eh := encode(sha256(convert_to('TWINS-AUDIT-V1' || E'\n' || spec.tbl || E'\n' || idx::text || E'\n' || prev || E'\n' || ph, 'UTF8')), 'hex');
			EXECUTE format('UPDATE %I SET chain_index = $1, previous_hash = $2, payload_hash = $3, event_hash = $4 WHERE id = $5', spec.tbl) USING idx, prev, ph, eh, r.id;
			prev := eh;
		END LOOP;
		INSERT INTO audit_chain_heads (chain_name, last_index, last_hash) VALUES (spec.tbl, idx, prev);
	END LOOP;
END
$$;--> statement-breakpoint
-- ---------------------------------------------------------------- constraints (after the backfill)
ALTER TABLE "audit_events" ALTER COLUMN "chain_index" SET NOT NULL, ALTER COLUMN "previous_hash" SET NOT NULL, ALTER COLUMN "payload_hash" SET NOT NULL, ALTER COLUMN "event_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_validations" ALTER COLUMN "chain_index" SET NOT NULL, ALTER COLUMN "previous_hash" SET NOT NULL, ALTER COLUMN "payload_hash" SET NOT NULL, ALTER COLUMN "event_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_messages" ALTER COLUMN "chain_index" SET NOT NULL, ALTER COLUMN "previous_hash" SET NOT NULL, ALTER COLUMN "payload_hash" SET NOT NULL, ALTER COLUMN "event_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "options_claims" ALTER COLUMN "chain_index" SET NOT NULL, ALTER COLUMN "previous_hash" SET NOT NULL, ALTER COLUMN "payload_hash" SET NOT NULL, ALTER COLUMN "event_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "system_control_events" ALTER COLUMN "chain_index" SET NOT NULL, ALTER COLUMN "previous_hash" SET NOT NULL, ALTER COLUMN "payload_hash" SET NOT NULL, ALTER COLUMN "event_hash" SET NOT NULL,
	ALTER COLUMN "change_mechanism" DROP DEFAULT, ALTER COLUMN "source_process" DROP DEFAULT, ALTER COLUMN "operator_context" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "signal_validations" ADD CONSTRAINT "signal_validations_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "options_claims" ADD CONSTRAINT "options_claims_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "system_control_events" ADD CONSTRAINT "system_control_events_chain_check" CHECK ("chain_index" >= 1 AND "previous_hash" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "system_control_events" ADD CONSTRAINT "system_control_events_mechanism_check" CHECK ("change_mechanism" in ('cli', 'service', 'sql', 'migration', 'legacy'));--> statement-breakpoint
ALTER TABLE "system_control_events" ADD CONSTRAINT "system_control_events_source_check" CHECK ("source_process" ~ '^[A-Za-z0-9._:-]{2,64}$');--> statement-breakpoint
ALTER TABLE "system_control_events" ADD CONSTRAINT "system_control_events_context_size_check" CHECK (octet_length("operator_context"::text) <= 2048);--> statement-breakpoint
ALTER TABLE "system_control_events" ADD CONSTRAINT "system_control_events_identity_check" CHECK (
	("change_mechanism" <> 'cli' OR "changed_by" ~ '^operator:[a-z0-9][a-z0-9._-]{1,40}$')
	AND ("change_mechanism" <> 'service' OR "changed_by" ~ '^service:[a-z0-9][a-z0-9._-]{1,40}$'));--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_chain_index_unique" ON "audit_events" USING btree ("chain_index");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_validations_chain_index_unique" ON "signal_validations" USING btree ("chain_index");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_chain_index_unique" ON "telegram_messages" USING btree ("chain_index");--> statement-breakpoint
CREATE UNIQUE INDEX "options_claims_chain_index_unique" ON "options_claims" USING btree ("chain_index");--> statement-breakpoint
CREATE UNIQUE INDEX "system_control_events_chain_index_unique" ON "system_control_events" USING btree ("chain_index");--> statement-breakpoint
-- ---------------------------------------------------------------- trigger functions
CREATE FUNCTION "twins_audit_chain_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	chain text := TG_ARGV[0];
	last_index bigint;
	last_hash text;
	payload text;
BEGIN
	-- one writer per chain at a time, until the end of this transaction
	PERFORM pg_advisory_xact_lock(1953720, hashtext(chain));
	EXECUTE format('SELECT chain_index, event_hash FROM %I.%I ORDER BY chain_index DESC LIMIT 1', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO last_index, last_hash;
	IF last_index IS NULL THEN
		last_index := 0;
		last_hash := repeat('0', 64);
	END IF;
	NEW.chain_index := last_index + 1;
	NEW.previous_hash := last_hash;
	EXECUTE format('SELECT %I($1)', 'twins_audit_payload_' || TG_TABLE_NAME) INTO payload USING NEW;
	NEW.payload_hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
	NEW.event_hash := encode(sha256(convert_to('TWINS-AUDIT-V1' || E'\n' || chain || E'\n' || NEW.chain_index::text || E'\n' || NEW.previous_hash || E'\n' || NEW.payload_hash, 'UTF8')), 'hex');
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_chain_after_insert"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	INSERT INTO audit_chain_heads (chain_name, last_index, last_hash, updated_at) VALUES (TG_ARGV[0], NEW.chain_index, NEW.event_hash, clock_timestamp())
	ON CONFLICT (chain_name) DO UPDATE SET last_index = EXCLUDED.last_index, last_hash = EXCLUDED.last_hash, updated_at = EXCLUDED.updated_at
	WHERE audit_chain_heads.last_index < EXCLUDED.last_index;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only (audit-protected): % is not allowed; record a correction event instead', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "twins_audit_heads_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- the heads table is maintained only by the chain trigger (trigger depth >= 2 when called from it); direct writes, deletes and truncates are refused
	IF TG_OP IN ('DELETE', 'TRUNCATE') OR pg_trigger_depth() < 2 THEN
		RAISE EXCEPTION 'audit_chain_heads is maintained by the chain trigger only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
	END IF;
	IF TG_OP = 'UPDATE' AND NEW.last_index <> OLD.last_index + 1 THEN
		RAISE EXCEPTION 'audit_chain_heads must advance by exactly 1' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- the system-controls audit trigger now also records HOW and FROM WHERE a change was made
CREATE OR REPLACE FUNCTION "system_controls_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	mech text := nullif(current_setting('twins.change_mechanism', true), '');
	proc text := nullif(current_setting('twins.source_process', true), '');
	ctx jsonb;
BEGIN
	BEGIN
		ctx := coalesce(nullif(current_setting('twins.operator_context', true), '')::jsonb, '{}'::jsonb);
	EXCEPTION WHEN others THEN
		ctx := jsonb_build_object('invalid_operator_context', true);
	END;
	IF mech IS NULL THEN mech := CASE WHEN TG_OP = 'INSERT' THEN 'migration' ELSE 'sql' END; END IF;
	IF proc IS NULL THEN proc := CASE WHEN TG_OP = 'INSERT' THEN 'migration' ELSE 'raw_sql' END; END IF;
	INSERT INTO system_control_events (control_name, previous_value, new_value, reason, changed_by, changed_at, version, event_type, change_mechanism, source_process, operator_context, db_session_user, db_client_addr, db_application_name)
	VALUES (NEW.control_name, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.value END, NEW.value, NEW.reason, NEW.changed_by, NEW.changed_at, NEW.version,
		CASE WHEN TG_OP = 'INSERT' THEN 'seed' ELSE 'change' END, mech, proc, ctx, session_user, inet_client_addr()::text, nullif(current_setting('application_name', true), ''));
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- ---------------------------------------------------------------- triggers
CREATE TRIGGER "audit_events_chain_before_insert" BEFORE INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('audit_events');--> statement-breakpoint
CREATE TRIGGER "audit_events_chain_after_insert" AFTER INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('audit_events');--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "signal_validations_chain_before_insert" BEFORE INSERT ON "signal_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('signal_validations');--> statement-breakpoint
CREATE TRIGGER "signal_validations_chain_after_insert" AFTER INSERT ON "signal_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('signal_validations');--> statement-breakpoint
CREATE TRIGGER "signal_validations_no_update_delete" BEFORE UPDATE OR DELETE ON "signal_validations" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "signal_validations_no_truncate" BEFORE TRUNCATE ON "signal_validations" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "telegram_messages_chain_before_insert" BEFORE INSERT ON "telegram_messages" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('telegram_messages');--> statement-breakpoint
CREATE TRIGGER "telegram_messages_chain_after_insert" AFTER INSERT ON "telegram_messages" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('telegram_messages');--> statement-breakpoint
CREATE TRIGGER "telegram_messages_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_messages" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "telegram_messages_no_truncate" BEFORE TRUNCATE ON "telegram_messages" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "options_claims_chain_before_insert" BEFORE INSERT ON "options_claims" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('options_claims');--> statement-breakpoint
CREATE TRIGGER "options_claims_chain_after_insert" AFTER INSERT ON "options_claims" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('options_claims');--> statement-breakpoint
CREATE TRIGGER "options_claims_no_update_delete" BEFORE UPDATE OR DELETE ON "options_claims" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "options_claims_no_truncate" BEFORE TRUNCATE ON "options_claims" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "system_control_events_chain_before_insert" BEFORE INSERT ON "system_control_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_before_insert"('system_control_events');--> statement-breakpoint
CREATE TRIGGER "system_control_events_chain_after_insert" AFTER INSERT ON "system_control_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"('system_control_events');--> statement-breakpoint
CREATE TRIGGER "audit_chain_heads_guard" BEFORE INSERT OR UPDATE OR DELETE ON "audit_chain_heads" FOR EACH ROW EXECUTE FUNCTION "twins_audit_heads_guard"();--> statement-breakpoint
CREATE TRIGGER "audit_chain_heads_no_truncate" BEFORE TRUNCATE ON "audit_chain_heads" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_heads_guard"();--> statement-breakpoint
-- ENABLE ALWAYS: the guards also fire when session_replication_role = replica (the usual way to switch triggers off for a session)
ALTER TABLE "audit_events" ENABLE ALWAYS TRIGGER "audit_events_chain_before_insert", ENABLE ALWAYS TRIGGER "audit_events_chain_after_insert", ENABLE ALWAYS TRIGGER "audit_events_no_update_delete", ENABLE ALWAYS TRIGGER "audit_events_no_truncate";--> statement-breakpoint
ALTER TABLE "signal_validations" ENABLE ALWAYS TRIGGER "signal_validations_chain_before_insert", ENABLE ALWAYS TRIGGER "signal_validations_chain_after_insert", ENABLE ALWAYS TRIGGER "signal_validations_no_update_delete", ENABLE ALWAYS TRIGGER "signal_validations_no_truncate";--> statement-breakpoint
ALTER TABLE "telegram_messages" ENABLE ALWAYS TRIGGER "telegram_messages_chain_before_insert", ENABLE ALWAYS TRIGGER "telegram_messages_chain_after_insert", ENABLE ALWAYS TRIGGER "telegram_messages_no_update_delete", ENABLE ALWAYS TRIGGER "telegram_messages_no_truncate";--> statement-breakpoint
ALTER TABLE "options_claims" ENABLE ALWAYS TRIGGER "options_claims_chain_before_insert", ENABLE ALWAYS TRIGGER "options_claims_chain_after_insert", ENABLE ALWAYS TRIGGER "options_claims_no_update_delete", ENABLE ALWAYS TRIGGER "options_claims_no_truncate";--> statement-breakpoint
ALTER TABLE "system_control_events" ENABLE ALWAYS TRIGGER "system_control_events_chain_before_insert", ENABLE ALWAYS TRIGGER "system_control_events_chain_after_insert", ENABLE ALWAYS TRIGGER "system_control_events_no_update_delete", ENABLE ALWAYS TRIGGER "system_control_events_no_truncate";--> statement-breakpoint
ALTER TABLE "system_controls" ENABLE ALWAYS TRIGGER "system_controls_before_update", ENABLE ALWAYS TRIGGER "system_controls_audit_insert", ENABLE ALWAYS TRIGGER "system_controls_audit_update", ENABLE ALWAYS TRIGGER "system_controls_no_delete", ENABLE ALWAYS TRIGGER "system_controls_no_truncate";--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ALWAYS TRIGGER "audit_chain_heads_guard", ENABLE ALWAYS TRIGGER "audit_chain_heads_no_truncate";--> statement-breakpoint
-- ---------------------------------------------------------------- DDL watch (needs superuser; otherwise skipped with a warning and reported by the verifier)
CREATE FUNCTION "twins_audit_ddl_watch"() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
	q text := current_query();
BEGIN
	IF q ~* '(audit_events|signal_validations|telegram_messages|options_claims|system_control_events|system_controls|audit_chain_heads|twins_audit_|system_controls_|_chain_before_insert|_chain_after_insert|_no_update_delete|_no_truncate)' THEN
		INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata)
		VALUES (gen_random_uuid(), 'ddl.' || lower(replace(tg_tag, ' ', '_')), 'schema', NULL, 'system', session_user,
			jsonb_build_object('tag', tg_tag, 'statement', left(q, 2000), 'session_user', session_user, 'current_user', current_user,
				'client_addr', inet_client_addr()::text, 'application_name', nullif(current_setting('application_name', true), '')));
	END IF;
END;
$$;--> statement-breakpoint
DO $$
BEGIN
	IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
		CREATE EVENT TRIGGER "twins_audit_ddl_watch" ON ddl_command_start
			WHEN TAG IN ('ALTER TABLE', 'DROP TABLE', 'DROP TRIGGER', 'CREATE TRIGGER', 'ALTER FUNCTION', 'DROP FUNCTION', 'CREATE FUNCTION')
			EXECUTE FUNCTION "twins_audit_ddl_watch"();
	ELSE
		RAISE WARNING 'twins_audit_ddl_watch NOT installed: creating an event trigger needs a superuser. Protected-table DDL will not be recorded; npm run audit:verify reports this.';
	END IF;
END
$$;--> statement-breakpoint
INSERT INTO "audit_events" ("id", "event_type", "entity_type", "entity_id", "actor_type", "actor_id", "metadata")
VALUES (gen_random_uuid(), 'audit.chain_enabled', 'schema', NULL, 'system', 'migration', jsonb_build_object('migration', '0010_audit_immutability_hash_chain', 'chains', jsonb_build_array('audit_events', 'signal_validations', 'telegram_messages', 'options_claims', 'system_control_events'), 'payload_version', 1));
