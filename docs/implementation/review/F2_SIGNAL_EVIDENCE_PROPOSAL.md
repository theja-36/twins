# F2 - `signal_evidence` duplicate links: impact analysis and fix (PROMOTED to the main working tree on 2026-10-19 after the scratch rehearsal; migration NOT applied to twins_ci / twins_dev)

## 1. Observed (read-only queries, 2026-10-19) vs hypotheses
**Schema:** `signal_evidence(id PK, signal_id FK->signals ON DELETE CASCADE, evidence_kind enum, market_observation_id FK, macro_observation_id FK, news_evidence_id FK, created_at)`; two CHECKs force exactly one reference column to be set and to match `evidence_kind`; FKs to the observation tables are `ON DELETE RESTRICT`; indexes: PK and `signal_evidence_signal_idx(signal_id)` only. **No unique constraint. Nothing references `signal_evidence.id`** (0 inbound foreign keys).
**Writer:** only `linkEvidenceOnce()` (`packages/signals/src/intelligence.ts:23-47`): SELECT, then INSERT if absent (check-then-insert, no transaction, no `ON CONFLICT`).
**Readers (production code): none.** `grep` finds `signalEvidence` only in that writer and in tests. The Phase 8 engine builds evidence from the gathered contexts (market/macro/news objects), thesis/decision `evidenceIds` come from those same objects, and `GET /signals/:id/validation` reads `signal_validations` only.
**Duplicates found (counts of rows/groups; ids truncated, no payloads):**
| Database | links | logical links | duplicate groups | surplus rows | max copies | max spread |
|---|---|---|---|---|---|---|
| twins_dev | 1146 | 1145 | 1 | 1 | 2 | 1 ms |
| twins_ci | 1559 | 1456 | 43 | 103 | 4 | 28 ms |
| twins_rehearsal_fresh | 166 | 138 | 12 | 28 | 4 | 15 ms |
| twins_rehearsal_upgrade (and the retained restore/backup) | 19 | 12 | 3 | 7 | 4 | 3 ms |
Representative groups: `signal 4c3b06ca | macro_observation | ref 0cf503ca | 4 copies | 1 ms`; `signal 1bc1e828 | market_observation | ref 7459dd62 | 4 copies | 2 ms`. In every database, **0 groups differ in any column other than `id`/`created_at`** (checked with `count(DISTINCT (market_observation_id, macro_observation_id, news_evidence_id))`), and copies are written within milliseconds of each other: they are **identical logical links created by concurrent callers** (the barrier tests use N=3-4 concurrent validators; max copies equals N), not distinct versions or roles. No sequential re-run produced a duplicate in the existing idempotency tests.
**Effect on downstream analysis:**
| Question | Finding | Basis |
|---|---|---|
| Evidence counts | None today: no code counts `signal_evidence` rows | code inspection (no reader) |
| Scores / thesis factors | None: factors and `evidenceIds` come from context objects, not from the link table | code inspection |
| Confidence / probability labels | None | same |
| Audit rendering / lineage queries | **Yes, hypothetical today:** any future lineage view or report that lists or counts links would show up to N copies of the same evidence | hypothesis (no such reader exists) |
So the demonstrated impact is **data-integrity/audit only**; no decision was changed by the duplicates. It nevertheless violates the stated intent ("one link per evidence"), contradicts the idempotency tests' claim under concurrency, and would become a counting defect the first time anything reads the table.

## 2. Evidence-link business identity
A link means "signal S used evidence row E". Because exactly one reference column is non-null and `evidence_kind` is derived from it, the identity is **(signal_id, referenced evidence row id)** within a kind: `(signal_id, market_observation_id)` or `(signal_id, macro_observation_id)` or `(signal_id, news_evidence_id)`. There is no role/version column, so one link per pair is the intended meaning. Distinct versions of evidence have distinct observation ids (observations are immutable rows), so legitimate new evidence for the same signal creates a different pair; the same evidence row linked to another signal is a different pair; the same signal with another kind is a different pair.
**NULL behaviour (PostgreSQL 16.15 here):** NULLs are distinct in unique indexes, so a single plain `UNIQUE (signal_id, market_observation_id, macro_observation_id, news_evidence_id)` would never reject anything (every row has two NULLs). Options: `UNIQUE NULLS NOT DISTINCT` (PG15+) or **three partial unique indexes** (portable; chosen).

## 2b. Key verification against the existing constraints (current tree)
`signal_evidence_exactly_one_reference` makes exactly one of `market_observation_id`, `macro_observation_id`, `news_evidence_id` non-null in every row; `signal_evidence_kind_matches_reference` ties `evidence_kind` to whichever column is set. Therefore (a) the three partial predicates (`<ref> IS NOT NULL`) are mutually exclusive and together cover every valid row, so each row falls under exactly one index and none escapes uniqueness; (b) `evidence_kind` is implied by the column and need not be part of the key; (c) a plain composite `UNIQUE(signal_id, market, macro, news)` would be useless because the two NULL columns make every row distinct (the rehearsal re-demonstrates this on the actual server with TEMP tables inside a rolled-back transaction). The three indexes, exactly as in the 0005 draft:
```sql
CREATE UNIQUE INDEX "signal_evidence_signal_market_unique" ON "signal_evidence" USING btree ("signal_id","market_observation_id") WHERE "signal_evidence"."market_observation_id" is not null;
CREATE UNIQUE INDEX "signal_evidence_signal_macro_unique"  ON "signal_evidence" USING btree ("signal_id","macro_observation_id")  WHERE "signal_evidence"."macro_observation_id" is not null;
CREATE UNIQUE INDEX "signal_evidence_signal_news_unique"   ON "signal_evidence" USING btree ("signal_id","news_evidence_id")     WHERE "signal_evidence"."news_evidence_id" is not null;
```

## 3. Proposed minimal change
- **Migration 0005 (draft, unapplied):** `docs/implementation/review/f2/drizzle-0005-draft/` (SQL, snapshot, draft journal). It only adds `signal_evidence_signal_market_unique`, `..._macro_unique`, `..._news_unique` (`UNIQUE (signal_id, <ref>) WHERE <ref> IS NOT NULL`). Generated with drizzle-kit in a scratch copy against snapshot 0004; migration 0004 and its snapshot are byte-identical to the originals; the 0005 snapshot differs from 0004's only by the three indexes. The in-repo `schema/signals.ts` and the real journal are NOT edited yet (`proposed_schema_signals.patch` shows the schema change), so the working tree stays consistent with its migrations until you approve.
- **Code (`proposed_intelligence.patch`, unapplied):** keep the existing SELECT fast path and add `.onConflictDoNothing()` to the insert. Before 0005 this behaves exactly as today; after 0005 the index is the correctness boundary and a concurrent loser simply finds the link present. (My first draft removed the SELECT; that was wrong, because without the index it would insert duplicates on every sequential re-run - corrected.)
- **Retry/partial failure:** each link is an independent idempotent statement; a crash or error midway leaves a subset of links, and re-running `assembleSignalIntelligence` inserts only the missing ones (conflicts ignored). No transaction or lock is added.
- **Not claimed:** exactly-once delivery; this makes the *link set* idempotent, nothing more.

## 4. Tests - claims match the implementation (`review/f2/evidenceLinks.test.ts.txt`, copied only into the rehearsal's patched copy)
1. **Database level, per kind (market, macro, news):** a second identical link is rejected with `23505`; `ON CONFLICT DO NOTHING` inserts nothing; exactly one link per kind remains.
2. **Legitimately distinct evidence stays distinct:** the same signal linked to an older and a newer market observation (two evidence rows), two macro rows and a news row (5 links); the same evidence row linked to a second signal; all accepted, none merged.
3. **Concurrency:** 4 concurrent calls of the production writer (`buildSignalIntelligence`), held at a barrier before each of their three link INSERTs (market + two macro), produce exactly one link per gathered evidence row and no rejected caller. Run once WITHOUT the index as a negative control: it must fail with `SIGNAL_EVIDENCE_DUPLICATES` (and the rehearsal then shows the surplus rows being remediated and the index applied).
4. **Retry / partial failure:** an injected failure before the second link insert leaves exactly the first link; a retry and a repeat converge to the three expected links, the first link row is reused (same id), nothing is duplicated.
**Deliberately NOT tested:** any effect on scores, theses, confidence or decisions. `signal_evidence` is not read by production analysis (code inspection, section 1), so there is no such effect to test; a test asserting it would merely restate that fact. The claim is limited to link-set integrity.
Existing tests that remain relevant and are run in the rehearsal: `tests/integration/signals/*` ("is idempotent" cases) and `tests/integration/runtime/*`.

## 5. Preflight and remediation (nothing run beyond SELECT/EXPLAIN)
`R0B_0005_preflight.sql` (read-only; validated on twins_dev, twins_ci, twins_rehearsal_upgrade), `R0B_0005_remediation_PROPOSAL.sql` (export, then a single-transaction DELETE of every row after the earliest per logical link; copies differ only in id/created_at; nothing references the table). **No existing database is remediated or modified under this plan.** twins_ci (103 surplus rows / 43 groups) and twins_dev (1 row) would need separately approved remediation before 0005 could ever be applied to them.

## 6. Scratch rehearsal - `rehearsal_f2_PLAN.sh` (the exact block shown to the owner for approval)
Guard: the rehearsal guard now accepts an EXACT list of four database names (`tests/integration/runtime/rehearsalTargets.ts`, mirrored in `migrate-folder.mjs` and checked by a unit test), only on the loopback test Postgres 127.0.0.1:15432 as user `twins`, only with the test Redis 127.0.0.1:16379 and `LIVE_TRADING=false`. Arbitrary rehearsal names, `twins_dev`, `twins_ci`, other hosts/ports/users/Redis are rejected (full accept/reject matrix executed).
Patched copy: `$S/f2-rehearsal/tree` = rsync of the current working tree (including the completed F1/T1/T6 changes; excluding node_modules, .git, dist, tsbuildinfo, reports, evidence) plus exactly six differences: the two product patches, the 0005 SQL, the 0005 snapshot, the draft journal and the evidence-link test; the script asserts that list and that migration 0004 and its snapshot are byte-identical. The main tree is hashed before and after.
Databases created: `twins_rehearsal_f2_upgrade` (restored from the checksum-verified retained archive: 3 duplicate groups / 7 surplus rows) and `twins_rehearsal_f2_fresh`. Sequence: negative control on the upgrade copy (patched writer, no index -> duplicates, 16 surplus) -> apply 0005 with duplicates (expected unique-index failure + rollback assertions) -> export 16 rows -> remediation `DELETE 16` -> apply 0005 -> tests; fresh chain -> NULL-semantics probe -> tests. Side effects: two new databases, scratchpad files, test rows in those two databases; no cleanup included.

## 7. Owner approvals needed for F2
(a) run exactly the block in `rehearsal_f2_PLAN.sh`; (b) after a green rehearsal and review of the logs, approve promoting the schema patch, 0005 files, writer patch and the evidence-link test into the working tree; (c) separately, remediation (or recreation) of twins_ci and twins_dev. F1 independent review is unrelated to these approvals and remains open.
