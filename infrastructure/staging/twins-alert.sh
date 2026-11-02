#!/usr/bin/env bash
# TWINS host-side alert sender (Stage 2 / Task 5). Same payload contract as packages/alerting (docs/twins/OPERATIONAL_ALERTING.md), for the jobs that run on the
# HOST (backup, backup verification, health check, systemd OnFailure). Installed as /usr/local/sbin/twins-alert.sh (root:root 0750).
#   twins-alert.sh [--test] [--throttle SECONDS] [--unit NAME] [--detail key=value]... <event> <INFO|WARNING|CRITICAL> <service> <code> <summary> [correlation-id]
#   twins-alert.sh --unit twins-backup.service          (systemd OnFailure: event, code and summary are derived from the unit name)
# Destination and secret come from /etc/twins-alerts/alert.env (root:root 0600; TWINS_ALERT_WEBHOOK_URL, TWINS_ALERT_WEBHOOK_SECRET, TWINS_ENV_NAME, TWINS_BUILD). The URL is
# a credential: it is never printed or logged and never put on a command line (curl reads it from a descriptor). Every argument is validated against a strict
# pattern and a secret-shape filter; free text beyond the fixed templates is rejected. Without a destination the alert is logged as undelivered (exit 0; --test: exit 2).
# Exit: 0 delivered / suppressed / undelivered (normal use, so a failing alert path never fails the job it reports), --test: 0 delivered, 1 failed, 2 not configured.
set -uo pipefail
ENV_FILE="${TWINS_ALERT_ENV_FILE:-/etc/twins-alerts/alert.env}"
STATE_DIR="${TWINS_ALERT_STATE_DIR:-/var/lib/twins-monitor/alert-state}"
CURL="${CURL:-curl}"
PYTHON="${PYTHON:-python3}"
TEST=0; THROTTLE=0; UNIT=""; DETAILS=()
log() { printf '{"ts":"%s","level":"%s","event":"%s","service":"twins-alert","alertEvent":"%s","severity":"%s"%s}\n' "$(date -u +%FT%TZ)" "$1" "$2" "${EVENT:-}" "${SEVERITY:-}" "${3:+,$3}"; }
fail_usage() { printf '{"ts":"%s","level":"error","event":"alert.invalid","service":"twins-alert","reason":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; exit "$([ "$TEST" = 1 ] && echo 2 || echo 0)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --test) TEST=1; shift ;;
    --throttle) THROTTLE="${2:-0}"; shift 2 ;;
    --unit) UNIT="${2:-}"; shift 2 ;;
    --detail) DETAILS+=("${2:-}"); shift 2 ;;
    --) shift; break ;;
    -*) fail_usage "unknown_flag" ;;
    *) break ;;
  esac
done
if [ -n "$UNIT" ]; then
  [[ "$UNIT" =~ ^[A-Za-z0-9_.@-]{1,80}$ ]] || fail_usage "bad_unit"
  case "$UNIT" in *.service) ;; *) UNIT="$UNIT.service" ;; esac # an instance of a template unit loses the suffix
  case "$UNIT" in
    twins-backup.service|twins-offhost-backup.service) EVENT="backup.failed" ;;
    twins-backup-verify.service|twins-offhost-verify.service) EVENT="backup.verification_failed" ;;
    twins-audit-verify.service) EVENT="audit.verification_failed" ;;
    twins-offhost-drill.service) EVENT="backup.restore_drill_failed" ;;
    *) EVENT="job.failed" ;;
  esac
  SEVERITY="CRITICAL"; SERVICE="systemd"; CODE="unit_failed"; SUMMARY="Scheduled job $UNIT failed; see the journal for the unit."; CORR="${1:-}"
  DETAILS+=("unit=$UNIT")
else
  [ $# -ge 5 ] || fail_usage "usage"
  EVENT="$1"; SEVERITY="$2"; SERVICE="$3"; CODE="$4"; SUMMARY="$5"; CORR="${6:-}"
fi
[[ "$EVENT" =~ ^[a-z][a-z0-9_.]{1,60}$ ]] || fail_usage "bad_event"
[[ "$SEVERITY" =~ ^(INFO|WARNING|CRITICAL)$ ]] || fail_usage "bad_severity"
[[ "$SERVICE" =~ ^[A-Za-z0-9_.:-]{1,60}$ ]] || fail_usage "bad_service"
[[ "$CODE" =~ ^[A-Za-z0-9_.:-]{1,80}$ ]] || fail_usage "bad_code"
[[ -z "$CORR" || "$CORR" =~ ^[A-Za-z0-9_-]{4,80}$ ]] || fail_usage "bad_correlation"
[[ "$THROTTLE" =~ ^[0-9]{1,6}$ ]] || fail_usage "bad_throttle"
# printable ASCII only, bounded, no characters that need JSON escaping, no secret shapes
[[ "$SUMMARY" =~ ^[A-Za-z0-9\ .,\;:\(\)/_@=+-]{1,240}$ ]] || fail_usage "bad_summary"
if printf '%s' "$SUMMARY" | grep -Eqi 'AGE-SECRET-KEY|PRIVATE KEY|[a-z]+://[^ /@:]+:[^ /@]+@|bearer +[A-Za-z0-9._~+/-]{8,}|(password|passwd|secret|token|api[_-]?key|authorization) *[=:] *[^ ]{4,}|[0-9]{6,}:[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/_-]{48,}'; then fail_usage "secret_shape"; fi

ALLOWED_KEYS=" name step failure count attempt maxAttempts outboxId channelId messageType control version previousValue newValue changedBy chain rows ageSeconds bytes sha256 reason action unit kind restarts windowSeconds oldestAgeSeconds firstFailure "
DETAIL_JSON=""
for d in "${DETAILS[@]:-}"; do
  [ -n "$d" ] || continue
  k="${d%%=*}"; v="${d#*=}"
  [[ "$ALLOWED_KEYS" == *" $k "* ]] || continue
  [[ "$v" =~ ^[A-Za-z0-9_.:/@-]{1,120}$ ]] || continue
  if printf '%s' "$v" | grep -Eqi 'AGE-SECRET-KEY|[A-Za-z0-9+/_-]{48,}' && [ "$k" != "sha256" ]; then continue; fi
  if [[ "$v" =~ ^[0-9]+$ ]]; then DETAIL_JSON+="${DETAIL_JSON:+,}\"$k\":$v"; else DETAIL_JSON+="${DETAIL_JSON:+,}\"$k\":\"$v\""; fi
done

# configuration: parse only the keys we need; the file is never sourced
getvar() { [ -r "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
URL="${TWINS_ALERT_WEBHOOK_URL:-$(getvar TWINS_ALERT_WEBHOOK_URL)}"
SECRET="${TWINS_ALERT_WEBHOOK_SECRET:-$(getvar TWINS_ALERT_WEBHOOK_SECRET)}"
# Optional bearer token, for a destination that authenticates the caller (the staging alert-relay on loopback). Like the URL it is passed to curl through a descriptor, never on a command line.
BEARER="${TWINS_ALERT_WEBHOOK_BEARER:-$(getvar TWINS_ALERT_WEBHOOK_BEARER)}"
[[ -z "$BEARER" || "$BEARER" =~ ^[A-Za-z0-9._~+=-]{16,200}$ ]] || { log warn alert.undelivered '"reason":"bad_bearer_format"'; [ "$TEST" = 1 ] && exit 2; exit 0; }
ENVNAME="${TWINS_ENV_NAME:-$(getvar TWINS_ENV_NAME)}"; ENVNAME="${ENVNAME:-unknown}"
BUILD="${TWINS_BUILD:-$(getvar TWINS_BUILD)}"; BUILD="${BUILD:-unknown}"
[[ "$ENVNAME" =~ ^[A-Za-z0-9_.:-]{1,40}$ ]] || ENVNAME="unknown"
[[ "$BUILD" =~ ^[A-Za-z0-9_.:/@-]{1,120}$ ]] || BUILD="unknown"

if [ "$THROTTLE" -gt 0 ] && [ "$TEST" = 0 ]; then
  mkdir -p "$STATE_DIR" 2>/dev/null && chmod 700 "$STATE_DIR" 2>/dev/null
  STAMP="$STATE_DIR/${EVENT}.${CODE}"
  now="$(date +%s)"; last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  if [[ "$last" =~ ^[0-9]+$ ]] && [ $((now - last)) -lt "$THROTTLE" ]; then log info alert.suppressed '"reason":"throttled"'; exit 0; fi
  printf '%s' "$now" > "$STAMP" 2>/dev/null || true
fi

if [ -z "$URL" ]; then
  log warn alert.undelivered '"reason":"no_destination_configured"'
  [ "$TEST" = 1 ] && exit 2
  exit 0
fi
case "$URL" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*) ;;
  *) if [ "${TWINS_ALERT_ALLOW_INSECURE_TEST:-}" != 1 ]; then log warn alert.undelivered '"reason":"destination_must_be_https"'; [ "$TEST" = 1 ] && exit 2; exit 0; fi ;;
esac

BODY="$(printf '{"v":1,"event":"%s","severity":"%s","environment":"%s","service":"%s","timestamp":"%s","build":"%s"%s,"code":"%s","summary":"%s","details":{%s}}' \
  "$EVENT" "$SEVERITY" "$ENVNAME" "$SERVICE" "$(date -u +%FT%TZ)" "$BUILD" "${CORR:+,\"correlationId\":\"$CORR\"}" "$CODE" "$SUMMARY" "$DETAIL_JSON")"
SIGHDR=()
if [ -n "$SECRET" ]; then
  SIG="$(printf '%s' "$BODY" | HMAC_SECRET="$SECRET" "$PYTHON" -c 'import hmac,hashlib,os,sys;print(hmac.new(os.environ["HMAC_SECRET"].encode(),sys.stdin.buffer.read(),hashlib.sha256).hexdigest())')"
  SIGHDR=(-H "x-twins-signature: sha256=$SIG")
fi
code="$(printf '%s' "$BODY" | "$CURL" -sS --max-time 8 --retry 1 --retry-delay 1 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'user-agent: twins-alert/1' ${SIGHDR[@]+"${SIGHDR[@]}"} --data-binary @- -K <(printf 'url = "%s"\n' "$URL"; [ -n "$BEARER" ] && printf 'header = "authorization: Bearer %s"\n' "$BEARER") 2>/dev/null || true)"
if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
  log info alert.sent
  exit 0
fi
log warn alert.delivery_failed "\"httpStatus\":\"${code:-none}\""
[ "$TEST" = 1 ] && exit 1
exit 0
