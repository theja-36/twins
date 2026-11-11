# Stage 08 — test and acceptance report (2026-11-11)

State: **ENGINEERING COMPLETE** — hosted CI green on commit `444b759` (run 43089021401, 7/7 jobs, first attempt). The sections below the CI table record the earlier local verification against PostgreSQL 16.15 and Redis 7 (Node 20 and 22 were not installed locally; hosted CI covers them).

## Hosted CI (GitHub Actions): the completion evidence
Branch `feat/master-build`, commit `444b759` (pushed as a fast-forward from `a8e4ff5`; not merged, not deployed). Run [43089021401](https://github.com/theja-36/twins/actions/runs/43089021401): **success, all 7 jobs, first attempt**.
| Job | Result |
|---|---|
| static (lint, typecheck, build, secret scan) | success |
| unit, Node 20 | success: **263 files, 4,209 tests passed** |
| unit, Node 22 | success: **263 files, 4,209 tests passed** |
| integration, Node 20 (PostgreSQL 16, Redis 7) | success: **87 files passed, 5 skipped; 1,145 tests passed, 15 skipped** |
| integration, Node 22 (PostgreSQL 16, Redis 7) | success: **87 files passed, 5 skipped; 1,145 tests passed, 15 skipped** |
| crash recovery (real SIGKILL, Node 22) | success: **4 files, 12/12 tests**: worker 1, research 2, execution 3, **outcome 6** |
| ci-gate | success |
Inside the integration jobs (both Node versions): the fresh-chain migration recorded **47 migrations** and `verify-migrations` printed the 0046 line (*one trade outcome per paper position and append-only owner-only analytics snapshots present*); `stage08Recovery` 4/4, `stage08Snapshots` 10/10 and `stage08Correction` 8/8 passed; the post-run audit-chain verification passed (`audit_events` chain `ok`); and **`offhostBackup.test.ts` passed on both Node versions with the real `pg_dump`/`pg_restore`**, which could not run locally. The skipped tests are the real-SIGKILL files, which are gated and run in the dedicated crash-recovery job (all 12 passed there). No job failed and nothing was retried or changed after the push.

### Follow-up: a real race found by the documentation commit's CI run (G-52)
The documentation-only commit `b44e843` (run [43090565663](https://github.com/theja-36/twins/actions/runs/43090565663)) FAILED one job (integration, Node 20): the Stage 07 test "concurrent execution requests ... create one order" raised `a FILLED paper order cannot change state`. The code was identical to `444b759`, so a docs change could not be the cause; the failure was a real, timing-dependent race in the Stage 07 execution path (a stale `SUBMITTED -> ACCEPTED` step after a concurrent caller had filled the order), recorded as **G-52**. It was reproduced deterministically (a rival finishes the entry between the caller's two status steps), then fixed with a compare-and-set order-status step at all five call sites, with three new tests. The `444b759` result above is unchanged and still correct; the fix is a separate commit whose hosted CI result is recorded in the gap register once it is green.

## Environment (local, Docker 29.6.1)
`postgres:16-alpine` (PostgreSQL 16.15) and `redis:7-alpine`, loopback only, CI credentials (`twins_ci`). Node v26.13.0 for every run; v24.14.1 for the unit suite. Environment variables: `TWINS_CI=1 LIVE_TRADING=false NODE_ENV=test DATABASE_URL=postgresql://twins_ci:…@127.0.0.1:5432/twins_ci REDIS_URL=redis://127.0.0.1:6379` (crash job: Redis `…:16379`, `TWINS_CRASH_TEST=1`).

## Results
| Step | Command | Result |
|---|---|---|
| Migrations, fresh database | `npm run db:migrate -w @twins/database` | applied; `drizzle.__drizzle_migrations` = **47** |
| Chain verification | `node scripts/ci/verify-migrations.mjs` | exit 0, now including the 0046 block (unique outcome index, `analytics_snapshots` forced RLS, owner policy, append-only triggers, 3 CHECKs) |
| 0046 refuses bad data | applying 0046 to a database holding duplicate outcomes | refused by the pre-flight with `migration 0046 refused: … more than one trade outcome` (observed; that database was then discarded) |
| journal / snapshot / drift | `drizzle-kit check`; `generate` | consistent, "No schema changes" after the schema edit was generated once |
| Unit suite | `npx vitest run` | **263 files, 4,209 tests passed** on Node 26.13.0 and on Node 24.14.1 (4,178 at the Stage 07 baseline: +31) |
| Typecheck / lint | `npx tsc -b`; `npx eslint .` | clean; 0 errors (824 warnings, all the existing non-null-assertion kind) |
| Tracker | `node scripts/product/tracker.mjs check` | ok (27 Module 15 rows) |
| Full integration suite | `npx vitest run --config vitest.integration.config.ts` | **86 files passed, 1 failed, 5 skipped; 1,144 tests passed, 1 failed, 15 skipped; 296 s** |
| Crash job (as CI defines it) | the four crash files | **12/12**: worker 1, research 2, execution 3, **outcome 6** |
| Audit chains | `npm run audit:verify -- --require-ddl-watch` | exit 0 (includes the correction audit events) |

**The one failing integration test** is `tests/integration/backup/offhostBackup.test.ts` (`spawn pg_dump ENOENT`): `pg_dump`/`pg_restore` are not installed on this Mac (CI installs them). It is unrelated to Stage 08; its migration-count constants were moved 46 → 47 (they cannot be exercised locally) and **it is unverified until hosted CI**. It passed in hosted CI at 46 migrations in Stage 07.

## Stage 08 tests added
| File | Tests | Proves |
|---|---|---|
| `tests/integration/outcomes/stage08Recovery.test.ts` | 4 | (red before the fix) one outcome per position under 3 racing writers; an orphaned CLOSED position is repaired then attributed FINAL once and is stable under repetition; 6 concurrent closers → one CLOSED event, one outcome; 5 concurrent attribution workers → one FINAL |
| `tests/integration/runtime/outcomeCrashRecovery.test.ts` | 6 (real SIGKILL) | below |
| `tests/integration/outcomes/stage08Snapshots.test.ts` | 10 | 0046 constraints, immutability, owner RLS; determinism; evidence change = new snapshot; 8 concurrent requests = 1 row; concurrent first build = 1 writer; true snapshot isolation; STALE fallback; API/worker parity; 9 invalid settings rejected |
| `tests/integration/outcomes/stage08Correction.test.ts` | 8 | below |
| `tests/unit/outcomes/completion.test.ts` | 21 | metric accuracy and pure snapshot functions |
| `tests/unit/database/outcomeIntegrityMigration.test.ts` | 5 | static checks of 0046 |
| `tests/unit/trading/crashHold.test.ts` | +3 (6) | the statement-level crash seam |
| `tests/unit/api/userApi.test.ts` | +2 (24) | snapshot/freshness metadata; dimension and dataset |
Existing assertions were not weakened. Changes to existing tests: migration-count pins 46 → 47 (three files), the Stage 07 "0045 is last" test now finds 0045 by tag and checks its predecessor, a misleading test title reworded, the learning safety test's writer allow-list made *more* precise (pinning `insertSnapshot` as the single extra writer), and the `userApi` fake data layer extended to the new contract.

## A1 — recovery and SIGKILL evidence (`outcomeCrashRecovery.test.ts`)
The child runs the real `advanceOpenOrders` and `runLearningCycle`; the only seam is a pass-through database wrapper that holds the process at a chosen **statement** (`tests/support/crashHold.ts`); only the test-spawned pid is ever killed.
1. **SIGKILL inside the close transaction, after the outcome insert, before COMMIT** → the database rolled the whole close back (position OPEN, 0 outcomes, 0 CLOSED events, both fills intact); the restarted execution worker closed it once (`healed: 1`); a learning worker then wrote one FINAL.
2. **SIGKILL immediately after the close + outcome transaction COMMITTED** → position CLOSED with its one outcome, unattributed; a restarted execution worker has nothing to repair (`healed: 0`); a restarted learning worker writes one FINAL.
3. **SIGKILL during attribution, before COMMIT** → no attribution; the dead run's lease is still RUNNING; the restarted worker (clock past the lease) marks it ABANDONED and attributes once.
4. **SIGKILL immediately after the attribution COMMITTED** → one FINAL exists; two further learning cycles and an execution cycle leave the database snapshot identical.
5. **Three recovery workers at once** after a crash → exactly one outcome, one CLOSED event, one FINAL.
6. **A position left CLOSED without an outcome by older code**, repaired by three concurrent workers → one outcome, one FINAL; repetition changes nothing.
Passes: 4 separate runs of the file (first run, the full crash job, and two repeats). **Mutation check:** with the outcome insert removed from the close transaction, case 1 fails (the close is no longer atomic); cases 2–6 still pass because the recovery sweep independently repairs a missing outcome, so the guarantee has two layers and the atomicity test detects the first. The stage08Recovery tests were first run **red** against the unfixed code (`expected 3 to be 1`; `healed` 0).

## A2 — snapshot consistency and determinism evidence
- **One consistent read:** inside a `REPEATABLE READ` read-only transaction, a correction committed by another connection mid-read changed neither the fingerprint nor the loaded rows, and became visible to the next read (`stage08Snapshots` consistency test; the same isolation options are used by `readSnapshotInputs`).
- **Deterministic:** two independent reads of the same evidence give byte-identical canonical JSON and SHA-256 (also with `Date.now` shifted 74 years); `generatedAt` equals the evidence-derived as-of; the stored report still matches its recorded `report_sha256`.
- **Concurrent:** 8 simultaneous API requests and 6 simultaneous builds → exactly one stored row, all callers receive its id; with no snapshot yet, 8 concurrent builds → exactly one writer.
- **Not silently stale:** after an evidence change a new snapshot is built and the old row is untouched; if the rebuild fails the newest snapshot is returned with `freshness: STALE` and the reason; with none the request fails.
- **Isolation:** another user sees 0 rows through the restricted role and cannot insert for someone else; UPDATE, DELETE and TRUNCATE are refused even for the owner connection.

## A3 — configuration parity
The API and the learning cycle both call `loadOutcomeLearningConfig`; run with `TWINS_LEARNING_MIN_SAMPLE=45` / `MIN_DRIFT_WINDOW=40` the cycle stores one snapshot and the API serves **that same row** (`createdBy: LEARNING_CYCLE`, `INSUFFICIENT_DATA`, "fewer than 45"); the default settings give a different snapshot (different `configHash`) whose verdict says "fewer than 30". Nine invalid values (below the 30 floor, non-numeric, fractional, out-of-range hold-out, bad flag, age/interval bounds) are rejected by both the loader and `buildUserOps`.

## Metric accuracy (`completion.test.ts`)
Student-t 95% critical values agree with the published table to < 0.0006 at df 29, 30, 40, 60, 120, 1000 and are refused below 10 df; the expectancy interval for a hand-computed set (15×0.5 and 15×1.5) equals mean ± t·se and is wider than the normal interval; `0.1` summed 30 times is shown to be wrong in floating point while the metric returns exact `1.00000000` profit factor and `0.33333333` payoff; 3,000 outcomes keep every cent (`110.00`); eight-place R survives to `expectancyR.exact`; an attribution computes a missing R at 8 places; win + loss + breakeven shares sum to 1; Wilson intervals equal the shared implementation; percent drawdown and signal-pattern views are NOT_AVAILABLE with reasons.

## A4 — correction-command security evidence (`stage08Correction.test.ts`)
Dry run writes nothing and prints a plan plus a 16-hex token; a wrong token, or a token from a different actor, is refused; a confirmed run appends version 2 (original row byte-identical, names its predecessor, reason + evidence + actor recorded, evidence marker added) and exactly one hash-chained `audit_events` row; repeating it → `ALREADY_APPLIED`; three concurrent confirmations → one version, one audit row; naming the superseded version → refused; no difference to write → `NO_CHANGE`. **Refusals (exit 3, nothing written):** another user's attribution, an unknown attribution, a nonexistent owner, an inactive owner, a PARTIAL attribution. **Usage errors (exit 2):** 14 invalid inputs (bad ids, short/long reason, malformed/missing/traversal evidence, bad actor, unknown flag such as `--sql`, repeated or valueless flags). A source scan proves the script has no SQL, no update/delete, and a single writer (`insertCorrectionWithAudit`).

## Remaining / deferred
Real-price outcomes (G-30), MAE/MFE (G-31), OHLC estimates (G-32) and the pattern provider (G-23) are Stage 10/11 dependencies: the 8 Module 15 rows that depend on them or are limited by design (M15-01, 03, 04, 08, 09, 10, 12, 14) stay IN_PROGRESS / NOT_STARTED. Percent drawdown stays NOT_AVAILABLE (no equity curve). Open and minor: G-50 (snapshot inputs bounded at 5,000 rows, reported as `complete: false`) and G-51 (the user routes are not in the machine-readable OpenAPI document). The 12 live-mode rows stay deferred under G-48; Paper Trading is the only operational mode.
