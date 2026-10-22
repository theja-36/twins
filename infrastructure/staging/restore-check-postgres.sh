#!/usr/bin/env bash
# Restore a backup into a SCRATCH database and sanity-check it. PREPARED ONLY: not executed by this repo.
# It never touches the live database: the target is always `twins_restore_check`, dropped and recreated first.
#
#   bash infrastructure/staging/restore-check-postgres.sh --yes <backup.dump>
set -euo pipefail
[ "${1:-}" = "--yes" ] && [ -n "${2:-}" ] || { echo "usage: $0 --yes <backup.dump>"; exit 2; }
FILE="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.staging.yml" --env-file "$HERE/staging.env")
[ -f "$FILE" ] || { echo "no such file"; exit 2; }
if [ -f "$FILE.sha256" ]; then ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" ); else echo "WARNING: no .sha256 next to the backup"; fi
"${COMPOSE[@]}" exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists twins_restore_check && createdb -U "$POSTGRES_USER" twins_restore_check'
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d twins_restore_check --no-owner --exit-on-error' < "$FILE"
"${COMPOSE[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d twins_restore_check -At' <<'SQL'
select 'public tables: ' || count(*) from information_schema.tables where table_schema = 'public';
select 'applied migrations: ' || count(*) from drizzle.__drizzle_migrations;
SQL
echo "restore check finished on scratch database twins_restore_check (drop it when done: dropdb)"
