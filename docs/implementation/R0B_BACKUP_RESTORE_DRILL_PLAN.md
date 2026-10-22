# R0B local backup/restore drill - PLAN (prepared; NOT executed; awaiting approval)

Executable form: `docs/implementation/rehearsal/backup_restore_drill.sh` (stops at first failure, never cleans up) and manual `cleanup_backup_drill.sh`. Supporting: `drill_fingerprint.sql`, `drill_revision_states.mjs`.

## Scope and limits
Local LOGICAL PostgreSQL backup/restore inside the existing `twins-postgres-test` container (PostgreSQL 16.15; pg_dump/pg_restore/psql 16.15). It is NOT evidence of: VPS or disk-loss recovery, off-site backup durability, Redis queue recovery, production RPO/RTO, or recovery of global roles/permissions (no `pg_dumpall --globals-only`; the `twins` role already exists in the same cluster). Measured durations are single local timings, not an SLA.

## Source / target / paths
- Source: `twins_rehearsal_upgrade` (owner `twins`; synthetic; 32 tables, 1 sequence, 24 enums, 0 extensions, 0 ACLs, 0 non-twins owners, 0 large objects; 0 active connections at inspection). Never written by the drill.
- Target (new): `twins_restore_drill`, owner `twins`. Absent at inspection (read-only query).
- Not used as source or target: `twins_dev`, `twins_ci`, `twins_rehearsal_fresh`.
- Dump: `$DRILL/twins_rehearsal_upgrade.dump` with `DRILL=/private/tmp/claude-501/-Users-sara-twins/c58df6eb-85bd-4baf-add0-daa59015d6de/scratchpad/backup-drill`; logs in `$DRILL/logs`. The dump (synthetic data) is NOT copied into the repository; only redacted logs/fingerprints would be.

## Commands (as in the script)
```bash
# preflight: target absent, source owner twins, 0 connections, dump path absent; baseline counts of the other 4 DBs (read-only)
# source fingerprint + revision states BEFORE (read-only sessions: PGOPTIONS=-c default_transaction_read_only=on)
docker exec -i -e "PGOPTIONS=-c default_transaction_read_only=on" twins-postgres-test psql -U twins -d twins_rehearsal_upgrade -v ON_ERROR_STOP=1 < docs/implementation/rehearsal/drill_fingerprint.sql
DATABASE_URL=<twins_rehearsal_upgrade url, test-only, not printed> npx tsx docs/implementation/rehearsal/drill_revision_states.mjs
# dump: custom format, compressed, consistent snapshot, streamed to the host file
docker exec twins-postgres-test pg_dump -U twins -d twins_rehearsal_upgrade -Fc --lock-wait-timeout=10000 > "$DRILL/twins_rehearsal_upgrade.dump"
# archive checks: non-empty; shasum -a 256; pg_restore -l readable; 32 TABLE DATA entries; the four 0004 indexes in the TOC
# source fingerprint AFTER dump must be byte-identical to BEFORE (no writes in the window)
# target + restore: no --clean, no --create, single transaction, stop on first error
docker exec twins-postgres-test createdb -U twins -O twins -T template0 twins_restore_drill
docker exec -i twins-postgres-test pg_restore -U twins -d twins_restore_drill --exit-on-error --single-transaction < "$DRILL/twins_rehearsal_upgrade.dump"
```
Ownership/privileges: objects keep owner `twins` (same cluster, target owned by `twins`; no `--no-owner`). No ACLs exist in the source, so none are restored; the fingerprint compares ACL count and owners. Passwords: dumps and restores use the container's local socket auth (no password on any command line); the one Node script reads a test-only URL from the environment and never prints it; evidence is redacted before copying.

## Verification (restore vs source; all read-only)
1. `drill_fingerprint.sql` output must be byte-identical: encoding/collation, schemas, extensions, enum labels, every column (type, nullability, default), every index definition (incl. the four 0004 indexes), every constraint definition, table owners, ACL count, sequence `last_value/is_called`, migration tracking rows (id, hash, created_at), the five 0004 columns, business facts (parser versions; keyed/keyless/recompute validations; legacy/original/revision messages; sources with/without chat_id), and for EVERY table a row count plus an md5 over its rows ordered by row text (deterministic content comparison; physical size is not used).
2. Schema-only `pg_dump -s` of source and restore compared (owners included; random `\restrict` tokens filtered).
3. Revision currentness: the application's own `classifyRevisions` run over every (source, original message) group on both databases; outputs must be identical (source today: 28 groups / 34 messages: 26 current, 5 superseded, 3 ambiguous).
4. Restore owner and table count; `twins_dev`, `twins_ci`, both rehearsal DBs unchanged (counts before/after).
Dry run already performed on the SOURCE only, in read-only sessions (no dump/restore): the fingerprint ran twice byte-identically (579 lines, 32 tables hashed) and the revision script ran; a bug in my first fingerprint SQL (GROUP BY 1 with an aggregate) was found and fixed that way.
Expected: any difference stops the drill and is reported, never ignored. Intentionally not compared: physical size, `pg_stat` counters, global roles, WAL/replication state.

## Durations
`dump_seconds` and `restore_seconds` (restore includes `createdb`) are recorded in `$DRILL/logs/durations.txt` from wall-clock timing.

## Application smoke test
None proposed by default. The only application-level check included is the read-only revision-currentness comparison above (forced read-only session; modifies nothing). Running any mutating integration suite against the restored database is NOT part of this plan; it would insert rows into `twins_restore_drill` (tests create new messages/signals/validations and queues) and, if wanted, needs a separate approval AFTER the content comparison is done and evidence is preserved.

## Resources created and cleanup (cleanup NOT approved/run)
Created: database `twins_restore_drill`; directory `$DRILL` (dump, TOC, checksums, logs, schema dumps). No role, container, volume, Redis key or repo file is created by the drill.
Cleanup (manual, later, separate approval): `CONFIRM=yes docs/implementation/rehearsal/cleanup_backup_drill.sh`, which runs exactly `docker exec twins-postgres-test dropdb -U twins twins_restore_drill` (no `--force`) and `rm -r "$DRILL"`.
