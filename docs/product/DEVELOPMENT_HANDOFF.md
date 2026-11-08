# TWINS development handoff

Source of truth for requirement status: `docs/product/tracker.json` (render with `node scripts/product/tracker.mjs render`). This file is the session-continuity note.

## Position (2026-11-09)
- Branch `feat/master-build` (pushed to origin; `main` untouched at 507c6f5). Last CI-confirmed green: 824593d (run 42447708067). 6a9a7ba failed integration (fixed in ce118b4); later commits' CI must be checked with `gh run list --branch feat/master-build`.
- Stages: 00 complete; 01 partial (auth sessions, login route, API middleware, per-route contracts outstanding; G-13 role escalation must close before multi-user access); 02 verified by CI for evidenced items; 03 implemented, real-data accuracy IN_PROGRESS (M02-15); 04 implemented in code, CI pending for its new tests and migration 0035; 05-12 not started.

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

## Next steps
1. Push, confirm CI green for the Stage 04 commit (integration: `stage04Stores`, `historicalChallengerAgents`, migration chain 36).
2. Record CI run id on M04-17..M04-20; then Stage 05 (Independent Opportunity Engine, Module 16): scanner producing `opportunity_candidates` with `source = INDEPENDENT`, calling `runCandidateResearch`.
3. Stage 01 remainder (auth) before any multi-user exposure.
