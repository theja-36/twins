#!/usr/bin/env bash
# RESUME of the R0B migration 0004 scratch rehearsal at A3 (fresh DB already created+migrated by the first run).
# R0B migration 0004 scratch rehearsal. Touches ONLY twins_rehearsal_fresh / twins_rehearsal_upgrade
# (read-only SELECTs on twins_dev for the baseline). Stops at the FIRST unexpected result.
# Never cleans up: on any failure databases and logs are preserved for diagnosis.
set -u -o pipefail
cd /Users/sara/twins

R=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad/rehearsal
LOG="$R/logs_resume"   # original failure logs in $R/logs are kept untouched
PG_BASE='postgresql://twins:twins_dev_password@127.0.0.1:15432'
FRESH=twins_rehearsal_fresh
UPGRADE=twins_rehearsal_upgrade
D=docs/implementation/rehearsal
# psql_file <rw|ro> <db> <sqlfile>   /   psql_cmd <rw|ro> <db> "<sql>"   ("ro" forces default_transaction_read_only=on)
psql_run() {
  local mode=$1 db=$2; shift 2
  if [ "$mode" = ro ]; then
    docker exec -i -e "PGOPTIONS=-c default_transaction_read_only=on" twins-postgres-test psql -U twins -v ON_ERROR_STOP=1 -d "$db" "$@"
  else
    docker exec -i twins-postgres-test psql -U twins -v ON_ERROR_STOP=1 -d "$db" "$@"
  fi
}
psql_file() { psql_run "$1" "$2" < "$3"; }
psql_cmd()  { psql_run "$1" "$2" -c "$3"; }

# Every child process (npm, tsx, vitest workers) inherits these; DATABASE_URL is set per command below.
export REDIS_URL='redis://127.0.0.1:16379' LIVE_TRADING=false TWINS_REHEARSAL=1

mkdir -p "$LOG"
fail() { echo "STOP: $1"; echo "Rehearsal databases and logs preserved. Nothing was cleaned up. Logs: $LOG"; exit 1; }
# run <name> <cmd...> : logs to $LOG/<name>.log, stops on non-zero
run() { local n=$1; shift; echo "== $n"; "$@" >"$LOG/$n.log" 2>&1; local rc=$?; tail -n 25 "$LOG/$n.log"; [ $rc -eq 0 ] || fail "$n exited $rc"; }
# check <name> <expected> <actual>
check() { [ "$2" = "$3" ] && echo "OK   $1 = $3" || fail "$1: expected [$2] got [$3]"; }
dbcount() { docker exec twins-postgres-test psql -U twins -d "$1" -Atc "$2"; }

echo "== 0. baseline of twins_dev (read-only SELECTs)"
BASE=$(dbcount twins_dev "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)||'/'||(select count(*) from information_schema.columns where table_name='signals' and column_name='parser_version')")
check "twins_dev signals/validations/parser_version-columns" "198/82/0" "$BASE"

echo "== 1. resume guards"
[ "${TWINS_REHEARSAL:-}" = "1" ] || fail "TWINS_REHEARSAL must be 1"
[ -n "$(dbcount postgres "select 1 from pg_database where datname='$FRESH'")" ] || fail "$FRESH does not exist; cannot resume"
[ -z "$(dbcount postgres "select 1 from pg_database where datname='$UPGRADE'")" ] || fail "$UPGRADE already exists; refusing to continue"
check "resume: fresh applied migrations 0000-0004" "5" "$(dbcount $FRESH 'select count(*) from drizzle.__drizzle_migrations')"
check "resume: fresh has 0004 schema" "1" "$(dbcount $FRESH "select count(*) from information_schema.columns where table_name='signals' and column_name='parser_version'")"
# NOTE: from here the fresh DB is migrated but NOT empty (data from the earlier partial test run is present).
export DATABASE_URL="$PG_BASE/$FRESH"
case "$DATABASE_URL" in *"/$FRESH") ;; *) fail "DATABASE_URL does not target $FRESH" ;; esac

# ---------------- A. fresh schema (resumed) ----------------
run A3_runtime_tests_fresh npx vitest run --config vitest.integration.config.ts tests/integration/runtime
run A4_full_integration_fresh npm run test:integration

# ---------------- B. upgrade from pre-0004 ----------------
run B0_create_upgrade docker exec twins-postgres-test createdb -U twins $UPGRADE
export DATABASE_URL="$PG_BASE/$UPGRADE"
mkdir -p "$R/pre0004"
run B1a_export_pre0004 bash -c "git archive HEAD packages/database/drizzle | tar -x -C '$R/pre0004'"
run B1b_migrate_pre0004 node $D/migrate-folder.mjs "$R/pre0004/packages/database/drizzle"
check "upgrade: pre-0004 migrations" "4" "$(dbcount $UPGRADE 'select count(*) from drizzle.__drizzle_migrations')"
run B2_fixtures psql_file rw $UPGRADE $D/legacy_pre0004_fixtures.sql
check "fixtures signals/validations/sources" "5/5/6" "$(dbcount $UPGRADE "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)||'/'||(select count(*) from telegram_sources)")"
run B3_preflight psql_file ro $UPGRADE docs/implementation/R0B_0004_preflight.sql
grep -q '00000000-0000-4000-8000-0000000000c3' "$LOG/B3_preflight.log" || fail "preflight did not report the fixture duplicate (message ...0c3)"

echo "== B4. real migration: EXPECTED TO FAIL (duplicate legacy signals)"
npm run db:migrate -w @twins/database >"$LOG/B4_migrate_expected_failure.log" 2>&1; rc=$?
tail -n 15 "$LOG/B4_migrate_expected_failure.log"
[ $rc -ne 0 ] || fail "B4 migration unexpectedly SUCCEEDED despite duplicates"
grep -q 'signals_telegram_message_parser_unique' "$LOG/B4_migrate_expected_failure.log" || fail "B4 failed, but not on the expected unique index; inspect log"
# Runner verified: all pending migrations + tracking insert run in ONE transaction (drizzle-orm 0.45.2 pg-core dialect.migrate).
# Only `CREATE SCHEMA/TABLE IF NOT EXISTS drizzle.__drizzle_migrations` happens outside it. Verify nothing partial remained:
check "B4 no 0004 columns remain" "0" "$(dbcount $UPGRADE "select count(*) from information_schema.columns where (table_name='signals' and column_name='parser_version') or (table_name='telegram_sources' and column_name='chat_id') or (table_name='telegram_messages' and column_name in ('origin_message_id','edit_date')) or (table_name='signal_validations' and column_name='idempotency_key')")"
check "B4 no 0004 indexes remain" "0" "$(dbcount $UPGRADE "select count(*) from pg_indexes where indexname in ('signals_telegram_message_parser_unique','signal_validations_idempotency_key_unique','telegram_sources_chat_id_unique','telegram_messages_origin_idx')")"
check "B4 tracking rows unchanged" "4" "$(dbcount $UPGRADE 'select count(*) from drizzle.__drizzle_migrations')"
check "B4 data unchanged (signals/validations)" "5/5" "$(dbcount $UPGRADE "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)")"

echo "== B5. scratch-only remediation of the ONE fixture duplicate (validation cascades)"
run B5_remediate psql_cmd rw $UPGRADE "DELETE FROM signals WHERE id='00000000-0000-4000-8000-0000000000d4'"
check "B5 signals/validations after remediation" "4/4" "$(dbcount $UPGRADE "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)")"

run B6_migrate_upgrade npm run db:migrate -w @twins/database
check "B6 applied migrations" "5" "$(dbcount $UPGRADE 'select count(*) from drizzle.__drizzle_migrations')"
check "B6 parser_version values" "legacy-unversioned" "$(dbcount $UPGRADE "select string_agg(distinct parser_version, ',') from signals")"
check "B6 parser_version default dropped" "" "$(dbcount $UPGRADE "select column_default from information_schema.columns where table_name='signals' and column_name='parser_version'")"
run B7a_chat_report psql_file rw $UPGRADE $D/backfill_source_chat_ids_report.sql
for cls in '^ *recoverable +\| +2' '^ *ambiguous_shared_chat_id +\| +2' '^ *unrecoverable_no_chat_id +\| +1' '^ *conflicting_payload_chat_ids +\| +1'; do
  grep -Eq "$cls" "$LOG/B7a_chat_report.log" || fail "chat report missing expected line /$cls/"
done
run B7b_chat_apply psql_file rw $UPGRADE $D/backfill_source_chat_ids_apply.sql
check "B7 chat_id assigned (a0,a4 only)" "2" "$(dbcount $UPGRADE 'select count(*) from telegram_sources where chat_id is not null')"
run B8_assertions psql_file ro $UPGRADE $D/upgrade_assertions.sql
run B9_runtime_tests_upgrade npx vitest run --config vitest.integration.config.ts tests/integration/runtime

echo "== 9. post-checks"
check "twins_dev unchanged" "198/82/0" "$(dbcount twins_dev "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)||'/'||(select count(*) from information_schema.columns where table_name='signals' and column_name='parser_version')")"
run Z_redis_scan node $D/redis_scan_test_keys.mjs
echo "ALL STEPS PASSED. Nothing was cleaned up. Review logs in $LOG, then run cleanup_rehearsal.sh manually."
