#!/usr/bin/env bash
# TWINS host health check (Stage 2 / Task 5): reads the monitor status files and raises alerts for stale or failed jobs. Runs after each hourly audit
# verification (ExecStartPost of twins-audit-verify.service) - no extra timer. Installed as /usr/local/sbin/twins-health-check.sh.
#   WARNING backup.delayed          last successful backup older than BACKUP_MAX_AGE_SECONDS (default 30 h) or never recorded
#   CRITICAL backup.failed          the last backup run failed
#   WARNING audit.verification_delayed   last audit verification older than AUDIT_MAX_AGE_SECONDS (default 3 h)
#   CRITICAL audit.verification_failed   the last audit verification failed
# Alerts are throttled (default 6 h per event) so an unfixed problem is a reminder, not a flood. Exit code is always 0.
set -uo pipefail
MONITOR_DIR="${MONITOR_DIR:-/var/lib/twins-monitor}"
ALERT_BIN="${ALERT_BIN:-/usr/local/sbin/twins-alert.sh}"
BACKUP_MAX_AGE_SECONDS="${BACKUP_MAX_AGE_SECONDS:-108000}"
AUDIT_MAX_AGE_SECONDS="${AUDIT_MAX_AGE_SECONDS:-10800}"
THROTTLE="${HEALTH_ALERT_THROTTLE_SECONDS:-21600}"
now="$(date +%s)"
field() { sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" "$1" 2>/dev/null | head -1 | tr -d '"'; }

check() { # $1 label  $2 file  $3 max-age  $4 delayed-event  $5 failed-event  $6 service
  local f="$2" ok epoch last
  if [ ! -r "$f" ]; then "$ALERT_BIN" --throttle "$THROTTLE" "$4" WARNING "$6" no_status_file "No status file for $1: the job has never run." ; return; fi
  ok="$(field "$f" ok)"; epoch="$(field "$f" epoch)"; last="$(field "$f" last_ok_epoch)"
  [[ "$last" =~ ^[0-9]+$ ]] || { [ "$ok" = true ] && last="$epoch" || last=""; }
  if [ "$ok" = false ]; then "$ALERT_BIN" --throttle "$THROTTLE" "$5" CRITICAL "$6" last_run_failed "The last $1 run failed."; fi
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    local age=$((now - last))
    if [ "$age" -gt "$3" ]; then "$ALERT_BIN" --throttle "$THROTTLE" --detail "ageSeconds=$age" "$4" WARNING "$6" stale "The last successful $1 is older than expected."; fi
  elif [ "$ok" != false ]; then
    "$ALERT_BIN" --throttle "$THROTTLE" "$4" WARNING "$6" never_succeeded "No successful $1 has been recorded."
  fi
}
check "backup" "$MONITOR_DIR/backup.json" "$BACKUP_MAX_AGE_SECONDS" backup.delayed backup.failed twins-backup
check "audit verification" "$MONITOR_DIR/audit/audit-verify.json" "$AUDIT_MAX_AGE_SECONDS" audit.verification_delayed audit.verification_failed twins-audit-verify
exit 0
