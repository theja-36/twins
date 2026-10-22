# Checkpoint plan and file classification (PLAN ONLY - no branch, commit or push created)

## What was tested (not assumed)
The proposed code checkpoint **CP1** was assembled in an isolated scratch directory from `git archive HEAD` plus the allowlist (re-verified after the F1 remediation with the updated list in `review/checkpoint/cp1_allowlist.txt`: 70 files after the rehearsal-guard change), then: `npm ci` exit 0 (282 packages), `tsc -b` exit 0, `eslint` 0 errors / 31 warnings, `vitest run` 26 files / 230 tests passed, `ci.yml` parses, and no file references `docs/` paths. The integration suites were not re-run in the scratch directory (they need a database); the same code passed them in the main tree on `twins_ci` (25 files passed, 1 skipped; 126 tests passed, 3 skipped). Migration 0004 is included in CP1 (applied-chain proven on scratch databases and `twins_ci`).

## Why seven slices do not work as files
Six product files carry several concerns in the same hunks: `apps/api/src/index.ts` (R0A auth rewrite + correlation, 2 hunks), `services/worker/src/index.ts` (pool lifecycle + idempotency + correlation + failure handling, 8 hunks), `packages/shared/src/index.ts`, `packages/ingestion/src/telegram.ts` (3), `packages/signals/src/ingestSignal.ts` (4), `adapters/telegram/src/botApi.ts` (5). Schema/migration 0004, the idempotency code and ~12 test files depend on each other (e.g. tests use `parserVersion`; the worker imports shared helpers). A "R0A only" or "correlation only" commit would need interactive hunk splitting (`git add -p`) and each intermediate state would have to be built and tested separately; otherwise the intermediate commits are broken. **Recommendation: fewer, coherent checkpoints.**

## Proposed checkpoints (tentative; owner decides; nothing created)
1. **CP1 - code, schema/migrations, tests, CI/tooling** (the 62 files: 32 modified tracked files + new code/test/CI files). Builds and unit-tests independently as shown above. Optional finer split ONLY if bisectable history is wanted: R0A hunks vs R0B hunks via `git add -p`, each intermediate verified in scratch like CP1.
2. **CP2 - documentation and rehearsal tooling:** `docs/implementation/*.md`, `R0B_0004_preflight.sql`, `docs/implementation/rehearsal/` (scripts/SQL), `docs/implementation/review/` (this review material).
3. **CP3 - evidence (owner decision):** `docs/implementation/evidence/` (87 redacted text/JSON files, ~4 directories). Version them, keep them untracked, or store elsewhere.
4. **Owner review, not part of any checkpoint until decided:** `TWINS_Planning_Pack/` (17 files, input documents - tracked or not is the owner's call) and `.vscode/settings.json` (user-owned editor config, contains `antigravity.autoOpenFiles`; do not commit or delete without the owner). Nothing is discarded.

## Exclusions / hygiene (before any commit)
- Never stage: `node_modules/`, `dist/`, `*.tsbuildinfo`, `reports/`, scratch dirs (already ignored or outside the repo), the binary backup dump (outside the repo), any `.env*` other than `.env.example`.
- Secret scan on the staged set (test-only credentials `twins_dev_password`, `ci_only_not_a_secret`, `test-twins-api-key-r0b`, `test-telegram-secret-r0b` are known and intentional - confirm none is reused elsewhere): `git diff --cached` review, `git grep -n -I -E "(password|secret|token|api[_-]?key)\s*[=:]"` on staged paths.
- `git diff --cached --check`, then the full local check set (typecheck, lint, unit, integration on the guarded target) before each commit.
- Commit messages carry the attribution line required by the session instructions at commit time; branch only, never `main`; no push without separate authorization.

## Not included in CP1 on purpose
F2 changes (0005 migration, schema patch, `intelligence.ts` patch, promoted tests) and the test-target configuration: both are proposals awaiting approval; including them would put a schema ahead of its migration or unreviewed changes into the checkpoint.

## Coupling found and fixed while re-verifying (2026-10-19)
The new unit test `tests/unit/rehearsal/guardAllowlist.test.ts` reads `docs/implementation/rehearsal/migrate-folder.mjs` (docs/tooling checkpoint). In the isolated code-only checkpoint it failed (file absent). The sync assertion is now skipped when that file is absent; the allowlist assertions still run in the code checkpoint. Re-verified: the 70-file code checkpoint builds and passes in isolation.

## Refresh after the F2 promotion (2026-10-19)
The code checkpoint (CP1) is now **74 files** (`review/checkpoint/cp1_allowlist.txt`): it adds `packages/database/drizzle/0005_r0b_signal_evidence_unique_links.sql`, `meta/0005_snapshot.json`, `tests/integration/runtime/evidenceLinks.test.ts` and the newly modified `packages/signals/src/intelligence.ts` (`schema/signals.ts` and `meta/_journal.json` were already in CP1). Re-verified in isolation from `HEAD`: `tsc -b` 0, eslint 0 errors / 31 warnings, unit 286 passed + 1 skipped (docs-dependent sync test), `ci.yml` parses.
Dependency relationships inside CP1 (must travel together):
- `meta/_journal.json` <-> every `NNNN_*.sql` and `meta/NNNN_snapshot.json` (all six entries have both: checked).
- `schema/signals.ts` index definitions <-> migration 0005 + its snapshot (`drizzle-kit generate` reports no pending change: checked).
- `evidenceLinks.test.ts` needs migration 0005 on its target database: the CI fresh-chain job applies it before the integration suite; local databases that predate 0005 (`twins_ci`, `twins_dev`, retained 0004 rehearsal databases) will fail that test and any further `db:migrate` on them fails on existing duplicate links until separately approved remediation.
- The writer change in `intelligence.ts` does not depend on 0005 to run (it keeps the existence check), only to be race-free.
- Migration 0004 and its snapshot are untouched and precede 0005.
Docs checkpoint additions: `review/f2/*` (the patches are now APPLIED; do not re-apply them), `evidence/r0b-f2-scratch-rehearsal-2026-10-19/`, `evidence/r0b-f2-promotion-verification-2026-10-19/`.

## Refresh after the explicit test-target configuration (2026-10-19) - still PLAN ONLY, nothing staged
CP1 is now **96 files** (`review/checkpoint/cp1_allowlist.txt`): the 74 above plus the 20 integration test files whose silent `twins_dev` fallback was removed, the new `tests/integration/{targetConfig,migrationState,globalSetup}.ts`, `tests/unit/rehearsal/targetConfig.test.ts`, and **`docs/implementation/rehearsal/migrate-folder.mjs`**, which is deliberately moved into CP1 (`vitest.config.ts` and `vitest.integration.config.ts` were already members).
**Coverage decision:** with `migrate-folder.mjs` in CP1 the rehearsal-allowlist sync assertion runs in the isolated code checkpoint. Re-verified from `git archive HEAD` + allowlist: `npm ci` 0, `tsc -b` 0, eslint 0 errors / 31 warnings, unit **32 files / 307 tests passed, 0 skipped** - identical to the main tree. (The previous 74-file CP1 skipped that one assertion; that reduced coverage no longer applies to this list. If the owner removes the file from CP1, the assertion skips again and coverage is one test lower.)

Classification of everything in the working tree (nothing deleted or discarded; counts from `git status -uall`):
1. **Product / schema / test / CI** - all 96 CP1 files: modified tracked product code, migrations 0004+0005 with snapshots/journal, tests (unit + integration), `.github/workflows/ci.yml`, `scripts/ci/verify-migrations.mjs`, `infrastructure/docker/docker-compose.test.yml`, the two vitest configs, and `migrate-folder.mjs` (tooling kept in CP1 only for the sync test).
2. **Operational tooling and documents (CP2)** - `docs/implementation/*.md`, `R0B_0004_preflight.sql`, `docs/implementation/rehearsal/` (13 remaining files), `docs/implementation/review/` (27 incl. checkpoint lists; the F2 patches are APPLIED, do not re-apply).
3. **Curated redacted evidence (CP3, owner decision)** - `docs/implementation/evidence/` (155 files incl. the new `r0b-test-target-config-2026-10-19/`): version, keep untracked, or store elsewhere. Evidence files contain no credentials (checked for the container password; the earlier directories were redacted when created).
4. **`TWINS_Planning_Pack/`** (17 files) - owner decision; input documents, not part of any checkpoint.
5. **`.vscode/settings.json`** - user-owned editor config; not touched, not in any checkpoint.
Every working-tree path outside docs/planning/.vscode is in CP1 (checked: none left over).

Behavioural consequence to know before committing: the integration suite no longer runs without `TWINS_REHEARSAL=1` or `TWINS_CI=1`. Anyone who relied on the implicit local `twins_dev` default must now use an approved rehearsal database or a `twins_ci` database; `twins_dev` is refused by design.
