#!/usr/bin/env bash
# TWINS staging PostgreSQL backup (custom-format pg_dump). PREPARED ONLY: not scheduled, not executed by this repo.
# A copy on the SAME server protects against operator/app mistakes only. It is NOT off-site protection: losing the
# server or its disk loses the database and this copy together. An off-site copy needs a destination decision.
#
#   bash infrastructure/staging/backup-postgres.sh --yes [backup-dir]     (default dir: ./backups, created mode 700)
# Only PostgreSQL is dumped. The capture service's volumes (twins_capture_session = the encrypted Telegram session, twins_capture_state) are deliberately
# NOT included and must never be copied to another host.
set -euo pipefail
[ "${1:-}" = "--yes" ] || { echo "refusing to run without --yes (this reads the live staging database)"; exit 2; }
DIR="${2:-./backups}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.staging.yml" --env-file "$HERE/staging.env")
umask 077
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/twins-staging-$STAMP.dump"
# Credentials are read inside the container from its own environment; nothing secret is passed on this command line.
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$OUT.partial"
mv "$OUT.partial" "$OUT"
( cd "$DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
echo "wrote $OUT ($(wc -c < "$OUT") bytes) and its .sha256; same-server copy only - NOT off-site"
