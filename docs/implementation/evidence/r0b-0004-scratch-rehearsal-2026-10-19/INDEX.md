# Evidence index - R0B migration 0004 scratch rehearsal (2026-10-19)

Files are copies of the rehearsal logs, passed through redaction (credentials in URLs, home/scratch paths replaced with `~`, `<repo>`, `$R`, `$SCRATCH`; ANSI colour codes stripped in `local-ci-verification/`). A pre-copy scan found no passwords, tokens, API keys or connection strings in the originals; only path redaction changed the content. Extension `.txt` is used because `.gitignore` excludes `*.log`. Nothing here is committed. Not copied: node_modules, database files, scratch folders, the pre0004 migration copy.

**Legend.** LOGGED = the statement is directly visible in the preserved file. AGENT-REPORTED = produced by an ad-hoc command or by my reasoning, not captured in a preserved log; verify independently before relying on it.

## 1. Original failure (first run)
| Item | Evidence | Status |
|---|---|---|
| Baseline `twins_dev` 198/82/0, both scratch names absent | `first-run/_script_console_output.txt` | LOGGED |
| Fresh DB created and migrated 0000-0004 (5 tracking rows) | `first-run/A1_create_fresh.log.txt`, `A2_migrate_fresh.log.txt`, console output | LOGGED |
| Runtime tests: `e2ePipeline` failed (extra bear factor `bear.no_corroborating_context`), other 4 files passed (1 failed, 18 passed) | `first-run/A3_runtime_tests_fresh.log.txt` | LOGGED |
| Script stopped at A3, preserved DBs/logs | `first-run/_script_console_output.txt` ("STOP: A3...") | LOGGED |
| Cause: ambient macro/news data in `twins_dev` (102 macro / 325 news rows vs 0 in the fresh DB) making the exact bear-factor set differ | not preserved (ad-hoc queries) | AGENT-REPORTED (hypothesis, not experimentally isolated) |
| The assertion fix itself | working-tree diff of `tests/integration/runtime/e2ePipeline.test.ts` | not in this directory |

## 2. Fresh database: resumed run
Note: the resumed tests ran on a migrated database that already held data from the earlier partial run; it was not empty.
| Item | Evidence | Status |
|---|---|---|
| Isolated `envGuard` + `e2ePipeline` after the fix: 4/4 | `resumed-run/A3_isolated_e2e.log.txt` | LOGGED |
| Resume guards (fresh exists, 5 migrations, 0004 schema, upgrade absent) | `resumed-run/_script_console_output.txt` | LOGGED |
| A3 runtime directory: 5 files / 19 tests passed | `resumed-run/A3_runtime_tests_fresh.log.txt` | LOGGED |
| A4 full integration: 24 files / 120 tests passed, none failed or skipped | `resumed-run/A4_full_integration_fresh.log.txt` | LOGGED |
| The 5 failures seen earlier on unmigrated `twins_dev` now pass; their original cause was never traced individually | earlier session output only | AGENT-REPORTED |

## 3. Upgrade rehearsal
| Item | Evidence | Status |
|---|---|---|
| Pre-0004 chain applied (4 rows); fixtures 5 signals / 5 validations / 6 sources | `B1b_migrate_pre0004`, `B2_fixtures`, console | LOGGED |
| Duplicate preflight: exactly one duplicate (message `...0c3`, signals `...d3`,`...d4`), 0 raw-message duplicates | `B3_preflight` | LOGGED |
| Expected failure: `could not create unique index "signals_telegram_message_parser_unique"` | `B4_migrate_expected_failure` | LOGGED |
| Rollback checks: 0 new columns, 0 new indexes, tracking rows 4, data 5/5 | console (`OK B4 ...` lines) | LOGGED |
| Numeric exit status of the failing `npm run db:migrate` | not stored; script asserted non-zero | AGENT-REPORTED |
| Scratch remediation: `DELETE 1` of `...0000000000d4`; 5/5 -> 4/4 | `B5_remediate`, console | LOGGED |
| Reapply: 5 tracking rows, `parser_version` = `legacy-unversioned`, default dropped | console (`OK B6 ...`) | LOGGED |
| Chat-ID report: recoverable 2, ambiguous_shared 2, conflicting 1, unrecoverable 1; apply `UPDATE 2` | `B7a_chat_report`, `B7b_chat_apply` | LOGGED |
| Assertions: all `legacy-unversioned`, all keys NULL, 0 duplicates, chat_id only on the two recoverable sources, 4/4/6 counts | `B8_assertions` | LOGGED |
| Upgrade runtime tests: 5 files / 19 tests passed | `B9_runtime_tests_upgrade` | LOGGED |

## 4. Baselines and Redis
| Item | Evidence | Status |
|---|---|---|
| `twins_dev` before (step 0) and after (step 9) both `198/82/0` | `resumed-run/_script_console_output.txt` | LOGGED |
| Redis `bull:r0b_test_*` leftovers after resumed run: 0 | `resumed-run/Z_redis_scan.log.txt` | LOGGED |
| Redis leftover check after the first (failed) run: 0 | ad-hoc command | AGENT-REPORTED |

## 5. Local CI-path verification (clean copy, NOT a hosted run)
`local-ci-verification/`: `npm ci` from the lockfile into an empty directory (copy of the current working tree, excluding node_modules/.git/dist), then typecheck, lint, unit tests, workspace builds and the CI guard. All LOGGED: typecheck exit 0, lint 0 errors / 31 warnings, unit 23 files / 209 tests, builds (api, scheduler, worker) exit 0, `ciGuard` 4/4. Integration tests were NOT run in the clean copy (they need a `twins_ci` database; awaiting approval). Node used: v26.5.0 (CI matrix targets 20 and 22: unverified locally).

## 6. Local clean-copy CI-style verification (2026-10-19) - NOT a GitHub Actions run
Directory: `local-clean-copy-ci-style/` (logs, `exit_codes.txt`, `integration-junit.xml.txt` with hostname redacted). Target: new role `twins_ci` and database `twins_ci` in the existing `twins-postgres-test` (127.0.0.1:15432), Redis 127.0.0.1:16379, `TWINS_CI=1`, `LIVE_TRADING=false`, Node v26.5.0 / npm 10.9.8. The clean copy was synced with the current working tree first (lockfile and all manifests byte-identical to the main tree; `npm ci` from the earlier step still applied).
| Item | Evidence | Status |
|---|---|---|
| role/db were absent; created (role attributes: superuser f, createdb f, createrole f, inherit t (PostgreSQL default), 0 memberships; owner `twins_ci`) | `_script_console_output.txt`, `role_attributes.txt`, `db_owner.txt` | LOGGED |
| CI guard 4/4 passed before migrations; fresh chain migrated; `verify-migrations.mjs`: 5 migrations recorded, 0004 structures present, `parser_version` has no default | `ci_guard.txt`, `migrate.txt`, `verify_migr.txt` | LOGGED |
| Full integration: 25 files (24 passed, 1 skipped), 124 tests (121 passed, 3 skipped, 0 failed); the skips are the 3 `envGuard` rehearsal-only tests (inactive without `TWINS_REHEARSAL=1`) | `integration.txt`, `integration-junit.xml.txt` (tests=124 failures=0 errors=0) | LOGGED |
| Exit codes: create_role 0, create_db 0, ci_guard 0, migrate 0, verify_migr 0, integration 0, redis_scan 0 | `exit_codes.txt` | LOGGED |
| Redis: SCAN of `bull:r0b_test_*` after the run: 0 keys (no FLUSH, no deletion by this step) | `redis_scan.txt` | LOGGED |
| Read-only baselines before = after: twins_dev 198/82/318/332; twins_rehearsal_fresh 102/94/99/81; twins_rehearsal_upgrade 30/33/34/24 (signals/validations/messages/sources) | `baseline_before.txt`, `baseline_after.txt` | LOGGED |
| Node 20 / 22 not exercised; no hosted run | n/a | not verified |
