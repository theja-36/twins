# Evidence index - F2 promotion and main-tree verification (2026-10-19)

Four statuses, kept separate:
1. **Scratch rehearsal passed** (earlier, see `../r0b-f2-scratch-rehearsal-2026-10-19/INDEX.md`). Its script asserted each outcome but did not store every numeric exit code; that limitation stands and no codes were reconstructed.
2. **F2 files promoted** into the main working tree (local file changes only): the six exact tested versions.
3. **Main-tree verification passed** (this directory; numeric exit codes recorded in `exit_codes.txt`).
4. **`twins_ci` and `twins_dev` are still NOT migrated or remediated** (4 and 5 tracking rows; 1 and 103 surplus duplicate links respectively). No migration was applied anywhere in this task.

Promoted files (byte-identical to the versions tested in the rehearsal's patched copy; checked with `cmp`):
`packages/signals/src/intelligence.ts` (writer: existence check kept + `ON CONFLICT DO NOTHING`), `packages/database/src/schema/signals.ts` (3 partial unique indexes), `packages/database/drizzle/0005_r0b_signal_evidence_unique_links.sql`, `packages/database/drizzle/meta/0005_snapshot.json`, `packages/database/drizzle/meta/_journal.json` (6 entries), `tests/integration/runtime/evidenceLinks.test.ts`.
Before promotion the three tracked files matched the rehearsal baseline hashes exactly (no intervening changes); the only other difference between the rehearsal copy and the main tree was two status documents edited afterwards. Migration 0004 SQL and snapshot hashes are unchanged.

| Check (command) | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 0 errors, 31 warnings (same as before) |
| `npm test` | 0 | 31 files / 287 tests passed |
| `npm run build --workspaces --if-present` | 0 | api, scheduler, worker built |
| `git diff --check` | 0 | clean |
| Target state read-only before any test: `twins_rehearsal_f2_fresh` | n/a | 6 tracking rows, all 6 recorded hashes equal the promoted main-tree migration files, 3 partial unique indexes, no other sessions (migration-hash check exit 0) |
| rehearsal guard `envGuard.test.ts` (explicit URLs, `TWINS_REHEARSAL=1`, `LIVE_TRADING=false`) | 0 | 3 passed |
| `evidenceLinks.test.ts` against the F2 fresh scratch DB | 0 | 4 passed |
| `npm run test:integration` (+JUnit) against the F2 fresh scratch DB | 0 | 29 files: 27 passed, 2 skipped (gated crash test, CI guard); 135 tests: 130 passed, 5 skipped, 0 failed |
| Post-checks (read-only) | n/a | scratch DB: 6 tracking rows, 0 duplicate link groups; no sessions left; no vitest/worker processes; 0 `bull:r0b_test_*` keys; other databases' counts unchanged; `twins_dev` 4 and `twins_ci` 5 tracking rows |
Not run in this task, by instruction: any test against `twins_ci` or `twins_dev`; any migration.
Noted in `integration_full.txt`: one `worker.job.failed` JSON line (errorCode INGESTION_FAILED) comes from the intentional injected-failure retry scenario; it is expected output, not a failed test.
Consistency checks (terminal output): every journal entry has a SQL file and a snapshot; `drizzle-kit generate` in a scratch copy reports "No schema changes, nothing to migrate" (schema and migrations agree); the isolated 74-file code checkpoint builds (tsc 0, eslint 0 errors, 286 passed / 1 skipped unit tests).
