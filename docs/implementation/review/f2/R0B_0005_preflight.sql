-- READ-ONLY preflight for migration 0005 (signal_evidence unique links). Run in a read-only session.
-- 1) logical links that exist more than once (these would make CREATE UNIQUE INDEX fail)
SELECT left(signal_id::text, 8) AS signal, evidence_kind,
       left(coalesce(market_observation_id, macro_observation_id, news_evidence_id)::text, 8) AS ref,
       count(*) AS copies, min(created_at) AS first_at, max(created_at) AS last_at
FROM signal_evidence
GROUP BY signal_id, evidence_kind, market_observation_id, macro_observation_id, news_evidence_id
HAVING count(*) > 1 ORDER BY copies DESC, first_at;
-- 2) summary
SELECT count(*) AS links, count(*) FILTER (WHERE rn > 1) AS surplus_rows FROM (
  SELECT row_number() OVER (PARTITION BY signal_id, evidence_kind, market_observation_id, macro_observation_id, news_evidence_id ORDER BY created_at, id) AS rn FROM signal_evidence) t;
-- 3) safety preconditions for the proposed remediation: duplicates differ ONLY in id/created_at (expect 0 rows)
SELECT signal_id, evidence_kind FROM signal_evidence GROUP BY signal_id, evidence_kind, coalesce(market_observation_id, macro_observation_id, news_evidence_id)
HAVING count(*) > 1 AND count(DISTINCT (market_observation_id, macro_observation_id, news_evidence_id)) > 1;
-- 4) nothing may reference signal_evidence rows (expect 0 rows)
SELECT conrelid::regclass AS referencing_table, conname FROM pg_constraint WHERE contype = 'f' AND confrelid = 'signal_evidence'::regclass;
