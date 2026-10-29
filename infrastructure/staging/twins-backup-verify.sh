#!/usr/bin/env bash
# TWINS weekly LOCAL backup verification (Stage 2 / Task 5): every retained local encrypted backup must match its recorded SHA-256, and the newest one must
# decrypt and reproduce the recorded plaintext digest. This is the keyed counterpart of the off-host weekly check (`offhost-backup verify`, which needs no key
# and runs when the off-host job is configured). Installed as /usr/local/sbin/twins-backup-verify.sh; run by twins-backup-verify.timer.
# Writes ${STATUS_DIR}/backup-verify.json; any problem -> CRITICAL alert backup.checksum_mismatch / backup.verification_failed and exit 1. Plaintext is shredded.
set -uo pipefail
umask 077
BACKUP_DIR="${BACKUP_DIR:-/opt/twins-staging/backups}"
KEY_FILE="${KEY_FILE:-/root/twins-offsite-keys/twins-staging-offsite-00fd8fc3.key}"
ENC_TOOL="${ENC_TOOL:-/opt/twins-staging/offsite/twinsenc.py}"
STATUS_DIR="${STATUS_DIR:-/var/lib/twins-monitor}"
ALERT_BIN="${ALERT_BIN:-/usr/local/sbin/twins-alert.sh}"
PYTHON="${PYTHON:-python3}"
mkdir -p "$STATUS_DIR"; chmod 700 "$STATUS_DIR" 2>/dev/null
STATUS="$STATUS_DIR/backup-verify.json"
write_status() { local tmp; tmp="$(mktemp "$STATUS_DIR/.backup-verify.XXXXXX")"; printf '{"ok":%s,"ts":"%s","epoch":%s,"checked":%s,"problems":%s,"detail":"%s"}\n' "$1" "$(date -u +%FT%TZ)" "$(date +%s)" "$2" "$3" "$4" > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$STATUS"; }
problems=0; checked=0; mismatch=0; detail="ok"
shopt -s nullglob
FILES=("$BACKUP_DIR"/twins-staging-daily-*.dump.enc)
if [ "${#FILES[@]}" -eq 0 ]; then
  write_status false 0 1 "no_local_backups"
  "$ALERT_BIN" backup.verification_failed CRITICAL twins-backup-verify no_local_backups "No local encrypted backups exist to verify."
  exit 1
fi
for f in "${FILES[@]}"; do
  checked=$((checked + 1))
  if [ ! -f "$f.sha256" ]; then problems=$((problems + 1)); detail="missing_checksum_file"; continue; fi
  if ! ( cd "$BACKUP_DIR" && sha256sum -c --status "$(basename "$f").sha256" ); then problems=$((problems + 1)); mismatch=$((mismatch + 1)); detail="checksum_mismatch"; fi
done
newest="$(printf '%s\n' "${FILES[@]}" | sort | tail -1)"
# the encryption tool refuses to overwrite: give it a path that does not exist yet, inside a private directory
work="$(mktemp -d "$STATUS_DIR/.verify-plain.XXXXXX")"
tmp="$work/plain"
if "$PYTHON" "$ENC_TOOL" decrypt "$KEY_FILE" "$newest" "$tmp" >/dev/null 2>&1; then
  got="$(sha256sum "$tmp" | cut -c1-64)"
  want="$(sed -n 's/.*"plain_sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$STATUS_DIR/backup.json" 2>/dev/null | head -1)"
  named="$(sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' "$STATUS_DIR/backup.json" 2>/dev/null | head -1)"
  # the recorded plaintext digest belongs to the newest backup only when the status file names it
  if [ -n "$want" ] && [ "$named" = "$(basename "$newest")" ] && [ "$got" != "$want" ]; then problems=$((problems + 1)); mismatch=$((mismatch + 1)); detail="plaintext_digest_mismatch"; fi
else
  problems=$((problems + 1)); detail="decrypt_failed"
fi
shred -u "$tmp" 2>/dev/null || rm -f "$tmp"
rmdir "$work" 2>/dev/null || rm -rf "$work"
if [ "$problems" -gt 0 ]; then
  write_status false "$checked" "$problems" "$detail"
  if [ "$mismatch" -gt 0 ]; then "$ALERT_BIN" --detail "count=$mismatch" backup.checksum_mismatch CRITICAL twins-backup-verify "$detail" "A local backup does not match its recorded checksum."
  else "$ALERT_BIN" --detail "count=$problems" backup.verification_failed CRITICAL twins-backup-verify "$detail" "Local backup verification found a problem."; fi
  echo "BACKUP VERIFY FAILED: $detail ($problems problem(s) in $checked file(s))" >&2
  exit 1
fi
write_status true "$checked" 0 "ok"
echo "BACKUP VERIFY OK: $checked file(s) match their checksums; newest decrypts to the recorded digest"
