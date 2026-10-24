#!/usr/bin/env bash
# Live, content-free watcher for the capture service during a bounded test. Run ON the staging host (or: ssh host 'bash -s' < capture-watch.sh with the
# variables in the environment). Prints one line per capture event of interest (delivered / alert / queue_overflow / delivery_retry / rejected_payload /
# skipped / session_restart / protected_content_changed / unexpected_status) and an ANOMALY line for any state that is a stop condition.
# EVERY stage of the pipeline is line-buffered (grep --line-buffered, awk with fflush): an earlier version ended with `cut`, which block-buffers when its output
# is a pipe, so events were swallowed until the stream ended and a captured message went unnoticed for 12 minutes.
#   START_EPOCH   required: unix time the capture service was started (the window starts there)
#   DURATION      seconds to watch (default 1800 = 30 minutes), then prints DEADLINE and exits
#   CONTAINER     default twins-staging-capture-1
#   ALERT_LOG     optional file: every alert / anomaly / state-change line is appended there with a UTC timestamp (an always-on place for
#                 an external notifier to tail; the owner alert path of an unattended run)
#   WATCH_LOG_CMD (tests only) a command that prints the log stream instead of `docker logs -f`; WATCH_NO_STATE=1 skips the docker state checks
set -u
: "${START_EPOCH:?START_EPOCH is required}"
DURATION="${DURATION:-1800}"
CONTAINER="${CONTAINER:-twins-staging-capture-1}"
END=$((START_EPOCH + DURATION))
EVENTS='"event": "capture\.(delivered|alert|queue_overflow|delivery_retry|rejected_payload|skipped|session_restart|protected_content_changed|unexpected_status)"'
if [ -n "${WATCH_LOG_CMD:-}" ]; then
  source_cmd() { bash -c "$WATCH_LOG_CMD"; }
else
  SINCE="$(date -u -d "@$START_EPOCH" +%FT%TZ)"
  source_cmd() { docker logs -f --since "$SINCE" "$CONTAINER" 2>&1; }
fi
ALERT_LOG="${ALERT_LOG:-}"
ALERT_RX='capture[.](alert|queue_overflow|delivery_retry|session_restart|protected_content_changed|unexpected_status)'
source_cmd | grep --line-buffered -E "$EVENTS" | awk -v alert_log="$ALERT_LOG" -v rx="$ALERT_RX" '{ line = substr($0, 1, 200); print line; if (alert_log != "" && line ~ rx) { cmd = "date -u +%FT%TZ"; cmd | getline ts; close(cmd); print ts " " line >> alert_log; close(alert_log) } fflush() }' &
PIPE_PID=$!
cleanup() { kill "$PIPE_PID" 2>/dev/null; wait "$PIPE_PID" 2>/dev/null; }
trap cleanup EXIT
if [ "${WATCH_NO_STATE:-0}" != "1" ]; then
  base_api="$(docker inspect -f '{{.RestartCount}}' twins-staging-api-1)"; base_wk="$(docker inspect -f '{{.RestartCount}}' twins-staging-worker-1)"
  emit() { echo "$1"; if [ -n "$ALERT_LOG" ]; then echo "$(date -u +%FT%TZ) $1" >> "$ALERT_LOG"; fi; }
  last_cs="running restarts=0 oom=false"; last_n5=0; oom_seen=""
  while [ "$(date +%s)" -lt "$END" ]; do
    cs="$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' "$CONTAINER" 2>&1)"
    if [ "$cs" != "$last_cs" ]; then emit "STATE capture: $cs"; last_cs="$cs"; fi  # printed once per change, not every poll
    for n in api worker postgres redis; do o="$(docker inspect -f '{{.State.OOMKilled}}' "twins-staging-$n-1")"; if [ "$o" != false ]; then case " $oom_seen " in *" $n "*) ;; *) emit "ANOMALY OOM $n"; oom_seen="$oom_seen $n";; esac; fi; done  # once per service
    [ "$(docker inspect -f '{{.RestartCount}}' twins-staging-api-1)" = "$base_api" ] || { emit "ANOMALY api restarted"; base_api="$(docker inspect -f '{{.RestartCount}}' twins-staging-api-1)"; }
    [ "$(docker inspect -f '{{.RestartCount}}' twins-staging-worker-1)" = "$base_wk" ] || { emit "ANOMALY worker restarted"; base_wk="$(docker inspect -f '{{.RestartCount}}' twins-staging-worker-1)"; }
    n5="$(docker logs --since "$SINCE" twins-staging-api-1 2>&1 | grep -cE '"statusCode":5[0-9][0-9]|"level":50')"; if [ "$n5" != "$last_n5" ]; then emit "ANOMALY api 5xx/error lines=$n5"; last_n5="$n5"; fi
    sleep 15
  done
else
  while [ "$(date +%s)" -lt "$END" ]; do sleep 1; done
fi
echo "DEADLINE reached"
