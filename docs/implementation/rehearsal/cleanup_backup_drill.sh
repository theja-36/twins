#!/usr/bin/env bash
# MANUAL cleanup after the backup/restore drill results are reviewed. Never automatic.
# Removes exactly: database twins_restore_drill and the directory $DRILL (dump + logs). Nothing else.
set -eu
[ "${CONFIRM:-}" = "yes" ] || { echo "Set CONFIRM=yes to proceed"; exit 1; }
DRILL=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad/backup-drill
docker exec twins-postgres-test dropdb -U twins twins_restore_drill   # no --force
rm -r "$DRILL"
echo "removed database twins_restore_drill and $DRILL"
