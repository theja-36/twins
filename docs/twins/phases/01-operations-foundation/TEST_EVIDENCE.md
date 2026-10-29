# P01 test evidence

Record: date, commit, environment (local / rehearsal / CI / staging), command, result, artifact location. Never record credentials. Planned tests are described in [PLAN.md](PLAN.md) section 9; prior evidence for reused components is listed in section 4. All results are `NOT_RUN` until executed for this phase.

| Criterion | Test(s) | Result | Date | Commit | Environment | Artifact |
|---|---|---|---|---|---|---|
| A-01.1 | - | NOT_RUN | - | - | - | - |
| A-01.2 | - | NOT_RUN | - | - | - | - |
| A-01.3 | - | NOT_RUN | - | - | - | - |
| A-01.4 | - | NOT_RUN | - | - | - | - |
| A-01.5 | - | NOT_RUN | - | - | - | - |
| A-01.6 | - | NOT_RUN | - | - | - | - |
| A-01.7 | - | NOT_RUN | - | - | - | - |
| A-01.8 | - | NOT_RUN | - | - | - | - |
| A-01.9 | - | NOT_RUN | - | - | - | - |

## Stage 1 / Task 1 - shared LIVE_TRADING guard (closure evidence, 2026-10-29)
Base commit `4646ee7`; the Task 1 changes are uncommitted in the working tree (no commit authorized). Environment: local macOS, Node from the repo toolchain, **CI context** (`TWINS_CI=1`, `LIVE_TRADING=false`, `TRADING_MODE=paper`) against disposable Docker `postgres:16-alpine` (user/db `twins_ci`) and `redis:7-alpine` on 127.0.0.1:25432 / :26379, removed afterwards. Not a hosted-CI run (hosted CI has still never run: P01 item).

| Step | Command | Result |
|---|---|---|
| Lockfile | `npm ci`; then `npm install --package-lock-only --ignore-scripts` | clean install (283 packages); lockfile byte-identical to npm's own resolution; diff vs HEAD is only the `@twins/config` workspace dependency on approval-bot and web |
| Lint | `npm run lint` | 0 errors, 119 warnings (pre-existing class: non-null assertions) |
| Typecheck | `npm run typecheck` (`tsc -b --pretty`) | exit 0 |
| Unit | `npm test` (`vitest run`) | 74 files, 1028 tests passed, 0 failed (includes the Python capture and T1 suites run via vitest) |
| T1 Python | `python3 -I -W error::ResourceWarning tools/t1-feasibility/test_t1_check.py` | 60 tests OK (incl. `LiveTradingGuard`) |
| CI guard + migrations | `vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts`; `npm run db:migrate -w @twins/database`; `node scripts/ci/verify-migrations.mjs` | 4 passed; migrations applied through the guarded migrate entry point; 9 migrations verified |
| Integration | `npm run test:integration` | 35 files passed, 2 skipped; 192 tests passed, 4 skipped, 0 failed. Skips are opt-in by design: `envGuard` (3, rehearsal context only) and `crashRecovery` (1, needs `TWINS_CRASH_TEST=1`) |
| Crash/recovery (opt-in) | `TWINS_CRASH_TEST=1 vitest run --config vitest.integration.config.ts tests/integration/runtime/crashRecovery.test.ts` with `REDIS_URL=redis://127.0.0.1:16379` | 1 passed. A first attempt on port 26379 failed only because the test's child process refuses any Redis except the dedicated test Redis on :16379 (`workerChild.ts assertSafeTarget`); it was re-run against that sanctioned target, whose key count was unchanged (15 before, 15 after) |

No test was weakened, skipped or deleted. Existing tests were edited only where they pin an exact import/file list that now legitimately includes the guard (options-preview, options-demo verify, telegramCapture file list) or the approval bot's "no live-trading code" rule (now: only the refuse-to-start guard import is allowed, in index.ts, and nothing else from `@twins`).

## Stage 1 / Task 2 - database-backed runtime safety state and kill switch (2026-10-29)
Base commit `4646ee7`; Task 1 and Task 2 changes are uncommitted in the working tree. Environment: local, CI context against freshly created disposable Docker `postgres:16-alpine` (`twins_ci`, 127.0.0.1:25432) and `redis:7-alpine` (127.0.0.1:26379), removed afterwards; the crash test additionally used the project's dedicated test Redis on :16379 (its key count was unchanged, 15 before and after). Design: [RUNTIME_SAFETY_STATE.md](../../RUNTIME_SAFETY_STATE.md).

| Step | Command | Result |
|---|---|---|
| Install | `npm ci`; `npm install --package-lock-only --ignore-scripts` | 284 packages; lockfile byte-identical to npm's own resolution; diff vs HEAD only adds workspace entries (runtime-state, and `@twins/runtime-state` / `@twins/config` workspace dependencies); no dependency version changed |
| Lint | `npm run lint` | 0 errors, 140 warnings (the repository already carried 119, mostly non-null assertions; the new ones are in new test files) |
| Typecheck | `npm run typecheck` (`tsc -b --pretty`) | exit 0 |
| Unit | `npm test` | 79 files, 1136 tests passed, 0 failed (was 74 / 1028) |
| Migration | `npm run db:migrate -w @twins/database` on a fresh database | 10 migrations applied (0009 included) |
| Migration verification | `node scripts/ci/verify-migrations.mjs` | 10 recorded; 0009 controls, 3 seed events and all 7 triggers present |
| CI guard | `vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts` | 4 passed |
| Integration | `npm run test:integration` | 36 files passed, 2 skipped; 214 tests passed, 4 skipped (opt-in: `envGuard` x3 rehearsal-only, `crashRecovery` x1), 0 failed (was 35 / 192) |
| Crash/recovery (opt-in) | `TWINS_CRASH_TEST=1 vitest run --config vitest.integration.config.ts tests/integration/runtime/crashRecovery.test.ts`, `REDIS_URL=redis://127.0.0.1:16379` | 1 passed (after fixing the test's child worker to configure the DB-backed state like the production worker; before that it correctly refused every job, fail closed) |
| Real CLI run | `npm run safety:control -- status / set / events` against the test database | set kill=true -> exit 0 with two safety events; enabling trading during the halt -> exit 3 refused; missing reason -> exit 2; clear -> exit 0; `LIVE_TRADING=true` -> exit 81 |

New test files (all pass): `tests/unit/safety/{runtimeState,boundaries,executionBoundary,admin,runtimeStateCoverage}.test.ts`, `tests/integration/runtimeState/systemControls.test.ts` (19 + 2 CLI tests incl. concurrency, trigger integrity, fail-closed reader, API -> Redis -> worker end to end), additions to `tests/integration/approvalBot/rolePrivileges.test.ts`. Mutation check (done by hand, not committed): removing each of 12 gates/rules one at a time (API webhook, internal ingest, bot card creation, bot approve, validateSignal, signal creation, claim creation, order-intent wrapper, scheduler, worker, kill-switch precedence, unavailable -> active) made the safety/bot unit suites fail every time; no mutant survived.

Existing tests changed (none weakened, skipped or deleted): `targetConfig.test.ts` migration count 9 -> 10 (+0009 named); `stagingPackaging.test.ts` service counts 4 -> 5 shared-tag services and 6 -> 7 `pull_policy: never` (new `safety-control` service); `providerContracts.test.ts` enables trading in its own in-memory state before `placeOrder` (the boundary now refuses otherwise; refusal is covered in `executionBoundary.test.ts`); `liveGuardCoverage.test.ts` adds the new `safety-control` process; `approvalBot/static.test.ts` allows exactly the runtime-state reader/gate imports; `crash/workerChild.ts` configures the DB-backed state. Both vitest configs gained `tests/support/runtimeStateSetup.ts` (an explicit in-memory state with the seeded defaults for each test worker).

## Stage 1 / Task 3 - immutable audit trail and tamper evidence (2026-10-29)
Base commit `4646ee7`; Tasks 1-3 are uncommitted in the working tree. Environment: local, CI context (`TWINS_CI=1`, `LIVE_TRADING=false`, `TRADING_MODE=paper`) against freshly created disposable Docker `postgres:16-alpine` (`twins_ci`, 127.0.0.1:25432) and `redis:7-alpine` (127.0.0.1:26379), removed afterwards; the crash test again used the project's dedicated test Redis (:16379), key count unchanged (15 before and after). Design: [IMMUTABLE_AUDIT.md](../../IMMUTABLE_AUDIT.md).

| Step | Command | Result |
|---|---|---|
| Install | `npm ci`; `npm install --package-lock-only --ignore-scripts` | 285 packages; lockfile byte-identical to npm's resolution; diff vs HEAD adds workspace entries only (`runtime-state`, `audit-chain` and their workspace dependencies); no version changed |
| Lint | `npm run lint` | 0 errors, 211 warnings (the repository carried 119 before Task 2; the additions are non-null assertions in new test files) |
| Typecheck | `npm run typecheck` (`tsc -b --pretty`) | exit 0 |
| Unit | `npm test` | 81 files, 1179 tests passed, 0 failed (Task 2 ended at 79 / 1136) |
| CI guard | `vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts` | 4 passed |
| Migration | `npm run db:migrate -w @twins/database` on a fresh database | 11 migrations applied (0010 included) |
| Migration verification | `node scripts/ci/verify-migrations.mjs` | 11 recorded; 0010 chain columns, heads and ENABLE ALWAYS guards present |
| Integration | `npm run test:integration` | 37 files passed, 2 skipped; 278 tests passed, 4 skipped (opt-in: `envGuard` x3, `crashRecovery` x1), 0 failed (Task 2 ended at 36 / 214) |
| Audit verifier | `npm run audit:verify -- --require-ddl-watch` after the integration run | PASS, exit 0: 5 chains (audit_events 4, system_control_events 53, signal_validations 51, telegram_messages 115, options_claims 21 rows), ddl watch installed |
| Crash/recovery (opt-in) | `TWINS_CRASH_TEST=1 vitest run ... crashRecovery.test.ts`, `REDIS_URL=redis://127.0.0.1:16379` | 1 passed |
| Upgrade over legacy data (manual, scratch database) | migrate to 0009, insert 25 messages (quotes, backslash, newline, U+2028, emoji, jsonb with 1.50 / null), 5 audit events and a control change, apply 0010, `audit:verify` | PASS (backfilled chains verify); after an owner edited message chain_index 7 with the guard disabled, `audit:verify` exited 1: `FIRST FAILURE: payload_modified in telegram_messages at chain_index 7` |
| Real CLI runs | `npm run safety:control -- set/events`, `npm run audit:verify`, `LIVE_TRADING=true` | `--changed-by task3.closure` refused (exit 3, needs `operator:<name>`); `operator:` change recorded with `via cli/safety-control db_user=... chain#57`; live config refused (exit 81) |

New test files: `tests/unit/auditChain/verifier.test.ts` (22), `tests/unit/infrastructure/auditInfra.test.ts` (11), `tests/integration/auditChain/auditChain.test.ts` (63: append-only on all 5 tables x UPDATE/DELETE/TRUNCATE/replica mode, valid append flows incl. real application writers, ON CONFLICT without gaps, 20 concurrent appends, payload tamper / middle delete / newest delete / previous_hash / event_hash / payload_hash on all 5 chains, repeated index, disabled and dropped guards, external anchor defeating a head rewrite, verifier CLI pass / fail / usage / unreachable, DDL watch, operator identity CLI / service / raw SQL / CHECK enforcement, runtime-role grants and self-check, api and worker refusing to start as a privileged role with exit 82). It runs in its own scratch database (`twins_ci_scratch_*`, created from the migration chain and dropped afterwards) because it takes heavy locks and verifies whole chains. Mutation check (by hand, not committed): disabling each of 8 verifier checks (payload, previous_hash, event_hash, head, gap, trigger-enabled, hash definition, ownership) made the unit suite fail every time; no mutant survived.

Existing tests changed (none weakened, skipped or deleted; each is a direct consequence of the new protection or a new compose/migration): `targetConfig.test.ts` migration count 10 -> 11 (+0010 named); `stagingPackaging.test.ts` shared-tag services 5 -> 6 and `pull_policy` 7 -> 8 (new `audit-verify` job) and the runtime services' `DATABASE_URL` now pinned to `twins_app` (owner credential only for migrate / safety-control / audit-verify); `liveGuardCoverage.test.ts` adds the `audit-verify` process; `admin.test.ts` and `systemControls.test.ts` use the new `operator:` / `service:` identity convention and mechanism argument; `revisions.test.ts` builds its pre-migration "keyless validation" fixture by appending (it previously did `UPDATE signal_validations SET idempotency_key = NULL`, which is now impossible by design); `telegramCapture.test.ts` "a stored message cannot be removed while events reference it" now expects 23001 (the append-only guard fires before the foreign key) and additionally asserts the `ON DELETE RESTRICT` key still exists; `scripts/ci/verify-migrations.mjs` expects the 0010 chain triggers on `system_control_events`. `approvalBot/rolePrivileges.test.ts` gained assertions only.

## Stage 1 / Task 4 - mandatory stop-loss invariant (2026-10-29)
Base commit `4646ee7`; Tasks 1-4 are uncommitted in the working tree. Environment: local, CI context (`TWINS_CI=1`, `LIVE_TRADING=false`, `TRADING_MODE=paper`) against freshly created disposable Docker `postgres:16-alpine` (`twins_ci`, 127.0.0.1:25432) and `redis:7-alpine` (127.0.0.1:26379), removed afterwards; the crash test again used the project's dedicated test Redis (:16379), key count unchanged (15 before and after). Design: [MANDATORY_STOP_LOSS.md](../../MANDATORY_STOP_LOSS.md).

| Step | Command | Result |
|---|---|---|
| Install | `npm ci`; `npm install --package-lock-only --ignore-scripts` | 286 packages; lockfile byte-identical to npm's resolution after one correction (the lockfile lacked three new workspace dependency entries; fixed with `npm install --package-lock-only`, no version changed) |
| Lint | `npm run lint` | 0 errors, 116 warnings (211 after Task 3; the repository carried 119 before Task 2). New production code adds no non-null assertion; the earlier tasks' test files were converted to a `must()` helper (`tests/support/must.ts`) by an AST codemod |
| Typecheck | `npm run typecheck` (`tsc -b --pretty`) | exit 0 |
| Unit | `npm test` | 86 files, 1276 tests passed, 0 failed (Task 3 ended at 81 / 1179) |
| CI guard | `vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts` | 4 passed |
| Migration | `npm run db:migrate -w @twins/database` on a fresh database | 12 migrations applied (0011 included) |
| Migration verification | `node scripts/ci/verify-migrations.mjs` | 12 recorded; 0011 evidence chain, APPROVE invariant and eligibility view present |
| Integration | `npm run test:integration` | 38 files passed, 2 skipped; 309 tests passed, 4 skipped (opt-in: `envGuard` x3, `crashRecovery` x1), 0 failed (Task 3 ended at 37 / 278) |
| Audit verifier | `npm run audit:verify -- --require-ddl-watch` after the integration run | PASS, exit 0: six chains incl. stop_loss_validations (83 rows), ddl watch installed |
| Crash/recovery (opt-in) | `TWINS_CRASH_TEST=1 vitest run ... crashRecovery.test.ts`, `REDIS_URL=redis://127.0.0.1:16379` | 1 passed |
| Upgrade over legacy data (manual, scratch database) | migrate to 0010, insert an APPROVE verdict for a signal with NO stop-loss, apply 0011 | the legacy row is untouched (1 row, same rationale); the view reports `approval_eligible=false`, `legacy_no_stop_loss_evidence`; `audit:verify` PASS; a new APPROVE without evidence is refused: `APPROVE requires a VALID stop-loss validation for the signal (latest: none)` |

New test files: `tests/unit/stopLoss/validate.test.ts` (49: missing / null / empty / blank, zero, negative, non-numeric forms, NaN / +-Infinity, equal to entry, wrong side for BUY / SELL / CE / PE, beyond the maximum distance (boundary inclusive, env override, malformed override throws), valid BUY CE / SELL PE / BUY PE / SELL CE / stock / future, ranges, underlying basis matrix, unspecified basis, missing reference, unsupported instrument and side, evidence fields, closed reason-code set, eligibility helper), `tests/unit/decision-intelligence/stopLoss.test.ts` (decide for each failure, plus a PROPERTY test over a grid of 28 stop-loss values x 2 sides x 4 instrument types asserting APPROVE only when the shared rule says VALID, and persist refusing without touching the database), `tests/unit/signals/options/stopLoss.test.ts`, `tests/unit/approvalBot/stopLoss.test.ts` (11: no Approve button, forged callback refused), `tests/unit/safety/stopLossCoverage.test.ts` (architectural: only allow-listed files may mention an approval-class state, decide()'s final guard, persist order, trigger covers every execution-eligible enum value, nothing writes decisions / risk_decisions / orders / fills / positions), `tests/integration/stopLoss/stopLoss.test.ts` (24: the database trigger incl. latest-evidence-decides and replica mode, the evidence table's CHECKs, real validateSignal flows for 8 failure cases with every evidence field, idempotent retry, a stored APPROVE with VALID evidence, API `approvalEligible`, chain verification, legacy rows via the view, options-claim evidence). `tests/integration/auditChain/auditChain.test.ts` now covers the sixth chain (70). Mutation check (by hand, not committed): removing each of 11 enforcement points (decide final guard, structural blocking, ambiguous branch, persist guard, direction check, maximum-distance check, underlying-basis rule, zero check, bot approve refusal, bot button removal, options assessment) made the stop-loss unit suites fail every time; no mutant survived.

Existing tests changed (none weakened, skipped or deleted): `structuralValidation.test.ts` "flags (non-blocking) a bare signal" now expects it to BLOCK with `structural.stop_loss.missing_stop_loss` (this is the behaviour change the task requires); `targetConfig.test.ts` migration count 11 -> 12; `auditInfra.test.ts` and `verifier.test.ts` expect the sixth protected table and the invariant trigger; `approvalBot/static.test.ts` allows the pure `@twins/stop-loss` import; `auditChain.test.ts` includes `stop_loss_validations` in its table list and the valid-flow fixture; earlier tasks' test files had their `x!` assertions replaced by `must(x)`.


## Stage 2 / Task 1 - commit checkpoint and hosted CI (2026-10-29)
- Stage 1 is committed on `feat/stage1-safety-core`; the earlier "uncommitted" wording in the sections above describes the state when each task was verified.
- New guard tests: `tests/unit/ci/secretScan.test.ts` (5) and `tests/unit/ci/workflow.test.ts` (8) pin the workflow's triggers, permissions, gate, Node pinning, step order, service containers and the absence of secrets.
- Local verification (Node 22, disposable Postgres 16 / Redis 7): npm ci, lint (0 errors, 116 warnings), `tsc -b`, 88 unit files / 1289 tests, db:migrate (12 migrations), verify-migrations, integration 38 files passed + 2 skipped / 309 tests passed + 4 skipped, `audit:verify --require-ddl-watch` ok, crash test ok.
- Hosted run https://github.com/theja-36/twins/actions/runs/40855674182 (branch `feat/stage1-safety-core`, after merging `origin/main`): static, unit (Node 20, 22), integration (Node 20, 22), crash-recovery and `ci-gate` all **success**. The crash-recovery job was re-run twice more on hosted runners and passed both times, so it stays in the gate.
