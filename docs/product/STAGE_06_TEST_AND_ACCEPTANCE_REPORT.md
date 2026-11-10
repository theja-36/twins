# Stage 06 test and acceptance report (2026-11-10)

State: **ENGINEERING IMPLEMENTED — CI PENDING.** Internal engineering acceptance is separate from external data validation (below).

## Local results (this machine)
- Full unit suite, final run after all changes: 256 of 256 files, 4135 of 4135 tests passed (about 81 s). An earlier run had one failure, the tracker Markdown/JSON consistency test, caused by my hand-editing the generated Markdown; fixed by editing `tracker.json` and rendering.
- Previous Vitest worker fetch timeout: that run took 1660 s (transform 1610 s) while other heavy jobs were running. A clean run now takes 81 s with no timeout. Cause: machine contention that exceeded the worker RPC timeout, not a test or code defect. No config change was made; the timeout was not reproduced and is not proven fixed, so CI is the check.
- `tsc -b` clean. eslint: 0 errors (existing warnings only).

## Acceptance criteria and evidence
| Criterion | Evidence |
|---|---|
| Exact money, rounding | sizing.test.ts (fixed-point, direction rounding, property sweep); analysis.test.ts (round-down) |
| Sizing, lots | sizing.test.ts (bounds, freeze, spec/policy lots, tick) |
| Multi-account / multi-user | stage06.integration (invisible to another user); G-46 isolation test (two accounts of one user, two users, cross-write rejected) — **CI-only** |
| Available vs committed capital | capitalSemantics.test.ts (5 tests) |
| Existing positions / aggregate exposure | risk.test.ts "total exposure", simulator.test.ts portfolio impact; paperPortfolioProvider in stage07 integration |
| Risk boundaries | risk.test.ts (limits at, below, above; reasons; corrective actions) |
| Confidence reproducibility, missing/stale/contradictory evidence | confidence.test.ts |
| What-if reproducibility, invalid contracts | simulator.test.ts (determinism, unsizable scenarios, duplicate ids) |
| Concurrency / idempotency | G-46 integration tests: 8 concurrent persists store one assessment and one linked simulation; 5 concurrent full evaluations yield 1 EVALUATED and 4 RECENT; rollback leaves no assessment without simulation — **CI-only, not yet run** |
| DB isolation / append-only | stage06.integration (append-only triggers, RLS, owner FKs) |
| No approval / execution | risk.test.ts hygiene test; analysis source-scan test |
| Regression | full unit suite above |

## Not yet proven
The PostgreSQL integration tests (including all new G-46 tests) have not run: there is no local Postgres, and CI has not been run on these changes. Stage 06 cannot be ENGINEERING COMPLETE until they pass on Node 20 and 22 with PostgreSQL 16 and Redis 7.

## External validation (deferred, not waived)
G-16, G-20, G-22 LIVE, G-23, G-24, G-25 and Stage 08 outcome data; M09-12 and M09-18 remain IN_PROGRESS for that reason.
