# Stage 04 test and acceptance report (2026-11-10)

**Status: ENGINEERING IMPLEMENTED: CI PENDING.** Every internal engineering item is built, including G-43 and G-44. ENGINEERING COMPLETE is declared only after the CI verification below passes on Node 20 and 22 with PostgreSQL 16 and Redis 7 and every criterion is satisfied. External-data production validation is deferred to Stage 10/11 and is not part of this status.

## Local results (this pass; not CI)
| Check | Result |
|---|---|
| TypeScript `tsc -b` | clean |
| ESLint (packages, apps, tests, scripts) | 0 errors (pre-existing style warnings only) |
| Full backend unit suite (one local run, this machine's Node) | **252 files passed (252), 4,087 tests passed (4,087)**, no failures, no skips reported, no worker timeout |
| Previous CI unit baseline (run 42894318636, Node 20 and 22) | 245 files, 4,011 tests; this pass and the previous one added the files and tests listed below |
| PostgreSQL 16 / Redis 7 integration, migration chain 0000 to 0044, crash recovery, Node 20 and 22 | **NOT RUN for this batch**: no Docker daemon locally and no push is authorised. The new tests below are written and only run in CI. Last CI evidence: run 42894318636, 81 files / 1,089 tests passed, 2 files / 4 tests skipped |
Two integration files were parse-checked only (esbuild) because the integration suite cannot run locally; they were reviewed against the store, queue and schema code line by line. Expect that CI may expose mistakes in them; any failure will be diagnosed and reported, never worked around.

## New and changed tests (this task)
| File | Tests | Where it runs |
|---|---|---|
| `tests/unit/agents/researchRunRecords.test.ts` | 12 | unit (local, passes) |
| `tests/unit/database/researchRunMigration.test.ts` | 5 | unit (local, passes) |
| `tests/integration/opportunity/researchRuns.test.ts` | 12: schema (append-only, checks, uniqueness, atomicity), idempotent store, idempotent research, 6 concurrent attempts, changed candidate, crash after save (retry), vanished worker (lease recovery), reconstruction, run key persisted | CI only (PostgreSQL) |
| `tests/integration/runtime/researchCrashRecovery.test.ts` + child `crash/researchChild.ts` | 2 real-SIGKILL scenarios: killed inside the package transaction (nothing stored, recovery researches once) and killed after commit before the queue item completed (package and 13 runs survive, retry stores nothing new) | CI crash-recovery job (gated by `TWINS_CRASH_TEST=1`; skipped in the normal integration job, adding 1 skipped file and 2 skipped tests there) |
| `tests/unit/database/stage04Stores.test.ts` (changed) | the research package store may now insert exactly `researchPackages` then `researchAgentRuns`; updates, deletes and truncates are still forbidden | unit |
| `tests/unit/rehearsal/targetConfig.test.ts`, `tests/unit/ingestion/intakeOutbox.test.ts`, `tests/integration/backup/offhostBackup.test.ts` (changed) | migration count 44 to 45 (expected consequence of migration 0044) | unit and CI |
| `.github/workflows/ci.yml` (changed) | the crash-recovery job also runs `researchCrashRecovery.test.ts` (a check was added, none removed) | CI |
Earlier in this pass: `softDependency` (8), `optionsRiskMapping` (28), `researchStatus` (5), `researchApi` (10), `researchTemporal` (8), `openapiSession` (3).

## Exact CI verification required (after you authorise the push)
Backend, on Node 20 and Node 22: static (lint, typecheck, build, secret scan); unit; integration on PostgreSQL 16 and Redis 7 including the migration chain applying 0044 and these files passing: `tests/integration/opportunity/researchRuns.test.ts` (12), `tests/integration/opportunity/engine.test.ts` (existing; one package per candidate), `tests/integration/outcomes/stage08.test.ts` (G-41 tests), `tests/integration/database/stage04Stores.test.ts` (store behaviour unchanged), `tests/integration/backup/offhostBackup.test.ts` (45 migrations); crash recovery job: `crashRecovery.test.ts` and `researchCrashRecovery.test.ts`; ci-gate. Expected skip delta in the integration job: +1 file, +2 tests (the gated crash file). Frontend is unchanged.

## Acceptance criteria
| # | Criterion | Verdict |
|---|---|---|
| 1 | 12 specialist responsibilities accounted for and contractually defined | MET (`SPEC_ROLE_MAP`, `GET /research/agents`) |
| 2 | The 13th Market Context agent preserved | MET (registered, runs before the challenger as a soft dependency) |
| 3 | Orchestration implemented and tested | MET locally; CI pending for the new soft-dependency work |
| 4 | Market regime engine implemented and tested | MET on fixtures (live operation is G-16/G-20, Stage 10) |
| 5 | Research package versioned and auditable | IMPLEMENTED: `asOf`, run key, per-agent run records (G-43, G-44); PostgreSQL proof pending CI |
| 6 | Temporal correctness and no-look-ahead safeguards tested | MET at unit level (`researchTemporal.test.ts`, per-agent stale/future tests); the regime `as_of <= decision time` SQL read still has no integration test |
| 7 | Cross-user ownership verified | MET for what exists: research data is shared platform data by design; the API needs a session and `research:read`; `ai_usage_records` RLS has integration tests |
| 8 | APIs and database changes complete | IMPLEMENTED: read API, migration 0044; CI pending |
| 9 | Unit, integration and regression tests pass | PARTIAL: unit passes locally; integration and Node 20/22 pending CI |
| 10 | Documentation and handoff complete | MET |
| 11 | No known critical engineering blocker hidden | MET: G-45 (Stage 09), G-15, G-16, G-20, G-23, G-25 (Stage 10/11) are listed |

## Not claimed
No agent ran against real market, news or option data; every verdict is rule-level on synthetic input; no agent uses a model and nothing calls the AI gateway in production. Re-executing an agent against live providers from a stored run is not possible (provider data is not stored). A re-research with identical candidate inputs but changed provider data is treated as the same run; that is the intended effect for crash recovery.

## To declare ENGINEERING COMPLETE
You authorise the push; CI passes as listed; every criterion above is then satisfied; the roadmap and tracker are updated with the run id.
