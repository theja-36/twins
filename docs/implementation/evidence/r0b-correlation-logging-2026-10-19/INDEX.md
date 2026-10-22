# Evidence index - end-to-end correlation logging (2026-10-19)

Label: **end-to-end correlation logging** (not distributed tracing; no OpenTelemetry). Design: `docs/implementation/R0B_CORRELATION_LOGGING.md`. Redacted copies; LOGGED = visible in these files, AGENT-REPORTED = not preserved in a log.

| Item | File | Status |
|---|---|---|
| One real request across stages (client-supplied correlation id `sample-corr-0001`): accepted -> enqueue -> worker started/ingested/revision/signal/market/validation/completed, with signal and validation ids | `one_request_across_stages.jsonl` | LOGGED (produced by a one-off script against `twins_ci`; raw JSON records, fields not shown in the report sample are also present) |
| Full integration on the guarded `twins_ci` target after the change: 26 files (25 passed, 1 skipped), 129 tests (126 passed, 3 skipped, 0 failed) | `twins_ci_full_integration_final_pass.txt`, `...junit.xml.txt` | LOGGED |
| Runtime directory: 7 files (6 passed, 1 skipped), 28 tests (25 passed, 3 skipped) | `twins_ci_runtime_dir_pass.txt` | LOGGED |
| First run of the new integration test failed because my test expected the wrong error code for an injected insert failure (`UNEXPECTED_ERROR`; the product correctly logs `INGESTION_FAILED`); corrected the test, product unchanged | `first_run_failure_wrong_test_expectation.txt` | LOGGED |
| A later full-suite run failed once on a too-strict cross-process ordering assertion (worker started before the API logged the enqueue result); test corrected to assert order within each process; the real ordering property is documented as a limit | output overwritten by the final pass | AGENT-REPORTED |
| Unit tests 26 files / 230 tests passed; `tsc -b` exit 0; lint 31 warnings / 0 errors (HEAD 32); `git diff --check` clean; `npm ci --dry-run` exit 0 with the updated lockfile | terminal output only | AGENT-REPORTED |
| Redis `bull:r0b_test_*` leftovers after the runs: 0 | terminal output only | AGENT-REPORTED |
| Targets: `twins_ci` (127.0.0.1:15432), Redis 127.0.0.1:16379, `TWINS_CI=1`, `LIVE_TRADING=false`, CI guard 4/4 passed first | terminal output only | AGENT-REPORTED |
