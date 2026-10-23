#!/usr/bin/env bash
# Live, content-free watcher for the capture service during a bounded test. Run ON the staging host (or: ssh host 'bash -s' < capture-watch.sh with the
# variables in the environment). Prints one line per capture event of interest (delivered / alert / queue_overflow / delivery_retry / rejected_payload /
# skipped / session_restart / protected_content_changed / unexpected_status) and an ANOMALY line for any state that is a stop condition.
# EVERY stage of the pipeline is line-buffered (grep --line-buffered, awk with fflush): an earlier version ended with `cut`, which block-buffers when its output
# is a pipe, so events were swallowed until the stream ended and a captured message went unnoticed for 12 minutes.
#   START_EPOCH   required: unix time the capture service was started (the window starts there)
#   DURATION      seconds to watch (default 1800 = 30 minutes), then prints DEADLINE and exits
#   CONTAINER     default twins-staging-capture-1
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
source_cmd | grep --line-buffered -E "$EVENTS" | awk '{ print substr($0, 1, 200); fflush() }' &
PIPE_PID=$!
cleanup() { kill "$PIPE_PID" 2>/dev/null; wait "$PIPE_PID" 2>/dev/null; }
trap cleanup EXIT
if [ "${WATCH_NO_STATE:-0}" != "1" ]; then
  base_api="$(docker inspect -f '{{.RestartCount}}' twins-staging-api-1)"; base_wk="$(docker inspect -f '{{.RestartCount}}' twins-staging-worker-1)"
  while [ "$(date +%s)" -lt "$END" ]; do
    cs="$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' "$CONTAINER" 2>&1)"
    case "$cs" in "running restarts=0 oom=false") ;; *) echo "STATE capture: $cs";; esac
    for n in api worker postgres redis; do o="$(docker inspect -f '{{.State.OOMKilled}}' "twins-staging-$n-1")"; [ "$o" = false ] || echo "ANOMALY OOM $n"; done
    [ "$(docker inspect -f '{{.RestartCount}}' twins-staging-api-1)" = "$base_api" ] || echo "ANOMALY api restarted"
    [ "$(docker inspect -f '{{.RestartCount}}' twins-staging-worker-1)" = "$base_wk" ] || echo "ANOMALY worker restarted"
    n5="$(docker logs --since "$SINCE" twins-staging-api-1 2>&1 | grep -cE '"statusCode":5[0-9][0-9]|"level":50')"; [ "$n5" = 0 ] || echo "ANOMALY api 5xx/error lines=$n5"
    sleep 15
  done
else
  while [ "$(date +%s)" -lt "$END" ]; do sleep 1; done
fi
echo "DEADLINE reached"
