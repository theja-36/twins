-- PROPOSAL ONLY - NOT EXECUTED. For scratch rehearsal first; any real database needs separate approval.
-- Preconditions (checked by R0B_0005_preflight.sql 3 and 4): duplicate groups are identical in every column except
-- id/created_at, and no foreign key references signal_evidence. Survivor rule is therefore deterministic, not arbitrary:
-- keep the EARLIEST link per logical link (created_at, then id), i.e. the first write; later copies add no information.
-- Step 1 (audit provenance): export the rows that will be removed BEFORE deleting, e.g. in psql:
--   \copy (SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY signal_id, evidence_kind, market_observation_id, macro_observation_id, news_evidence_id ORDER BY created_at, id) rn FROM signal_evidence) t WHERE rn > 1) TO '<removed_rows.csv>' CSV HEADER
-- Step 2 (single transaction; verify the surplus count equals the preflight surplus before COMMIT):
BEGIN;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY signal_id, evidence_kind, market_observation_id, macro_observation_id, news_evidence_id ORDER BY created_at, id) AS rn
  FROM signal_evidence)
DELETE FROM signal_evidence s USING ranked r WHERE s.id = r.id AND r.rn > 1;
-- expect: DELETE <surplus_rows from preflight>; then re-run preflight 1 -> 0 rows; COMMIT (or ROLLBACK if counts differ)
COMMIT;
