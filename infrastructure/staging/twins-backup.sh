#!/usr/bin/env bash
# TWINS staging daily PostgreSQL backup: custom-format dump -> sha256 -> AES-256-GCM encryption (twinsenc.py) -> VERIFY (decrypt, compare, pg_restore --list)
# -> only then remove the plaintext, prune this job's OWN old encrypted files, write the status file. Installed as /usr/local/sbin/twins-backup (root:root 0750)
# and run daily by twins-backup.timer. LOCAL ONLY: the encrypted copies stay on this host (an off-host copy needs the owner's Drive/OAuth setup, see
# docs/implementation/phase0/0C_BACKUP_AND_MONITORING_DESIGN.md). Nothing here reads, prints or copies the key; it is only passed to twinsenc.py as a path.
#   twins-backup            run one backup
#   twins-backup --status   print the last status; exit 0 only if it succeeded and is younger than 26 hours
# Every external command and path can be overridden by the environment (used by the tests).
set -euo pipefail
umask 077
BACKUP_DIR="${BACKUP_DIR:-/opt/twins-staging/backups}"
KEY_FILE="${KEY_FILE:-/root/twins-offsite-keys/twins-staging-offsite-00fd8fc3.key}"
ENC_TOOL="${ENC_TOOL:-/opt/twins-staging/offsite/twinsenc.py}"
STATUS_DIR="${STATUS_DIR:-/var/lib/twins-monitor}"
LOCK_FILE="${LOCK_FILE:-/run/twins-backup.lock}"
MIN_FREE_KB="${MIN_FREE_KB:-5242880}"   # 5 GiB
KEEP="${KEEP:-7}"                       # encrypted daily files kept by this job
FLOOR="${FLOOR:-3}"                     # pruning never leaves fewer than this many
DOCKER="${DOCKER:-docker}"
PYTHON="${PYTHON:-python3}"
PG_CONTAINER="${PG_CONTAINER:-twins-staging-postgres-1}"
STATUS="$STATUS_DIR/backup.json"
MAX_AGE_SECONDS=$((26 * 3600))

write_status() { # $1 ok(true|false) $2 step-or-file $3 extra-json-fields (may be empty)
  mkdir -p "$STATUS_DIR"; chmod 700 "$STATUS_DIR"
  local tmp; tmp="$(mktemp "$STATUS_DIR/.backup.json.XXXXXX")"
  printf '{"ok":%s,"ts":"%s","epoch":%s,"detail":"%s"%s}\n' "$1" "$(date -u +%FT%TZ)" "$(date +%s)" "$2" "${3:+,$3}" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$STATUS"
}

if [ "${1:-}" = "--status" ]; then
  [ -r "$STATUS" ] || { echo "no status file: no backup has run"; exit 1; }
  cat "$STATUS"
  ok="$(grep -c '"ok":true' "$STATUS" || true)"
  epoch="$(sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' "$STATUS")"
  [ "$ok" = 1 ] && [ -n "$epoch" ] && [ $(( $(date +%s) - epoch )) -le "$MAX_AGE_SECONDS" ] || { echo "STALE OR FAILED"; exit 1; }
  exit 0
fi

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another backup is running"; exit 75; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAIN="$BACKUP_DIR/twins-staging-daily-$STAMP.dump"
ENC="$PLAIN.enc"
VERIFY_TMP="$BACKUP_DIR/.verify-$STAMP.tmp"
STEP="start"
cleanup() { local f; for f in "$PLAIN.partial" "$PLAIN" "$PLAIN.sha256" "$VERIFY_TMP"; do if [ -e "$f" ]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi; done; return 0; }
# The failure handler must itself never abort (set -e is active in traps): it removes plaintext, drops a half-made encrypted file and ALWAYS writes the failure status,
# otherwise a failed run would leave the previous "ok" status in place.
on_exit() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ]; then
    cleanup
    if [ -e "$ENC" ] && [ "${KEEP_ENC_ON_FAIL:-0}" != 1 ]; then rm -f "$ENC" "$ENC.sha256"; fi
    write_status false "failed at step: $STEP" ""
    echo "BACKUP FAILED at step: $STEP" >&2
  fi
  return "$rc"
}
trap on_exit EXIT

STEP="disk space"
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}')"
[ "${free_kb:-0}" -ge "$MIN_FREE_KB" ] || { echo "free space ${free_kb} KB < ${MIN_FREE_KB} KB" >&2; exit 2; }
[ -f "$KEY_FILE" ] && [ -f "$ENC_TOOL" ] || { echo "key or encryption tool missing" >&2; STEP="key/tool present"; exit 2; }

STEP="pg_dump"
"$DOCKER" exec "$PG_CONTAINER" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$PLAIN.partial"
[ -s "$PLAIN.partial" ] || { echo "empty dump" >&2; exit 3; }
mv "$PLAIN.partial" "$PLAIN"
STEP="sha256 of the plaintext"
PLAIN_SHA="$(sha256sum "$PLAIN" | cut -c1-64)"
echo "$PLAIN_SHA  $(basename "$PLAIN")" > "$PLAIN.sha256"
STEP="encrypt"
"$PYTHON" "$ENC_TOOL" encrypt "$KEY_FILE" "$PLAIN" "$ENC"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$ENC")" > "$(basename "$ENC").sha256" )
STEP="verify: decrypt"
"$PYTHON" "$ENC_TOOL" decrypt "$KEY_FILE" "$ENC" "$VERIFY_TMP"
STEP="verify: decrypted == original"
[ "$(sha256sum "$VERIFY_TMP" | cut -c1-64)" = "$PLAIN_SHA" ] || { echo "decrypted content differs from the dump" >&2; exit 4; }
STEP="verify: pg_restore --list"
TOC="$("$DOCKER" exec -i "$PG_CONTAINER" pg_restore --list < "$VERIFY_TMP")"
# Here-strings, not `printf | grep -q`: under `set -o pipefail` a pipe whose reader (grep -q) exits at the first match makes the writer fail with SIGPIPE once the listing is larger than the pipe
# buffer (64 KiB). That is exactly what happened on 2026-11-02 after migrations 0014-0029 made the restore list bigger: every backup since then "lacked the expected tables" although it did not.
TOC_ENTRIES="$(grep -vc '^;' <<<"$TOC" || true)"
[ "$TOC_ENTRIES" -ge 1 ] && grep -q 'TABLE DATA public telegram_messages' <<<"$TOC" && grep -q 'drizzle __drizzle_migrations' <<<"$TOC" || { echo "restore list lacks the expected tables" >&2; exit 5; }
STEP="remove plaintext"
shred -u "$VERIFY_TMP" "$PLAIN" "$PLAIN.sha256" 2>/dev/null || rm -f "$VERIFY_TMP" "$PLAIN" "$PLAIN.sha256"

STEP="prune"
PRUNED=0
FILES=()
while IFS= read -r f; do [ -n "$f" ] && FILES+=("$f"); done < <(ls -1 "$BACKUP_DIR"/twins-staging-daily-*.dump.enc 2>/dev/null | sort -r)
if [ "${#FILES[@]}" -gt "$KEEP" ] && [ "$KEEP" -ge "$FLOOR" ]; then
  i=0
  for f in "${FILES[@]}"; do i=$((i + 1)); if [ "$i" -gt "$KEEP" ]; then rm -f "$f" "$f.sha256"; PRUNED=$((PRUNED + 1)); fi; done
fi
STEP="status"
ENC_BYTES="$(wc -c < "$ENC" | tr -d ' ')"
write_status true "$(basename "$ENC")" "\"enc_bytes\":$ENC_BYTES,\"plain_sha256\":\"$PLAIN_SHA\",\"toc_entries\":$TOC_ENTRIES,\"kept\":$(( ${#FILES[@]} - PRUNED )),\"pruned\":$PRUNED,\"offhost\":\"not configured (local only)\""
echo "BACKUP OK $(basename "$ENC") ($ENC_BYTES bytes, toc $TOC_ENTRIES, verified; kept $(( ${#FILES[@]} - PRUNED )), pruned $PRUNED)"
