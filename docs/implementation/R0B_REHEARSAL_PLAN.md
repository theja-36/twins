# R0B Migration 0004 — Scratch Rehearsal Plan, revision 4 (NOT EXECUTED; awaiting approval)

**Authoritative executable form: `docs/implementation/rehearsal/run_rehearsal.sh` (and manual `cleanup_rehearsal.sh`).** The command listings below are the same steps in prose; where they differ, the script wins.

Nothing below has been run. `twins_dev` is never modified; its demonstration duplicates are not deleted.
Migration under rehearsal: `packages/database/drizzle/0004_r0b_idempotency_revisions_identity.sql`.

## Tooling (inspected earlier, read-only)
Container `twins-postgres-test` (postgres:16-alpine, 127.0.0.1:15432) has `psql`, `createdb`, `dropdb`, `pg_dump`. No host PostgreSQL client is needed.

## Resources that would be created
| Resource | Where | Created by | Removed by |
|---|---|---|---|
| database `twins_rehearsal_fresh` | existing container's PostgreSQL | `createdb` | `dropdb` (this name only) |
| database `twins_rehearsal_upgrade` | same | `createdb` | `dropdb` (this name only) |
| folder `$R/pre0004` (copy of HEAD's 0000-0003 migrations) | local scratchpad | `git archive` | `rm -r "$R"` |
| Redis keys `bull:r0b_test_*` | existing test Redis (16379) | integration tests | the tests themselves; verified by SCAN |
No container, image, volume or compose change. Session-scoped TEMP VIEWs exist only for the length of a psql session.

## Environment
```bash
cd /Users/sara/twins
export PG_BASE='postgresql://twins:twins_dev_password@127.0.0.1:15432'
export REDIS_URL='redis://127.0.0.1:16379' LIVE_TRADING=false
export R=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad/rehearsal
export PSQL='docker exec -i twins-postgres-test psql -U twins -v ON_ERROR_STOP=1'
```
Every DB-touching command targets a `*_rehearsal_*` database explicitly. `migrate-folder.mjs` refuses names without "rehearsal". `DATABASE_URL` is always set inline, so tests that fall back to the `twins_dev` default can never use it.

## Baseline guard (read-only, before and after everything)
```bash
node <scratchpad>/pre.mjs        # twins_dev: expect 198 signals / 82 validations, same 2 duplicate groups
docker exec twins-postgres-test psql -U twins -d twins_dev -Atc "select count(*) from information_schema.columns where table_name='signals' and column_name='parser_version'"   # expect 0
```

## A. Fresh-schema rehearsal (modifies ONLY twins_rehearsal_fresh)
```bash
docker exec twins-postgres-test createdb -U twins twins_rehearsal_fresh
DATABASE_URL="$PG_BASE/twins_rehearsal_fresh" npm run db:migrate -w @twins/database          # 0000-0004
DATABASE_URL="$PG_BASE/twins_rehearsal_fresh" npx vitest run --config vitest.integration.config.ts tests/integration/runtime
DATABASE_URL="$PG_BASE/twins_rehearsal_fresh" npm run test:integration
```
Expected: migration applies; all runtime tests pass (concurrency, revisions, e2e, failureHandling); full suite result reported exactly. Every failure is analysed individually (the 5 previously unexplained ones included); none is assumed to be the missing column.

## B. Upgrade rehearsal (modifies ONLY twins_rehearsal_upgrade)
```bash
docker exec twins-postgres-test createdb -U twins twins_rehearsal_upgrade
mkdir -p "$R/pre0004" && git archive HEAD packages/database/drizzle | tar -x -C "$R/pre0004"   # HEAD = exactly 0000-0003
# B1 pre-0004 schema
DATABASE_URL="$PG_BASE/twins_rehearsal_upgrade" node docs/implementation/rehearsal/migrate-folder.mjs "$R/pre0004/packages/database/drizzle"
# B2 controlled legacy fixtures (6 sources, 4 chat-id cases, duplicate signals for message 1002, legacy '_edit' row, keyless validations)
$PSQL -d twins_rehearsal_upgrade < docs/implementation/rehearsal/legacy_pre0004_fixtures.sql
# B3 duplicate preflight (read-only): expect exactly one message (…0c3) with 2 signals
$PSQL -d twins_rehearsal_upgrade -c "BEGIN READ ONLY" -f - < docs/implementation/R0B_0004_preflight.sql
# B4 real chain: EXPECTED TO FAIL on signals_telegram_message_parser_unique (all legacy rows would share 'legacy-unversioned');
#    drizzle runs pending migrations in one transaction, so nothing from 0004 may remain
DATABASE_URL="$PG_BASE/twins_rehearsal_upgrade" npm run db:migrate -w @twins/database ; echo "exit=$?"
$PSQL -d twins_rehearsal_upgrade -Atc "select count(*) from information_schema.columns where column_name in ('parser_version','chat_id','origin_message_id','idempotency_key')"   # expect 0
# B5 remediation IN THE SCRATCH DB ONLY, by exact id (validation cascades)
$PSQL -d twins_rehearsal_upgrade -c "DELETE FROM signals WHERE id='00000000-0000-4000-8000-0000000000d4'"
# B6 apply 0004
DATABASE_URL="$PG_BASE/twins_rehearsal_upgrade" npm run db:migrate -w @twins/database
# B7 chat-id recovery: report first, then apply
$PSQL -d twins_rehearsal_upgrade < docs/implementation/rehearsal/backfill_source_chat_ids_report.sql
#    expected: recoverable=2 (@legacy_rehearsal -100111, tg_chat_-100333), ambiguous_shared_chat_id=2 (@legacy_dup_a/_b),
#              unrecoverable_no_chat_id=1 (@legacy_nopayload), conflicting_payload_chat_ids=1 (@legacy_conflict)
$PSQL -d twins_rehearsal_upgrade < docs/implementation/rehearsal/backfill_source_chat_ids_apply.sql
# B8 legacy-data assertions (read-only)
$PSQL -d twins_rehearsal_upgrade < docs/implementation/rehearsal/upgrade_assertions.sql
# B9 behaviour on the migrated legacy DB
DATABASE_URL="$PG_BASE/twins_rehearsal_upgrade" npx vitest run --config vitest.integration.config.ts tests/integration/runtime
```
Expected B8: `parser_version` = `{legacy-unversioned}` for the 4 remaining signals; all `idempotency_key` NULL; all legacy `origin_message_id` NULL; 0 duplicate signals; `chat_id` set only on the two recoverable sources.
Not verified until run: the migration SQL, the fixtures, and the chat-id report/apply SQL (never executed anywhere; only the TypeScript side is type-checked).

## Cleanup (scope: the two rehearsal databases, the scratch folder, nothing else)
```bash
docker exec twins-postgres-test dropdb -U twins twins_rehearsal_fresh
docker exec twins-postgres-test dropdb -U twins twins_rehearsal_upgrade
rm -r "$R"
REDIS_URL=$REDIS_URL node <scratchpad>/scan.mjs     # SCAN only (no deletion): expect 0 keys for bull:r0b_test_*
node <scratchpad>/pre.mjs                           # twins_dev unchanged
```
`dropdb` is irreversible for those two databases only. If refused due to open connections, stop the test processes first; do not use `--force` without asking.

## Later, on twins_dev (NOT part of this approval)
Needs separate approval after both rehearsals: remediation of the demonstration duplicates (`@r0b_conc_*`), applying 0004, then the chat-id report -> apply. Rollback of 0004 is manual (drop 4 indexes and the 5 added columns, losing their values); the code in this tree writes the new columns and would need reverting too.
