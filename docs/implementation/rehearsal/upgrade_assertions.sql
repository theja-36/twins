-- Read-only assertions after the upgrade rehearsal (twins_rehearsal_upgrade, after 0004 [+ remediation + backfill]).
SELECT 'parser_version values' AS check, array_agg(DISTINCT parser_version) AS value FROM signals;                          -- expect {legacy-unversioned}
SELECT 'null idempotency keys' AS check, count(*) FILTER (WHERE idempotency_key IS NULL) AS nulls, count(*) AS total FROM signal_validations; -- expect nulls = total
SELECT 'legacy origin_message_id NULL' AS check, count(*) FILTER (WHERE origin_message_id IS NULL) AS nulls, count(*) AS total FROM telegram_messages; -- expect nulls = total
SELECT 'dup signals remaining' AS check, count(*) FROM (SELECT telegram_message_id FROM signals GROUP BY 1, parser_version HAVING count(*) > 1) d; -- expect 0 after remediation
SELECT 'chat_id assigned' AS check, channel_identifier, chat_id FROM telegram_sources ORDER BY channel_identifier;            -- after backfill: a0 -100111, a4 -100333; dup_a/dup_b/nopayload/conflict NULL
SELECT 'row counts' AS check, (SELECT count(*) FROM signals) AS signals, (SELECT count(*) FROM signal_validations) AS validations, (SELECT count(*) FROM telegram_sources) AS sources;
