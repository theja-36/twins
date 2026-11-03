#!/usr/bin/env bash
# TWINS Kite feed start gate (START-UP CHECK). The ONLY supported way to start the Kite ticker: it refuses unless the egress allow-list is applied, filled and fresh.
# Installed as /opt/twins-staging/twins-kite-feed-start.sh (NOT INSTALLED until the owner starts the feed). Starting the feed is still a separate owner decision (Connect plan, login, supervised run).
#   twins-kite-feed-start.sh        runs `twins-kite-egress.sh status`; only if it exits 0 does it start the `kite-ticker` compose service. Exit 0 started, 3 refused, 2 usage.
set -uo pipefail
EGRESS="${EGRESS_BIN:-/opt/twins-staging/twins-kite-egress.sh}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/twins-staging/infrastructure/staging}"
DOCKER="${DOCKER:-docker}"
[ "$#" -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
if ! out="$("$EGRESS" status 2>&1)"; then
  printf '{"ts":"%s","level":"error","event":"kite_feed.start_refused","reason":"egress_not_ready"}\n' "$(date -u +%FT%TZ)"
  echo "$out" >&2
  exit 3
fi
printf '{"ts":"%s","level":"info","event":"kite_feed.egress_ready"}\n' "$(date -u +%FT%TZ)"
cd "$COMPOSE_DIR" && exec "$DOCKER" compose -f docker-compose.staging.yml --env-file staging.env --profile kite up -d --no-deps kite-ticker
