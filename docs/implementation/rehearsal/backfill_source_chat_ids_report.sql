-- REPORT (run after migration 0004 added telegram_sources.chat_id). Persists nothing: it only creates a
-- session-scoped TEMP VIEW (a read-only transaction would forbid even that) and runs SELECTs.
-- A legacy source is "recoverable" only when ALL of its stored payloads carry one chat id, that id
-- is not shared with another source and is not already assigned. No username-based merging, ever.
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
SELECT classification, count(*) AS sources FROM source_chat_candidates GROUP BY 1 ORDER BY 2 DESC;
SELECT id, channel_identifier, classification, candidate, n_ids, sources_sharing_candidate FROM source_chat_candidates WHERE classification <> 'recoverable' ORDER BY classification, channel_identifier;
