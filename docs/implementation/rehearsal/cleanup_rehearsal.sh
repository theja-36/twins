#!/usr/bin/env bash
# MANUAL cleanup after a SUCCESSFUL rehearsal. Never run automatically; never after a failure you still want to diagnose.
# Removes exactly: databases twins_rehearsal_fresh + twins_rehearsal_upgrade, and the directory $R/pre0004.
# Keeps: $R/logs. No wildcard rm, no Docker prune, no Redis flush.
set -eu
[ "${CONFIRM:-}" = "yes" ] || { echo "Set CONFIRM=yes to proceed"; exit 1; }
R=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad/rehearsal
for db in twins_rehearsal_fresh twins_rehearsal_upgrade; do
  docker exec twins-postgres-test dropdb -U twins "$db"      # no --force: refused if connections are open
done
rm -r "$R/pre0004"
echo "removed 2 databases and $R/pre0004; logs kept in $R/logs"
