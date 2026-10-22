-- APPLY (separately approved step; metadata only - telegram_sources is mutable, raw messages are never touched).
-- Sets chat_id ONLY for classification = 'recoverable'. Ambiguous/conflicting/unrecoverable sources stay NULL and unmerged.
BEGIN;
CREATE TEMP VIEW source_chat_candidates AS
WITH payload AS (
  SELECT telegram_source_id AS sid,
         coalesce(raw_payload#>>'{message,chat,id}', raw_payload#>>'{channel_post,chat,id}',
                  raw_payload#>>'{edited_message,chat,id}', raw_payload#>>'{edited_channel_post,chat,id}') AS cid
  FROM telegram_messages),
per_source AS (
  SELECT sid, count(DISTINCT cid) AS n_ids, min(cid) AS cid, bool_or(cid IS NULL) AS has_missing FROM payload GROUP BY sid),
cand AS (
  SELECT s.id, s.channel_identifier,
         ps.n_ids, ps.cid AS payload_chat_id, ps.has_missing,
         substring(s.channel_identifier from '^tg_chat_(-?[0-9]+)$') AS name_chat_id,
         CASE WHEN ps.n_ids = 1 AND NOT ps.has_missing THEN ps.cid
              WHEN coalesce(ps.n_ids, 0) = 0 THEN substring(s.channel_identifier from '^tg_chat_(-?[0-9]+)$') END AS candidate
  FROM telegram_sources s LEFT JOIN per_source ps ON ps.sid = s.id
  WHERE s.chat_id IS NULL)
SELECT c.*,
  (SELECT count(*) FROM cand o WHERE o.candidate = c.candidate) AS sources_sharing_candidate,
  EXISTS (SELECT 1 FROM telegram_sources t WHERE t.chat_id = c.candidate) AS candidate_already_assigned,
  CASE
    WHEN c.n_ids > 1 THEN 'conflicting_payload_chat_ids'
    WHEN c.n_ids = 1 AND c.has_missing THEN 'partial_payloads_unrecoverable'
    WHEN c.name_chat_id IS NOT NULL AND c.payload_chat_id IS NOT NULL AND c.name_chat_id <> c.payload_chat_id THEN 'name_payload_mismatch'
    WHEN c.candidate IS NULL THEN 'unrecoverable_no_chat_id'
    WHEN (SELECT count(*) FROM cand o WHERE o.candidate = c.candidate) > 1 THEN 'ambiguous_shared_chat_id'
    WHEN EXISTS (SELECT 1 FROM telegram_sources t WHERE t.chat_id = c.candidate) THEN 'ambiguous_already_assigned'
    ELSE 'recoverable'
  END AS classification
FROM cand c;
UPDATE telegram_sources s SET chat_id = c.candidate, updated_at = now()
FROM source_chat_candidates c WHERE c.id = s.id AND c.classification = 'recoverable' AND s.chat_id IS NULL;
SELECT 'sources updated' AS result, count(*) FROM telegram_sources WHERE chat_id IS NOT NULL;
COMMIT;
