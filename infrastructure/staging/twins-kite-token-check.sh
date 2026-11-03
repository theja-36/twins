#!/usr/bin/env bash
# TWINS Kite token check (P0-2 follow-up, D-085). Installed ONLY WITH THE TICKER, as /usr/local/sbin/twins-kite-token-check, run on weekday mornings (08:30 IST) by twins-kite-token-check.timer.
# The Kite access token lapses every day around 06:00 IST and the login needs a human; this check tells the owner BEFORE the market opens that the morning login has not happened. It reads only the
# token file's metadata (existence, mode, issuedAt) - never the token - and raises the existing rule's alert: CRITICAL `kite.session_invalidated` (log event `kite.session.invalidated`).
#   token_missing        no token file
#   unsafe_permissions   the file is readable by group or others, or is not a regular file
#   token_unreadable     the file does not parse
#   token_expired        the advisory expiry (next 06:00 IST after issuedAt) has passed
# Alerts are throttled (default 6 h). The exit code is always 0. Nothing is written except the status file.
set -uo pipefail
TOKEN_FILE="${TWINS_KITE_TOKEN_FILE:-/var/lib/twins-kite/kite-token.json}"
MONITOR_DIR="${MONITOR_DIR:-/var/lib/twins-monitor}"
ALERT_BIN="${ALERT_BIN:-/usr/local/sbin/twins-alert.sh}"
THROTTLE="${TWINS_KITE_TOKEN_THROTTLE_SECONDS:-21600}"
NOW="${TWINS_NOW:-$(date +%s)}"
PYTHON="${PYTHON:-python3}"
[[ "$NOW" =~ ^[0-9]{1,10}$ && "$THROTTLE" =~ ^[0-9]{1,10}$ ]] || { printf '{"level":"error","event":"kite_token.bad_config"}\n'; exit 0; }
mkdir -p "$MONITOR_DIR" 2>/dev/null && chmod 700 "$MONITOR_DIR" 2>/dev/null

reason=""
if [ ! -e "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ]; then reason="token_missing"
elif [ -L "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then reason="unsafe_permissions"
else
  mode="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE" 2>/dev/null)"
  if [ -z "$mode" ] || [ $((8#$mode & 8#077)) -ne 0 ]; then reason="unsafe_permissions"
  else
    # issuedAt only; the token value is never read into a variable or printed
    verdict="$("$PYTHON" - "$TOKEN_FILE" "$NOW" <<'PY'
import json, sys, datetime
try:
    issued = datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))["issuedAt"].replace("Z", "+00:00"))
except Exception:
    print("token_unreadable"); sys.exit(0)
ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
t = issued.astimezone(ist)
exp = t.replace(hour=6, minute=0, second=0, microsecond=0)
if exp <= t: exp += datetime.timedelta(days=1)
print("token_expired" if int(sys.argv[2]) >= int(exp.timestamp()) else "ok")
PY
)"
    [ "$verdict" = "ok" ] || reason="$verdict"
  fi
fi

umask 077
printf '{"ok":%s,"ts":"%s","epoch":%s,"reason":"%s"}\n' "$([ -z "$reason" ] && echo true || echo false)" "$(date -u +%FT%TZ)" "$NOW" "$reason" > "$MONITOR_DIR/kite-token.json" 2>/dev/null
if [ -n "$reason" ]; then
  printf '{"ts":"%s","level":"error","event":"kite_token.not_usable","service":"twins-kite-token","reason":"%s"}\n' "$(date -u +%FT%TZ)" "$reason"
  "$ALERT_BIN" --throttle "$THROTTLE" --detail "reason=$reason" kite.session_invalidated CRITICAL twins-kite-token "$reason" "The Kite access token is not usable; the morning login has not been done. The market feed cannot start until it is."
else
  printf '{"ts":"%s","level":"info","event":"kite_token.ok","service":"twins-kite-token"}\n' "$(date -u +%FT%TZ)"
fi
exit 0
