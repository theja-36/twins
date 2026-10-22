-- Controlled LEGACY fixtures for the pre-0004 schema. Load ONLY into twins_rehearsal_upgrade.
-- Fixed UUIDs make remediation and assertions exact. Synthetic data only.
BEGIN;
INSERT INTO telegram_sources (id, channel_identifier) VALUES
 ('00000000-0000-4000-8000-0000000000a0', '@legacy_rehearsal'),     -- recoverable: all payloads carry chat -100111
 ('00000000-0000-4000-8000-0000000000a1', '@legacy_dup_a'),         -- payload chat -100222, shared with a2 -> AMBIGUOUS (rename/merge-by-guess case)
 ('00000000-0000-4000-8000-0000000000a2', '@legacy_dup_b'),         -- payload chat -100222
 ('00000000-0000-4000-8000-0000000000a3', '@legacy_nopayload'),     -- empty payload -> UNRECOVERABLE
 ('00000000-0000-4000-8000-0000000000a4', 'tg_chat_-100333'),       -- legacy fallback name encodes the id; payload agrees -> recoverable
 ('00000000-0000-4000-8000-0000000000a5', '@legacy_conflict');      -- payloads disagree (-100444 vs -100555) -> CONFLICTING
INSERT INTO instruments (id, symbol, exchange, instrument_type) VALUES
 ('00000000-0000-4000-8000-0000000000b0', 'TCS', 'NSE', 'equity');
INSERT INTO telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text, raw_payload) VALUES
 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a0', '1001',      '2026-01-01T10:00:00Z', 'BUY TCS @ 3500 SL 3450 TGT 3600', '{"update_id":1,"channel_post":{"message_id":1001,"date":1767261600,"chat":{"id":-100111,"type":"channel","username":"legacy_rehearsal"},"text":"BUY TCS @ 3500 SL 3450 TGT 3600"}}'),
 ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000a0', '1001_edit', '2026-01-01T10:00:00Z', 'BUY TCS @ 3510 SL 3460 TGT 3610', '{"update_id":2,"edited_channel_post":{"message_id":1001,"date":1767261600,"edit_date":1767262000,"chat":{"id":-100111,"type":"channel","username":"legacy_rehearsal"},"text":"BUY TCS @ 3510 SL 3460 TGT 3610"}}'),
 ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000a0', '1002',      '2026-01-01T11:00:00Z', 'BUY TCS @ 3520 SL 3470 TGT 3620', '{"update_id":3,"channel_post":{"message_id":1002,"date":1767265200,"chat":{"id":-100111,"type":"channel"},"text":"BUY TCS @ 3520 SL 3470 TGT 3620"}}'),
 ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000a0', '1003',      '2026-01-01T12:00:00Z', 'SELL TCS @ 3400 SL 3450 TGT 3300', '{"update_id":4,"channel_post":{"message_id":1003,"date":1767268800,"chat":{"id":-100111,"type":"channel"},"text":"SELL TCS @ 3400 SL 3450 TGT 3300"}}'),
 ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000a1', '1', '2026-01-02T10:00:00Z', 'noise', '{"update_id":5,"channel_post":{"message_id":1,"date":1,"chat":{"id":-100222,"type":"channel","username":"legacy_dup_a"},"text":"noise"}}'),
 ('00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-0000000000a2', '1', '2026-01-02T10:00:00Z', 'noise', '{"update_id":6,"channel_post":{"message_id":1,"date":1,"chat":{"id":-100222,"type":"channel","username":"legacy_dup_b"},"text":"noise"}}'),
 ('00000000-0000-4000-8000-0000000000c7', '00000000-0000-4000-8000-0000000000a3', '1', '2026-01-02T10:00:00Z', 'noise', '{}'),
 ('00000000-0000-4000-8000-0000000000c8', '00000000-0000-4000-8000-0000000000a4', '1', '2026-01-02T10:00:00Z', 'noise', '{"update_id":8,"message":{"message_id":1,"date":1,"chat":{"id":-100333,"type":"channel"},"text":"noise"}}'),
 ('00000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-0000000000a5', '1', '2026-01-02T10:00:00Z', 'noise', '{"update_id":9,"channel_post":{"message_id":1,"date":1,"chat":{"id":-100444,"type":"channel"},"text":"noise"}}'),
 ('00000000-0000-4000-8000-0000000000ca', '00000000-0000-4000-8000-0000000000a5', '2', '2026-01-02T10:00:00Z', 'noise', '{"update_id":10,"channel_post":{"message_id":2,"date":1,"chat":{"id":-100555,"type":"channel"},"text":"noise"}}');
-- s1: clean legacy signal+validation. s2: legacy edit row. s3a/s3b: DUPLICATE signals for message 1002 (the race artifact). s4: clean.
INSERT INTO signals (id, source_type, telegram_message_id, instrument_id, direction, entry_price, status, signal_timestamp) VALUES
 ('00000000-0000-4000-8000-0000000000d1', 'telegram', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b0', 'buy',  3500, 'decided', '2026-01-01T10:00:00Z'),
 ('00000000-0000-4000-8000-0000000000d2', 'telegram', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b0', 'buy',  3510, 'decided', '2026-01-01T10:00:00Z'),
 ('00000000-0000-4000-8000-0000000000d3', 'telegram', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000b0', 'buy',  3520, 'decided', '2026-01-01T11:00:00Z'),
 ('00000000-0000-4000-8000-0000000000d4', 'telegram', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000b0', 'buy',  3520, 'decided', '2026-01-01T11:00:00Z'),
 ('00000000-0000-4000-8000-0000000000d5', 'telegram', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000b0', 'sell', 3400, 'decided', '2026-01-01T12:00:00Z');
INSERT INTO signal_validations (id, signal_id, outcome, decision_confidence, confidence_label, bull_thesis, bear_thesis, counter_thesis, counter_thesis_severity, source_reliability, source_reliability_reason, rationale)
SELECT ('00000000-0000-4000-8000-0000000000e' || n)::uuid, ('00000000-0000-4000-8000-0000000000d' || n)::uuid,
       'INSUFFICIENT_EVIDENCE', 0, 'legacy fixture', '{}', '{}', '{}', 'low', 'UNKNOWN', 'legacy fixture', 'legacy fixture'
FROM generate_series(1,5) AS n;
COMMIT;
