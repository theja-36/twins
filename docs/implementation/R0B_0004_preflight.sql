-- READ-ONLY preflight for migration 0004_r0b_idempotency_keys. Run inside a read-only transaction.
-- 1) signals that would violate UNIQUE(telegram_message_id, parser_version) after backfill of the default parser_version.
SELECT telegram_message_id, count(*) AS n, array_agg(id ORDER BY created_at) AS signal_ids
FROM signals WHERE telegram_message_id IS NOT NULL
GROUP BY telegram_message_id HAVING count(*) > 1 ORDER BY n DESC;
-- 2) validations hanging off those duplicate signals (to plan any remediation; migration leaves them untouched).
SELECT s.telegram_message_id, v.signal_id, count(*) AS validations
FROM signal_validations v JOIN signals s ON s.id = v.signal_id
WHERE s.telegram_message_id IN (SELECT telegram_message_id FROM signals WHERE telegram_message_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
GROUP BY s.telegram_message_id, v.signal_id;
-- 3) Cross-check: raw message uniqueness already enforced (expect 0 rows).
SELECT telegram_source_id, external_message_id, count(*) FROM telegram_messages GROUP BY 1,2 HAVING count(*) > 1;
-- 4) Row counts for scale/lock estimate.
SELECT (SELECT count(*) FROM signals) AS signals, (SELECT count(*) FROM signal_validations) AS validations;
