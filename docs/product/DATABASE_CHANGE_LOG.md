# Database change log

Additive migrations only (ADR-008). Each entry: migration, tables, reason, reuse check, verification.

| Migration | Date | Change | Reuse check | Status |
|---|---|---|---|---|
| 0033_master_build_platform | 2026-11-08 | +24 tables, +`users.role`. Platform/auth: `user_sessions`, `user_capital_profiles`, `user_risk_policies`, `user_execution_permissions`. Shared intelligence: `signal_classifications`, `market_regimes`, `strategy_playbooks`, `playbook_versions`, `strategy_drift_events`, `opportunity_scans`, `opportunity_candidates`, `research_packages`. Decisions and risk: `confidence_assessments`, `risk_assessments`, `simulations`, `user_decisions`, `user_decision_events`, `trade_monitoring_events`, `trade_outcomes`. Learning: `learning_versions`, `learning_version_events`, `performance_snapshots`, `confidence_calibration_runs`, `counterfactual_reviews`. RLS (enabled + forced) on 9 private tables; append-only triggers on 16 evidence tables; DB-level lock on live execution modes (ADR-012) | Reused: `users`, `accounts` (user + mode), `risk_decisions` (via `user_decisions.risk_decision_id`), `orders/fills/positions` (account-owned, unchanged), `paper_trades`, `options_claims`, `telegram_sources`. New tables only where no existing table fit; `decisions` (legacy) untouched | WRITTEN, NOT APPLIED. Generated with drizzle-kit (offline) then hand-appended triggers and RLS. Static rules tested (tests/unit/database/masterBuildMigration.test.ts). Application and integration testing need Postgres (CI); journal-count expectations raised from 33 to 34 |

## Not yet done (planned)
- Row-level policies for `orders`, `fills`, `positions` (account join) - Stage 07.
- `app-role.sql` needs no change: the existing loop grants SELECT+INSERT on append-only tables (trigger name ends `_no_update_delete`) and SELECT,INSERT,UPDATE on the mutable ones; to be confirmed when the migration is applied.
- Deploy note: the Monday runbook expects 33 migrations; this branch makes the chain 34 and is not part of that deploy.
