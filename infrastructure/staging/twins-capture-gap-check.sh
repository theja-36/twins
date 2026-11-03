#!/usr/bin/env bash
# TWINS capture-gap check (P0 follow-up, D-083). Installed as /usr/local/sbin/twins-capture-gap-check and run every 10 minutes by twins-capture-gap-check.timer.
# The alert policy already has the rule (`telegram.capture.gap` -> CRITICAL `telegram.capture_gap`, packages/alerting); this is the host job that raises it, through twins-alert.sh and the loopback relay.
# Two conditions, both read-only:
#   client_not_running   the capture container is not running (exited, dead, missing, restarting) for longer than the grace period (default 15 min). This is the failure that really happened:
#                        the client sat stopped from 2026-10-24 to 2026-10-31 and nobody was told. "Down since" is tracked in a small state file, so a restart is not an alert.
#   no_capture_in_window the newest durably captured message (telegram_intake_outbox, source user_capture) is older than the window (default 14 days). The channel is quiet by nature (a 9-day silence
#                        happened in October), so this is a slow safety net, not the main signal; set TWINS_CAPTURE_GAP_WINDOW_SECONDS to the real cadence.
# Details sent: ageSeconds, windowSeconds, reason - never message content. Alerts are throttled (default 6 h) so an unfixed gap is a reminder, not a flood. The exit code is always 0.
set -uo pipefail
DOCKER="${DOCKER:-docker}"
CAPTURE_CONTAINER="${CAPTURE_CONTAINER:-twins-staging-capture-1}"
PG_CONTAINER="${PG_CONTAINER:-twins-staging-postgres-1}"
MONITOR_DIR="${MONITOR_DIR:-/var/lib/twins-monitor}"
ALERT_BIN="${ALERT_BIN:-/usr/local/sbin/twins-alert.sh}"
WINDOW="${TWINS_CAPTURE_GAP_WINDOW_SECONDS:-1209600}"
GRACE="${TWINS_CAPTURE_GAP_DOWN_GRACE_SECONDS:-900}"
THROTTLE="${TWINS_CAPTURE_GAP_THROTTLE_SECONDS:-21600}"
NOW="${TWINS_NOW:-$(date +%s)}"
STATE="$MONITOR_DIR/capture-gap.state"
STATUS="$MONITOR_DIR/capture-gap.json"
for v in "$WINDOW" "$GRACE" "$THROTTLE" "$NOW"; do [[ "$v" =~ ^[0-9]{1,10}$ ]] || { printf '{"level":"error","event":"capture_gap.bad_config"}\n'; exit 0; }; done

log() { printf '{"ts":"%s","level":"%s","event":"%s","service":"twins-capture-gap"%s}\n' "$(date -u +%FT%TZ)" "$1" "$2" "${3:+,$3}"; }
mkdir -p "$MONITOR_DIR" 2>/dev/null && chmod 700 "$MONITOR_DIR" 2>/dev/null

reason=""; age=0
# 1. is the client running?
state="$("$DOCKER" inspect --format '{{.State.Status}}' "$CAPTURE_CONTAINER" 2>/dev/null || echo missing)"
if [ "$state" = "running" ]; then
  rm -f "$STATE"
else
  since="$(cat "$STATE" 2>/dev/null || true)"
  if ! [[ "$since" =~ ^[0-9]+$ ]]; then since="$NOW"; printf '%s' "$NOW" > "$STATE" 2>/dev/null; fi
  down=$((NOW - since))
  log warn capture_gap.client_down "\"state\":\"$state\",\"downSeconds\":$down"
  if [ "$down" -ge "$GRACE" ]; then reason="client_not_running"; age="$down"; fi
fi
# 2. when did the newest message arrive?
if [ -z "$reason" ]; then
  last="$("$DOCKER" exec "$PG_CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"select coalesce(extract(epoch from max(received_at))::bigint, 0) from telegram_intake_outbox where intake_source = 'user_capture'\"" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    if [ "$last" -eq 0 ]; then age=$((WINDOW + 1)); else age=$((NOW - last)); fi
    [ "$age" -gt "$WINDOW" ] && reason="no_capture_in_window"
  else
    log warn capture_gap.age_unknown '"reason":"database_unreadable"'
  fi
fi

ok=true; [ -n "$reason" ] && ok=false
umask 077; printf '{"ok":%s,"ts":"%s","epoch":%s,"state":"%s","reason":"%s","ageSeconds":%s,"windowSeconds":%s}\n' "$ok" "$(date -u +%FT%TZ)" "$NOW" "$state" "$reason" "$age" "$WINDOW" > "$STATUS" 2>/dev/null
if [ -n "$reason" ]; then
  log error capture_gap.detected "\"reason\":\"$reason\",\"ageSeconds\":$age,\"windowSeconds\":$WINDOW"
  case "$reason" in
    client_not_running)   summary="The Telegram capture client is not running; messages are not being captured." ;;
    *)                    summary="No Telegram message has been captured for longer than the configured window; the capture client may be down." ;;
  esac
  "$ALERT_BIN" --throttle "$THROTTLE" --detail "ageSeconds=$age" --detail "windowSeconds=$WINDOW" --detail "reason=$reason" telegram.capture_gap CRITICAL twins-capture-gap "$reason" "$summary"
else
  log info capture_gap.ok "\"state\":\"$state\",\"ageSeconds\":$age"
fi
exit 0
