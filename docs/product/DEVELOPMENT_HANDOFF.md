# TWINS development handoff

Source of truth for requirement status: `docs/product/tracker.json` (render with `node scripts/product/tracker.mjs render`). This file is the session-continuity note.

## Position (2026-11-09)
- Branch `feat/master-build` (pushed to origin; `main` untouched at 507c6f5). Last CI-confirmed green: 824593d (run 42447708067). 6a9a7ba failed integration (fixed in ce118b4); later commits' CI must be checked with `gh run list --branch feat/master-build`.
- Stages: 00 complete; 01 partial (auth sessions, login route, API middleware, per-route contracts outstanding; G-13 role escalation must close before multi-user access); 02 verified by CI for evidenced items; 03 implemented, real-data accuracy IN_PROGRESS (M02-15); 04 implemented in code, CI pending for its new tests and migration 0035; 05-12 not started.

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
