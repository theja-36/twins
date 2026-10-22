# Evidence index - F2 scratch rehearsal (migration 0005 draft + conflict-safe evidence-link writer), 2026-10-19

Scope: rehearsal on two NEW scratch databases from a patched COPY of the tree. **Nothing was promoted**: the main tree still has no 0005, no schema patch, no writer patch and no evidence-link test (hash-verified). F1 independent review remains open. Redacted copies of the logs; originals stay in the scratchpad. LOGGED = in these files; AGENT-REPORTED = from terminal output only.

| Item | Result | Source | Status |
|---|---|---|---|
| Preflight: both databases absent; patched-copy path absent; archive sha256 `edc65ec3...b757b` matches; `LIVE_TRADING=false`, `TWINS_REHEARSAL=1`, test Redis only | passed | `console_output.txt` | LOGGED |
| Patched copy = main tree + exactly six files (2 patches, 0005 SQL, 0005 snapshot, draft journal, evidence-link test); 0004 SQL and snapshot byte-identical | passed | `logs/copy_vs_main.txt`, `console_output.txt` | LOGGED |
| Patched-copy build: `npm ci` (282 packages), `tsc -b` (empty output), unit suite **31 files / 287 tests passed** | passed | `logs/npm_ci.txt`, `tsc.txt`, `unit.txt` | LOGGED |
| Upgrade DB `twins_rehearsal_f2_upgrade`: restored from the retained archive; 5 migrations; 3 duplicate groups / 7 surplus rows | as expected | `console_output.txt`, `logs/u2_restore.txt`, `u3_preflight.txt` | LOGGED |
| **Negative control** (patched writer, no index): concurrency test FAILED with `SIGNAL_EVIDENCE_DUPLICATES: expected [ ...(3) ] to deeply equal []`; the other 3 evidence-link tests skipped by filter; afterwards 6 groups / 16 surplus rows | as expected | `logs/u4_control.txt` | LOGGED |
| Preconditions before remediation: groups differing beyond id/created_at = 0; foreign keys referencing `signal_evidence` = 0; no other session connected to the database | held | `console_output.txt` | LOGGED |
| **Expected 0005 failure**: `could not create unique index "signal_evidence_signal_market_unique"` (Key (signal_id, market_observation_id) duplicated); rollback: still 5 tracking rows, 0 `signal_evidence_signal_%_unique` indexes, 16 surplus rows untouched | as expected | `logs/u5_expected_failure.txt`, `console_output.txt` | LOGGED |
| Export: 16 data rows (header `id,signal_id,...,rn`) | exact | `removed_signal_evidence_rows.csv` | LOGGED |
| Remediation (scratch only): `DELETE 16`; **deleted ids == exported ids** (`ids_deleted.txt` identical to `ids_exported.txt`; 31 rows before, 15 after, 0 rows added) | reconciled by id | `logs/u6_remediation.txt`, `ids_*.txt` | LOGGED |
| Re-apply 0005: 6 tracking rows; 3 partial unique indexes (market, macro, news) with `WHERE <ref> IS NOT NULL`; 0 duplicate groups | passed | `logs/u7_migrate.txt`, `console_output.txt`; confirmed afterwards by read-only queries | LOGGED + AGENT-REPORTED |
| Tests on the upgraded DB (rehearsal guard first: 3 passed): evidence-link tests 4/4, signals + runtime directories; **14 files: 12 passed, 2 skipped; 52 tests: 47 passed, 5 skipped, 0 failed** (skips: gated `crashRecovery` 1, `ciGuard` 4) | passed | `logs/u8_tests.txt`, `u8_tests_guard.txt` | LOGGED |
| Fresh DB `twins_rehearsal_f2_fresh`: full chain 0000-0005, 6 rows, 3 partial indexes | passed | `logs/f2_migrate.txt`, `console_output.txt` | LOGGED |
| NULL-semantics probe (TEMP tables, rolled-back transaction): plain composite unique accepted 2 identical rows; partial unique index rejected the second (`probe_partial_a`) | as expected | `logs/f3_null_probe.txt` | LOGGED |
| Tests on the fresh DB: same suites; **12 passed / 2 skipped files, 47 passed / 5 skipped tests, 0 failed**; guard 3/3 | passed | `logs/f4_tests.txt`, `f4_tests_guard.txt` | LOGGED |
| Existing databases before == after (signals/validations/evidence): twins_dev 198/82/1146, twins_ci 363/296/2289, twins_rehearsal_fresh 102/94/166, twins_rehearsal_upgrade 30/33/19, twins_restore_drill 30/33/19 | unchanged | `logs/baseline_before.txt`, `baseline_after.txt` | LOGGED |
| Main tree before == after (`git status` hash and hashes of `intelligence.ts`, `schema/signals.ts`, `_journal.json`); source archive sha256 unchanged | unchanged | `logs/main_tree_before.txt`, `main_tree_after.txt`, `console_output.txt` | LOGGED |
| Leftovers: no connections to the scratch databases from other sessions, no processes mentioning the patched copy, 0 `bull:r0b_test_*` keys, 0 crash-test children (also re-checked after the run) | none | `logs/leftovers_final.txt`, `redis_scan.txt` | LOGGED + AGENT-REPORTED |
| Per-command exit codes: the script asserts exit 0 for every normal step and non-zero (plus the exact error text) for the two expected failures, and finished with exit 0; individual codes were not stored separately | script exit 0 | `console_output.txt` | LOGGED (script level) |

Limits: scratch databases only; the upgrade copy uses an archived dataset with 3 duplicate groups plus 3 created by the negative control, not production-like volume; Node v26.5.0 only; no real outage; twins_ci (103 surplus rows) and twins_dev (1) still contain duplicates and would need their own approved remediation before 0005 could be applied to them.
