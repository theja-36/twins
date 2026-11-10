# TWINS development handoff

Source of truth for requirement status: `docs/product/tracker.json` (render with `node scripts/product/tracker.mjs render`). This file is the session-continuity note.

## Position (2026-11-09)
- Branch `feat/master-build` (pushed to origin; `main` untouched at 507c6f5). Last CI-confirmed green: 824593d (run 42447708067). 6a9a7ba failed integration (fixed in ce118b4); later commits' CI must be checked with `gh run list --branch feat/master-build`.
- Stages: 00 complete; 01 partial (auth sessions, login route, API middleware, per-route contracts outstanding; G-13 role escalation must close before multi-user access); 02 verified by CI for evidenced items; 03 implemented, real-data accuracy IN_PROGRESS (M02-15); 04 implemented in code, CI pending for its new tests and migration 0035; 05-12 not started.

## Stage 08 components (2026-11-08)
Completed in code: `packages/outcomes`, migration 0039 (40 migrations, 0000-0039), outcomeStore, `runLearningCycle` (worker timer, `TWINS_LEARNING_ENABLED`, off by default). Rules: outcomes are append-only versions (PARTIAL never final; a correction needs a reason); every figure is split by provenance and graded (fixture data is NOT_VALIDATED_FIXTURE); minimum sample 30 is a floor, the Stage 06 calibration (200 out-of-sample, rising win rate) is unchanged; insights are advisory (REVIEW only) and reproducible; the learning package must never import decision / execution / risk code (static test). Next: Stage 09 (complete frontend) builds on `ANALYTICS_ENDPOINTS` / `sectionOf` in `packages/outcomes/src/contracts.ts`, but a user-facing route needs Stage 01 sessions and `analytics:read` first (G-26).

## Stage 07 components (2026-11-08)
Completed in code: `packages/decision`, `packages/execution`, migration 0038 (39 migrations, 0000-0038), stores, worker cycles (all off by default: `TWINS_DECISIONS_ENABLED`, `TWINS_EXECUTION_ENABLED`, `TWINS_TRADE_MANAGEMENT_ENABLED`), `npm run decision:control`. Rules: a QUALIFIED decision exists only if the engine ran the full stop-loss validation (G-18 closed; `qualifiedProducerStage07.test.ts`); user_decisions are written only through the four SECURITY DEFINER doors; an approved decision is withdrawn by a `decision_invalidations` row, not a state change; exits are never blocked by the kill switch, entries always are; the position is derived from fills; live modes are refused by construction. Next: Stage 08 (outcome learning, Module 15) uses `trade_outcomes` (PAPER) and the decision / confidence records; calibration (G-24) needs real outcomes; Stage 01 auth and G-13 must close before any user-facing approval route (G-26).

## Stage 06 components (2026-11-08)
Completed in code: `packages/planning` + `packages/confidence`, migration 0037, planningStore, `runEvaluationCycle` (worker, `TWINS_EVALUATION_ENABLED`, off by default; needs `TWINS_SPECS_FILE` or every instrument BLOCKS). Migration count is 38 (0000-0037). Rules: risk never accepts confidence; sizing multiplier in (0,1]; money uses `decimal.ts`; clearing drawdown halts/kill switches is owner-only (DB check). Limits: G-22..G-25 (and G-15/16/18-21). Next: Stage 07 (decision, approval, execution, trade management) must integrate the mandatory stop-loss validation (G-18), a portfolio-state source (G-22) and qualification using `risk_assessments.verdict`.

## Stage 05 components (2026-11-08)
Completed in code: `packages/opportunity` (scan, setups, rank, lifecycle, dispatch, cycle), migration 0036, opportunityStore, worker `opportunity_queue`, scheduler cron enqueue, scheduler effect `research_intake`. All OFF unless `TWINS_OPPORTUNITY_ENABLED=true`; universe via `TWINS_OPPORTUNITY_UNIVERSE`; data from the agent rules' file OHLC / last-price sources only. Limits: G-19..G-21 (and G-15/16/18). Migration count is now 37 (0000-0036); bump the 3 assertion files for each new migration.

## Stage 04 components
Completed: market regime detection; Market Context Agent (13th, advisory, not required by default); spec role mapping and report adapter; research package; candidate research runner (injected sink); AI gateway (fixtures only); migration 0035; stores (regimes, research packages, AI usage).
Unstarted/limits: see GAP_REGISTER G-15..G-18.

## Commands
- `npx tsc -b` (canonical typecheck); `npx vitest run tests/unit`; integration tests need Postgres 16 + Redis (CI only; no local database, G-11).
- Migrations: `cd packages/database && DATABASE_URL=postgresql://unused.invalid:5432/none npx drizzle-kit generate --name <n>`, then `python3 scripts/product/append-0035.py`-style hand append. Migration count assertions (6 places) must be bumped with each migration (now 36).

## Rules that bite
- Agents package may write only the six agent tables; persistence lives in `packages/database/src/stores`.
- Do not write the literal live-trading flag name outside guard modules; QUALIFIED/APPROVE vocabulary files need an allow-list entry with a reason (ADR-010).
- Integration tests that enumerate agents must disable `market-context-v1` or supply a regime provider.
- Env flags are strict; classification-at-intake (`TWINS_CLASSIFY_ON_INTAKE`) is default off.

## Next steps (after Stage 05 CI is green: record the run id on M16-01..M16-18)
0. Stage 06 (capital, confidence, risk, simulator: Modules 08-11) is next in the roadmap; do not skip ahead. Stage 01 auth and G-13 remain visible and must close before multi-user access.

## Older next steps (Stage 04, kept for context)
1. Push, confirm CI green for the Stage 04 commit (integration: `stage04Stores`, `historicalChallengerAgents`, migration chain 36).
2. Record CI run id on M04-17..M04-20; then Stage 05 (Independent Opportunity Engine, Module 16): scanner producing `opportunity_candidates` with `source = INDEPENDENT`, calling `runCandidateResearch`.
3. Stage 01 remainder (auth) before any multi-user exposure.

## Stage 03 closure handoff (2026-11-08)
Backend `feat/master-build` at `67dee94` (CI run 42528709453 green). Frontend `feat/stage09-frontend` at `9abf640`. New read APIs: `/intelligence/claims/:id/historical-matches`, `/intelligence/channels/:id/performance`, `/intelligence/playbooks[/:id]`, `/intelligence/archive/channels` (session-protected, shared permissions, read-only). Migration 0043 guards playbook versions. Frontend e2e: `npm run test:e2e` (Playwright + axe, demo and non-demo builds). Stage 03 remains NOT COMPLETE: see the open blockers in `STAGE_03_COMPLETION_REPORT.md`.


## Stage 03 final acceptance audit (2026-11-09), local and unpushed
Backend adds `apps/api/src/openapiSession.ts` and `docs/api/openapi-session.json` (regenerate with `npx tsx scripts/ops/export-openapi.ts`), the opt-in `pointInTimeOutcomes` scorecard option (G-39) and `STAGE_03_VALIDATION_PROTOCOLS.md`, `STAGE_ROADMAP_STATUS.md`. Frontend `7144db8` adds the partial-answer state. Gaps G-39 to G-42 are in the register. Stage 03 status: NOT COMPLETE: EXTERNAL DATA/PROVIDER DEPENDENCY. The integration suite was not run locally (no Docker daemon); the G-39 default must be flipped only after CI shows the one affected integration assertion.

## Stage 03 closure program handoff (2026-11-09)
Local, unpushed backend work: G-40 (`patterns/training.ts`, `pattern-metrics-v2`), G-41 (decision cycle reads the evaluation bundle's package; `researchReportsForDecisions` reads decision-time packages; `getResearchPackageById`), legacy scorecard flags (`pointInTime`), `canonicalContract.ts`, `classifierEval.ts`, `priceQuality.ts` and their tests, plus the specs listed in `STAGE_03_COMPLETION_REPORT.md`. The integration tests for G-40/G-41 run only in CI. One approval request: `STAGE_03_DECISION_PACKAGE.md`. Next milestone after approvals: the pilot labelled dataset (item A) and the instrument-master source (item B).

## Stage 03 boundary and Stage 04 handoff (2026-11-10), local and unpushed
Stage 03 Engineering and External Validation are separate (`STAGE_03_ENGINEERING_BOUNDARY_AND_ACCEPTANCE.md`). Stage 04 changes: challenger soft dependency on the optional market-context agent, options-risk mapping (A13), derived research status, research read API and session OpenAPI entries, package `asOf`; no migration. Reports: `STAGE_04_IMPLEMENTATION_REPORT.md`, `STAGE_04_TEST_AND_ACCEPTANCE_REPORT.md`. Next engineering items before declaring Stage 04 complete: CI run of this batch, G-43 (candidate research idempotency), G-44 (candidate-path run persistence). Stage 05 onward is not started by this work.

## Stage 04 G-43/G-44 handoff (2026-11-10), local and uncommitted
Migration 0044 (`research_packages.run_key`, append-only `research_agent_runs`), `research/runRecords.ts`, extended `storeResearchPackage`, new unit tests (252 files / 4,087 tests pass locally), PostgreSQL integration `tests/integration/opportunity/researchRuns.test.ts` and real-SIGKILL `tests/integration/runtime/researchCrashRecovery.test.ts` (CI only; the crash-recovery job now runs both crash files). Next: owner authorises commit and push; CI on Node 20/22 with PostgreSQL 16 and Redis 7; if green and all criteria hold, declare Stage 04 ENGINEERING COMPLETE.
