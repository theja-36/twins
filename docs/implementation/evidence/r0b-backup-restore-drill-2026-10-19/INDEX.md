# Evidence index - local logical PostgreSQL backup/restore drill (2026-10-19)

**Label: local logical PostgreSQL backup/restore rehearsal.** It is NOT evidence of off-site recovery, Redis queue recovery, global-role/permission recovery, VPS or disk-loss recovery, production RPO/RTO, or R0B completion.

Source `twins_rehearsal_upgrade` (owner `twins`, synthetic) -> new database `twins_restore_drill` (owner `twins`, created from `template0`) inside the existing `twins-postgres-test` (PostgreSQL 16.15; pg_dump/pg_restore 16.15). Files here are redacted text copies (home/scratch paths replaced; no credentials were present - the only match of a secret-like word is the column name `password_hash`). The binary dump stays outside the repository at `$DRILL/twins_rehearsal_upgrade.dump` (`$DRILL` = `<scratchpad>/backup-drill`). LOGGED = visible in these files; AGENT-REPORTED = not captured in a preserved log.

## Commands and exit codes (LOGGED: `exit_codes.txt`, `_script_console_output.txt`)
| Command | Exit |
|---|---|
| `docker exec twins-postgres-test pg_dump -U twins -d twins_rehearsal_upgrade -Fc --lock-wait-timeout=10000 > "$DRILL/twins_rehearsal_upgrade.dump"` | 0 |
| `docker exec twins-postgres-test createdb -U twins -O twins -T template0 twins_restore_drill` | 0 |
| `docker exec -i twins-postgres-test pg_restore -U twins -d twins_restore_drill --exit-on-error --single-transaction < "$DRILL/twins_rehearsal_upgrade.dump"` | 0 |
| whole script `backup_restore_drill.sh` (stop on first failure, no cleanup) | 0 |
The executed script equals the reviewed one except for keeping original schema dumps (`script_difference_reviewed_vs_executed.txt`).

## Archive (LOGGED)
Size 95,113 bytes; SHA-256 `edc65ec38a4b56e8555b5b74ceeef392f19f61248dd22f04c6545544264b757b` (`dump.sha256`, `durations.txt`); readable TOC (`dump_toc.txt`: 195 entries, 32 `TABLE DATA`, the four 0004 indexes present). Checksum/TOC alone are NOT treated as restore verification.

## Timings (LOGGED: `durations.txt`; single local wall-clock measurements, not an SLA)
- `dump_seconds=0.210`: from just before launching `docker exec ... pg_dump` to just after that process exited; includes docker-exec startup and writing the file; excludes the fingerprints, checksum and TOC checks.
- `restore_seconds=0.500`: from just before `createdb` to just after `pg_restore` exited; includes both docker-exec startups and database creation; excludes all verification.

## Verification results (all LOGGED in `_script_console_output.txt` and the named files)
| Check | Result | File |
|---|---|---|
| Source fingerprint before vs after the dump | byte-identical (source quiescent; also 0 connections at start) | `fingerprint_source_before/after.txt` |
| Source vs restored fingerprint (settings, columns, indexes, constraints, owners, ACL count, sequence, migration tracking rows, 0004 structures, business facts, per-table row counts + md5 content hashes) | **byte-identical** (empty diff) | `fingerprint_diff.txt` (0 bytes) |
| Sequence `drizzle.__drizzle_migrations_id_seq` | same last_value/is_called (5, true) inside the identical fingerprint | `fingerprint_restore.txt` |
| Migration tracking (5 rows: id, hash, created_at) | identical | same |
| Schema-only `pg_dump -s`, original dumps kept | raw dumps differ only by the random `\restrict`/`\unrestrict` token lines (330-byte diff); after removing ONLY those 2 lines per dump the normalized dumps are identical (empty diff) | `schema_*_raw.sql.txt`, `schema_*_normalized.sql.txt`, `schema_diff_raw.txt`, `schema_diff_normalized.txt` (0 bytes), `schema_normalization.txt` |
| Revision currentness (application `classifyRevisions`, read-only session) over 34 message rows | identical | `revisions_source_before.txt`, `revisions_restore.txt` |
| Ownership | restore database owner `twins`; table owners in fingerprint identical; source has no ACLs (restored ACL count identical: 0) | fingerprint |
| Table count in restore | 32 | console |
| Other databases before/after (signals/validations/messages): twins_dev 198/82/318, twins_ci 49/35/50, twins_rehearsal_fresh 102/94/99, twins_rehearsal_upgrade 30/33/34 | unchanged | `baseline_other_dbs_before/after.txt` |
No unexpected differences were observed. Intentionally not compared: physical size, pg_stat counters, global roles, WAL/replication state.

## Not done / still pending
No mutating smoke test (not approved). No cleanup: `twins_restore_drill`, `$DRILL` and the archive are retained. Restore of Redis state, global roles, off-site copy, and any RPO/RTO measurement were out of scope.
