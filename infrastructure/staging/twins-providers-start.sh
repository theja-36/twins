#!/usr/bin/env bash
# TWINS provider exporter start gate (START-UP CHECK). The ONLY supported way to start the exporter: it refuses unless the providers egress allow-list is applied, filled and fresh.
# To be installed as /opt/twins-staging/twins-providers-start.sh together with the egress script (BUILT 2026-11-06, NOT INSTALLED). Starting the exporter is still a separate owner decision (host allow-list installed, FRED key in providers.env, a first single pass read).
#   twins-providers-start.sh        runs `twins-providers-egress.sh status`; only if it exits 0 does it start the `provider-exporter` compose service. Exit 0 started, 3 refused, 2 usage.
set -uo pipefail
EGRESS="${EGRESS_BIN:-/opt/twins-staging/twins-providers-egress.sh}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/twins-staging/infrastructure/staging}"
DOCKER="${DOCKER:-docker}"
[ "$#" -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
if ! out="$("$EGRESS" status 2>&1)"; then
  printf '{"ts":"%s","level":"error","event":"providers_start.start_refused","reason":"egress_not_ready"}\n' "$(date -u +%FT%TZ)"
  echo "$out" >&2
  exit 3
fi
printf '{"ts":"%s","level":"info","event":"providers_start.egress_ready"}\n' "$(date -u +%FT%TZ)"
cd "$COMPOSE_DIR" && exec "$DOCKER" compose -f docker-compose.staging.yml --env-file staging.env --profile providers up -d --no-deps provider-exporter
