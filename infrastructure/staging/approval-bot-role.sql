-- Least-privilege Postgres role for the approval bot (T5). Idempotent; run as the database owner AFTER migration 0008 and after the role exists:
--     CREATE ROLE twins_bot LOGIN;        -- then set its password WITHOUT it appearing in a command line, history or the repository
--     \password twins_bot                 -- (psql prompts silently), or generate it on the host and pass it through psql stdin
--   psql -v bot_role=twins_bot -f approval-bot-role.sql
-- The bot can: read parsed claims (never the channel text), read the message id/time/source it needs, and write ONLY its own four tables.
-- It cannot: write options_claims, read telegram_messages.raw_text / raw_payload, read or write anything else, create objects, or become a superuser.
ALTER ROLE :"bot_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5;
ALTER ROLE :"bot_role" SET statement_timeout = '10s';
ALTER ROLE :"bot_role" SET idle_in_transaction_session_timeout = '30s';
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"bot_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"bot_role";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM :"bot_role";
REVOKE ALL ON SCHEMA public FROM :"bot_role";
GRANT USAGE ON SCHEMA public TO :"bot_role";
-- read: parsed claims (column list: no `detail`, `verification`, `premium`, `provenance`)
GRANT SELECT (id, telegram_message_id, parser_version, result_kind, claim, assessment_outcome, reasons, approval_possible, created_at) ON options_claims TO :"bot_role";
-- read: only what a card needs about the source message - NOT raw_text, NOT raw_payload
GRANT SELECT (id, external_message_id, message_timestamp, telegram_source_id, capture_method) ON telegram_messages TO :"bot_role";
GRANT SELECT (id, channel_identifier) ON telegram_sources TO :"bot_role";
-- read: the three runtime safety control values (kill switch / intake / trading), nothing else about them; no write of any kind.
-- system_control_events (the audit) is not granted at all.
GRANT SELECT (control_name, value, version) ON system_controls TO :"bot_role";
-- write: the bot's own tables only
GRANT SELECT, INSERT ON claim_reviews TO :"bot_role";
GRANT SELECT, INSERT ON approval_bot_events TO :"bot_role";
GRANT SELECT, INSERT ON claim_review_cards TO :"bot_role";
GRANT UPDATE (state, telegram_message_id, card_text_sha256, sent_at, decided_at) ON claim_review_cards TO :"bot_role";
GRANT SELECT, INSERT ON approval_bot_state TO :"bot_role";
GRANT UPDATE (paused, update_offset, updated_at) ON approval_bot_state TO :"bot_role";
-- Stage 3 / Task 6 (risk approvals): the bot READS the approval cards the application created (the card text is already rendered; the bot never reads a risk decision) and advances
-- them ONLY through three SECURITY DEFINER functions. It has no privilege at all on the risk decision records, the approvals or any audit table and cannot write risk_approval_cards directly.
GRANT SELECT ON risk_approval_cards TO :"bot_role";
GRANT EXECUTE ON FUNCTION twins_risk_card_mark_sent(uuid, bigint, text) TO :"bot_role";
GRANT EXECUTE ON FUNCTION twins_risk_card_expire_due() TO :"bot_role";
GRANT EXECUTE ON FUNCTION twins_record_risk_approval(uuid, uuid, text, text, jsonb, text, timestamptz) TO :"bot_role";

