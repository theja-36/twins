# Stage 07 test and acceptance report (2026-11-11)

State: **ENGINEERING IMPLEMENTED — CI PENDING.**

## Local results (revision 3: real PostgreSQL 16 + Redis 7, 2026-11-11)
State remains **ENGINEERING IMPLEMENTED — CI PENDING**: hosted CI on Node 20 and Node 22 has not run, and Node 20/22 are not installed locally.

**Environment.** Docker Desktop (server 29.6.1) with the official `postgres:16-alpine` (PostgreSQL 16.15) and `redis:7-alpine` images, bound to 127.0.0.1 with the CI credentials (`twins_ci`, database `twins_ci`, Redis 6379 for the integration suite and 16379 for the crash tests, one container). Local Node: v26.13.0 (all runs), v24.14.1 (unit suite). No Node 20 or 22 exists on this machine and no Node image was downloaded, so the Node 20/22 matrix is NOT verified.

**Commands and results** (environment `TWINS_CI=1 LIVE_TRADING=false NODE_ENV=test DATABASE_URL=postgresql://twins_ci:…@127.0.0.1:5432/twins_ci REDIS_URL=redis://127.0.0.1:6379`):
| Step | Command | Result |
|---|---|---|
| CI target guard | `npx vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts` | 4 passed |
| Migration, clean database | `npm run db:migrate -w @twins/database` | applied; `drizzle.__drizzle_migrations` = **46** rows |
| Migration verification | `node scripts/ci/verify-migrations.mjs` | exit 0 (all structure checks, including 0038 and 0045) |
| Migration 0045 in the database | catalog query | `decision_watches` present, row-level security FORCED, policy `decision_watches_owner_only`, triggers `decision_watches_no_update_delete` and `decision_watches_no_truncate` |
| Full integration suite | `npx vitest run --config vitest.integration.config.ts --reporter=default --reporter=junit` | **83 files passed, 1 failed, 4 skipped; 1,122 tests passed, 1 failed, 9 skipped; 217 s** |
| Stage 07 files in that run | (same) | stage07.test.ts 24/24, stage07Concurrency.test.ts 2/2, stage06 14/14, stage02 25/25, userRoutes 12/12, stage08 12/12 |
| Crash-recovery job | `TWINS_CRASH_TEST=1 REDIS_URL=redis://127.0.0.1:16379 npx vitest run --config vitest.integration.config.ts tests/integration/runtime/{crashRecovery,researchCrashRecovery,executionCrashRecovery}.test.ts` | **6/6 passed** (worker 1, research 2, **execution 3, real SIGKILL**); the execution file also passed 3 further consecutive runs on its own |
| Audit-chain verification (CI step after the integration run) | `npm run audit:verify -- --require-ddl-watch --status-file reports/audit-verify-status.json` | exit 0, no chain failure |
| Unit suite | `npx vitest run` | **261 files, 4,178 tests passed** on Node 26.13.0 and again on Node 24.14.1 |
| Typecheck | `npx tsc -b` | clean |
| Lint | `npx eslint .` | 0 errors (773 warnings, all the existing non-null-assertion kind) |
| Tracker | `node scripts/product/tracker.mjs check` | ok |
| Migration journal / snapshot | journal 46 contiguous entries, `drizzle-kit check` clean, `drizzle-kit generate` "No schema changes" | consistent |

**The one failing integration test** is `tests/integration/backup/offhostBackup.test.ts` ("dump: unexpected_error", `spawn pg_dump ENOENT`): it shells out to `pg_dump`/`pg_restore`, which are not installed on this Mac (the CI job installs `postgresql-client`). It is unrelated to Stage 07. A shim that ran the tools inside the container did not get through the dump step, so this test is **unverified locally** and must be confirmed in hosted CI.

**History of the runs (nothing hidden).**
1. First full run (before the fixes below): 28 failures in 6 files. Causes: my new risk-restriction test created the restriction with `scopeKey: null`, a global restriction that turned every later decision in the shared database into NO_TRADE (20 failures across other files; **a defect in my test**, now scoped to the user as production does); a real race in `createPaperOrder`; and the environment (`pg_dump`, plus 3 `ECONNREFUSED` in the backup test).
2. Second full run: invalid. The machine went to sleep during it (reported duration 19,389 s; tests with a 20 s timeout showed ~1,000 s of wall time), producing 18 timeouts. Disregarded and re-run under `caffeinate` on fresh containers.
3. Third full run on fresh containers: the clean result in the table above.

**Defects the real database found, all fixed** (none could be seen without a database):
- `createPaperOrder` was check-then-insert without a lock: concurrent execution requests for one decision made the loser fail the quantity guard instead of returning the winner's order. Now serialised per order key with `pg_advisory_xact_lock`.
- The update-event race (below).
- Three defects in my own new tests (the global `scopeKey: null`; the crash child's order time-to-live elapsing because the fixture clock is 2031; a `RECONCILED` event my own `reconcilePosition` call added between two snapshots). No existing test or assertion was changed or weakened; only these new tests were corrected.

## Update-event race (concurrent repair of the same later fill): FIXED
Before: `syncPosition` updated the position and then appended the event as separate statements, so N workers repairing the same fill each saw "position differs" and each appended an event. Reproduced on the real database with the old code restored: eight concurrent workers recorded **8 PARTIAL_EXIT events** for one exit fill (`expected 8 to be 1`).
Fix: `applyPositionEntrySync` / `applyPositionExitSync` (executionStore.ts) run the UPDATE and the event insert in ONE transaction, and the UPDATE is conditional on the target state (`quantity`, average or realised figures differ; `status = 'OPEN'`). The UPDATE takes the row lock; a racing second worker waits, re-reads the committed row, matches nothing and records nothing. The trade outcome is written only by the worker whose UPDATE closed the position. Idempotent by construction: the target state is the idempotency key. No migration.
Test: `tests/integration/trading/stage07Concurrency.test.ts`. Case 1: a partial entry; a later entry fill commits without a position update; **8 concurrent `syncPosition` calls**; then a partial exit fill (8 concurrent) and the closing exit fill (8 concurrent). Asserts correct quantity and weighted average entry, correct realised P&L, exactly one `ENTRY_FILL`, one `PARTIAL_EXIT`, one `CLOSED`, one `OPENED`, one trade outcome, status CLOSED, and the fills unchanged and never duplicated. Case 2: 8 concurrent execution requests (same and different keys) give one order, fills summing to the permitted quantity, one position and one OPENED event. Passed on 3 consecutive runs and in the full suite. Unit mirror: fillRecovery.test.ts (10 tests, includes 4 concurrent repairs of a later fill).

## Correction to revision 1 (important)
Revision 1 listed "crash between fill and position heals by derivation" as covered by an integration case. That case simulated the crash and then called `syncPosition` by hand. Reviewing it against a real process crash showed that **nothing in production would have called it**: after a crash between a committed fill and the position write, the order is FILLED and the execution request is still ELIGIBLE; `fillOrder` returned early for a FILLED order without syncing the position, a retried request re-ran every check and then hit the same early return, and `advanceOpenOrders` only looks at ACCEPTED / PARTIALLY_FILLED orders. The position would never have been created. This was a genuine defect and is fixed (see the implementation report), and the simulated case is kept but no longer the evidence.

## Real SIGKILL crash recovery for paper execution (G-47) — tests/integration/runtime/executionCrashRecovery.test.ts
Run by the existing `crash-recovery` CI job (added to its command; same guarded `twins_ci` database, same convention: only the test-spawned child pid is ever killed, verified against the pid the child reports over IPC). The child runs the REAL worker cycle `advanceOpenOrders`; the only seam is a pass-through wrapper around `db.transaction` (tests/support/crashHold.ts, unit-tested locally) that lets the fill transaction COMMIT and then holds the process.
1. **Crash and restart**: the parent arranges an approved decision with an ACCEPTED, unfilled entry order. Child 1 reads a price, the fill commits, and the child stops. The parent verifies in PostgreSQL that the fill row exists, the order is FILLED, **no position exists** and the request is still ELIGIBLE; then SIGKILLs the child and verifies the database is unchanged. Child 2 (a new process, the restarted worker) runs a cycle: it reports `healed: 1`. The parent then verifies: the fill rows are identical (same id, quantity, price, costs); exactly one position with quantity equal to the filled quantity and average entry equal to the fill price; one OPENED event; one ENTRY_FILLED monitoring event; the request COMPLETED; `reconcilePosition` agrees. A third worker cycle reports `healed: 0`, and a retried execution request with the same key returns the existing result; the full database snapshot is identical after both.
2. **Retried request after the crash**: the retried execution request (instead of a worker cycle) repairs the follow-up, creating no order and no fill and not re-validating (so it cannot invalidate) the filled entry; a following worker cycle finds nothing left.
3. **Two workers restart at once**: one position, one OPENED event, one ENTRY_FILLED event, the same single fill.
Status: **PASSED locally against PostgreSQL 16.15 + Redis 7 with a real SIGKILL**: 3/3 cases on four separate runs, and 6/6 in the full crash job. The check that the test detects the defect: with the recovery sweep disabled, case 1 fails (`healed` expected 1, got 0). Hosted CI on Node 20/22 is still pending.

Local, in-memory evidence of the same logic (tests/unit/trading/fillRecovery.test.ts, 9 tests): the real `healEntryFill`, `fillOrder`, `requestPaperExecution` and `advanceOpenOrders` run against an in-memory store that mimics the relevant SQL semantics. It verifies single position creation, single opening event, completion of the request, idempotency, a simultaneous double repair, repair of a position that is behind its fills, that no order or fill is ever created on the recovery path, and that a missing specification leaves the decision for the next cycle. The tests were mutation-checked: removing each fix makes the intended tests fail. This does not prove the SQL, which is why the CI test exists.

## Acceptance criteria and evidence
| Criterion | Evidence |
|---|---|
| All decision outcomes | tests/unit/trading/decision.test.ts (QUALIFIED, WAIT, REJECT, EVALUATION_ONLY, NO_TRADE, precedence, confidence never raises an outcome) |
| Versioning, supersession, stale evidence, revalidation | integration stage07 "a changed evidence base supersedes the pending decision; an expired decision is expired" (CI) |
| Approval ownership and expiry | integration stage07 "human approval" (CI) |
| Concurrent approvals | hardening: 5 approves + 3 rejects, exactly one recorded, rest ALREADY_ACTIONED (CI, new) |
| Duplicate execution / idempotency | stage07 sequential duplicates + hardening: 6 concurrent requests, one order, fills sum to quantity, one position (CI, new) |
| Concurrent fills | hardening: 4 concurrent fill attempts; optimistic-check test (3 concurrent, 1 applied; stale attempt applies nothing) (CI, new) |
| Risk failure immediately before execution | hardening: user restriction after approval refuses and creates nothing (CI, new) |
| Permission revocation / kill switch | hardening: permission revoked after approval (CI, new); kill switch in the gate (liveArchitecture.test.ts, execute safety chain) |
| Partial and multiple fills | stage07 "partial fills" (CI) |
| Rejection / cancellation | hardening: cancelled order never fills or opens a position, cannot be revived (CI, new); DB lifecycle test (CI) |
| Position updates and exits | tests/unit/trading/position.test.ts; stage07 manage/close (CI) |
| Worker crash / retry | **real SIGKILL** between a committed fill and the position update, restart, single repair (executionCrashRecovery.test.ts, 3/3 passed locally on PostgreSQL 16 + Redis 7; hosted CI pending); in-memory recovery logic (fillRecovery.test.ts, local); the earlier simulated case is kept as a supplementary check; existing SIGKILL tests cover intake and research |
| Account and user isolation | stage07 "paper data is private to its owner"; watch isolation (CI, new) |
| Paper/live separation | boundaries.test.ts; stage07 "live modes are refused and recorded"; liveArchitecture.test.ts (operator switch off refuses everything) |
| Live architecture rules | liveArchitecture.test.ts (boundary-exact limits, confirmation binding, revocation, emergency stop, broker classification) |
| Audit trail | append-only approvals, decision events, execution requests, watches (CI) |
| Regression | full unit suite |

## Decision watch authorization (M13-09)
`decisions:read` was NOT intentionally a write permission: the model separates read and write everywhere else (`capital:*`, `risk-policy:*`, `broker:*`, `orders:*`) and keeps decision mutations behind `decisions:approve`. A bookmark is a write (an append to `decision_watches`), so it now has its own narrowest permission, **`decisions:watch`**: private (owner-scoped, a non-owner gets NOT_FOUND), held by TRADER only, not by ADMIN or a system principal, and not implying `decisions:approve`. Verified: the store function's only write is one insert into `decision_watches` (it reads `user_decisions` to check ownership and touches no approval, decision-state or execution table); the user id comes only from the session (a body `userId` / `user_id` / `ownerId` / `accountId` is rejected 422); the table is append-only with forced owner row-level security and a composite foreign key. Tests: contracts.test.ts (permission model: private, distinct, owner-only, ADMIN/system refused), userApi.test.ts (route registered under `decisions:watch`, no `decisions:read` route writes, `decisions:approve` still guards exactly approve/reject and cancel; another user's watch/unwatch attempts return 404 and only the caller's id reaches the data layer; ADMIN 404; unauthenticated 401), plus the existing integration watch isolation case (CI). The watch routes are new in this stage and not deployed, so no existing client depends on the old permission.

## Not yet proven
- Hosted CI on **Node 20 and Node 22** (not available locally; the only local runs are Node 26.13 and, for unit tests, 24.14).
- `offhostBackup.test.ts` (needs `pg_dump`/`pg_restore`, not installed locally).
- The 12 live-mode rows (M13-18..29) remain IN_PROGRESS and DISABLED by design (G-48).
Stage 07 cannot be ENGINEERING COMPLETE until hosted CI passes on Node 20 and 22 with PostgreSQL 16 and Redis 7.

## External validation (separate, Stage 10/11)
Real broker adapter, live market data, real-money execution validation, legal/regulatory gates.
