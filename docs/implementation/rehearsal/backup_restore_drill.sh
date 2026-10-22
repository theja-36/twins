#!/usr/bin/env bash
# LOCAL logical backup/restore drill (pg_dump -Fc / pg_restore). NOT executed until approved.
# Source: twins_rehearsal_upgrade (read only). Target: NEW database twins_restore_drill.
# Writes only: the new database, and files under $DRILL. No cleanup of any kind is performed here.
set -u -o pipefail
cd /Users/sara/twins
S=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad
DRILL=$S/backup-drill; L=$DRILL/logs; mkdir -p "$L"
SRC=twins_rehearsal_upgrade; DST=twins_restore_drill
DUMP=$DRILL/$SRC.dump
D=docs/implementation/rehearsal
PG_BASE='postgresql://twins:twins_dev_password@127.0.0.1:15432'   # test-only credentials; never printed or logged
export LIVE_TRADING=false

fail() { echo "STOP: $1"; echo "Preserved: $DST (if created), $DUMP, logs in $L. Nothing cleaned up."; exit 1; }
now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
dur() { python3 -c "print(f'{$2-$1:.3f}')"; }
val()  { docker exec twins-postgres-test psql -U twins -d "$1" -Atc "$2"; }
ro()   { docker exec -i -e "PGOPTIONS=-c default_transaction_read_only=on" twins-postgres-test psql -U twins -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
step() { local n=$1; shift; echo "== $n"; "$@" >"$L/$n.txt" 2>&1; local rc=$?; echo "$n exit=$rc" | tee -a "$L/exit_codes.txt"; [ $rc -eq 0 ] || { tail -n 20 "$L/$n.txt"; fail "$n exited $rc"; }; }
check() { [ "$2" = "$3" ] && echo "OK   $1 = $3" || fail "$1: expected [$2] got [$3]"; }
: > "$L/exit_codes.txt"

echo "== 0. preflight (read-only)"
[ -z "$(val postgres "select 1 from pg_database where datname='$DST'")" ] || fail "$DST already exists; refusing to reuse"
[ -n "$(val postgres "select 1 from pg_database where datname='$SRC'")" ] || fail "source $SRC missing"
check "source owner" "twins" "$(val postgres "select pg_get_userbyid(datdba) from pg_database where datname='$SRC'")"
check "active connections to source" "0" "$(val postgres "select count(*) from pg_stat_activity where datname='$SRC'")"
[ ! -e "$DUMP" ] || fail "$DUMP already exists; refusing to overwrite"
for db in twins_dev twins_ci twins_rehearsal_fresh twins_rehearsal_upgrade; do
  echo "$db $(val $db "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)||'/'||(select count(*) from telegram_messages)")"
done | tee "$L/baseline_other_dbs_before.txt"

echo "== 1. source fingerprint BEFORE dump"
ro $SRC < $D/drill_fingerprint.sql > "$L/fingerprint_source_before.txt" 2>"$L/fingerprint_source_before.err" || fail "fingerprint (source, before)"
DATABASE_URL="$PG_BASE/$SRC" npx tsx $D/drill_revision_states.mjs > "$L/revisions_source_before.txt" 2>"$L/revisions_source_before.err" || fail "revision states (source, before)"

echo "== 2. dump (custom format, compressed, consistent snapshot)"
T0=$(now)
docker exec twins-postgres-test pg_dump -U twins -d $SRC -Fc --lock-wait-timeout=10000 > "$DUMP" 2>"$L/pg_dump.err"; rc=$?
T1=$(now); echo "pg_dump exit=$rc" | tee -a "$L/exit_codes.txt"; [ $rc -eq 0 ] || fail "pg_dump exited $rc"
echo "dump_seconds=$(dur $T0 $T1)" | tee "$L/durations.txt"
[ -s "$DUMP" ] || fail "dump file is empty"
echo "dump_bytes=$(wc -c < "$DUMP" | tr -d ' ')" | tee -a "$L/durations.txt"
shasum -a 256 "$DUMP" | sed "s#$DRILL/##" | tee "$L/dump.sha256"
docker exec -i twins-postgres-test pg_restore -l < "$DUMP" > "$L/dump_toc.txt" 2>"$L/dump_toc.err" || fail "pg_restore -l could not read the archive"
check "TOC TABLE DATA entries" "32" "$(grep -c ' TABLE DATA ' "$L/dump_toc.txt")"
for ix in signals_telegram_message_parser_unique signal_validations_idempotency_key_unique telegram_sources_chat_id_unique telegram_messages_origin_idx; do
  grep -q " $ix " "$L/dump_toc.txt" || fail "TOC lacks index $ix"
done
echo "TOC contains the four 0004 indexes"

echo "== 3. source unchanged during dump window?"
ro $SRC < $D/drill_fingerprint.sql > "$L/fingerprint_source_after.txt" 2>>"$L/fingerprint_source_before.err" || fail "fingerprint (source, after)"
cmp -s "$L/fingerprint_source_before.txt" "$L/fingerprint_source_after.txt" || fail "source fingerprint changed during the dump window"
echo "source fingerprint identical before/after dump"

echo "== 4. create target and restore (no --clean, no --create; single transaction; stop on first error)"
T2=$(now)
docker exec twins-postgres-test createdb -U twins -O twins -T template0 $DST > "$L/createdb.txt" 2>&1 || fail "createdb $DST"
echo "createdb exit=0" | tee -a "$L/exit_codes.txt"
docker exec -i twins-postgres-test pg_restore -U twins -d $DST --exit-on-error --single-transaction < "$DUMP" > "$L/pg_restore.txt" 2>&1; rc=$?
T3=$(now); echo "pg_restore exit=$rc" | tee -a "$L/exit_codes.txt"; [ $rc -eq 0 ] || { tail -n 20 "$L/pg_restore.txt"; fail "pg_restore exited $rc"; }
echo "restore_seconds=$(dur $T2 $T3) (includes createdb)" | tee -a "$L/durations.txt"

echo "== 5. verify restored contents (read-only; NO application writes yet)"
ro $DST < $D/drill_fingerprint.sql > "$L/fingerprint_restore.txt" 2>"$L/fingerprint_restore.err" || fail "fingerprint (restore)"
diff "$L/fingerprint_source_before.txt" "$L/fingerprint_restore.txt" > "$L/fingerprint_diff.txt" || { head -n 40 "$L/fingerprint_diff.txt"; fail "restored fingerprint differs from source (see fingerprint_diff.txt)"; }
echo "fingerprint (settings, columns, indexes, constraints, owners, ACLs, sequence, migration tracking, 0004 structures, business facts, per-table counts + content hashes) IDENTICAL"
# schema-only dumps compared too (owners included); the random \restrict/\unrestrict tokens of recent pg_dump releases are filtered
# original schema-only dumps are kept untouched (*_raw.sql); only the documented nondeterministic
# \restrict/\unrestrict token lines are removed for the comparison copies (*_normalized.sql)
for db in $SRC $DST; do
  docker exec twins-postgres-test pg_dump -U twins -d $db -s > "$L/schema_${db}_raw.sql" 2>"$L/schema_${db}.err" || fail "schema dump $db"
  grep -v -E '^\\(un)?restrict ' "$L/schema_${db}_raw.sql" > "$L/schema_${db}_normalized.sql"
  echo "$db: raw lines=$(wc -l < "$L/schema_${db}_raw.sql" | tr -d ' ') normalized lines=$(wc -l < "$L/schema_${db}_normalized.sql" | tr -d ' ') removed=$(grep -c -E '^\\(un)?restrict ' "$L/schema_${db}_raw.sql")" | tee -a "$L/schema_normalization.txt"
done
diff "$L/schema_${SRC}_raw.sql" "$L/schema_${DST}_raw.sql" > "$L/schema_diff_raw.txt"   # informational: expected to differ only in restrict tokens
diff "$L/schema_${SRC}_normalized.sql" "$L/schema_${DST}_normalized.sql" > "$L/schema_diff_normalized.txt" || { head -n 40 "$L/schema_diff_normalized.txt"; fail "schema-only dumps differ"; }
echo "schema-only dumps IDENTICAL after removing only the restrict-token lines"
DATABASE_URL="$PG_BASE/$DST" npx tsx $D/drill_revision_states.mjs > "$L/revisions_restore.txt" 2>"$L/revisions_restore.err" || fail "revision states (restore)"
cmp -s "$L/revisions_source_before.txt" "$L/revisions_restore.txt" || fail "revision currentness differs after restore"
echo "revision currentness classification IDENTICAL ($(wc -l < "$L/revisions_restore.txt" | tr -d ' ') message rows)"
check "restore owner" "twins" "$(val postgres "select pg_get_userbyid(datdba) from pg_database where datname='$DST'")"
check "table count in restore" "32" "$(val $DST "select count(*) from pg_tables where schemaname in ('public','drizzle')")"

echo "== 6. other databases unchanged"
for db in twins_dev twins_ci twins_rehearsal_fresh twins_rehearsal_upgrade; do
  echo "$db $(val $db "select (select count(*) from signals)||'/'||(select count(*) from signal_validations)||'/'||(select count(*) from telegram_messages)")"
done > "$L/baseline_other_dbs_after.txt"
cmp -s "$L/baseline_other_dbs_before.txt" "$L/baseline_other_dbs_after.txt" || fail "another database changed"
echo "twins_dev, twins_ci and both rehearsal databases unchanged"
echo "ALL STEPS PASSED (local logical backup/restore drill). Nothing cleaned up."
