# 01 Repository and runtime inventory

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Repository
- At observation (before this documentation was committed locally): branch `main`; HEAD `702d4a8`; tracked: only `docs/implementation/review/F1_REVIEW_PACKAGE.md` modified (documentation refresh); untracked: `.vscode/`, `TWINS_Planning_Pack/` (untracked local source, not available in the repository), `docs/twins/`.
- Recent history: `2983c6d` backup, `8a84c88` approval bot + migration 0008, `702d4a8` e2ePipeline isolation fix + T6 design.
- Workspaces (npm): apps/*, services/*, packages/*, adapters/*.

## Code inventory (TypeScript/Python source lines, excluding tests, `node_modules`, `dist`)
| Component | Files | Lines | Role / state |
|---|---|---|---|
| apps/api | 3 | 1178 | Fastify: `/health`, `POST /webhooks/telegram`, internal capture ingest; enqueue-and-return |
| apps/web | 3 | 423 | minimal read-only viewer |
| services/worker | 6 | 1049 | BullMQ consumer: ingestion, parsing, validation, market bars |
| services/scheduler | 1 | 158 | cron enqueuer for market bars (profile off) |
| services/telegram-capture | 16 | 2528 | Python TDLib read-only capture client (live + bounded history) |
| services/approval-bot | 10 | 1221 | Telegram Bot API approval service (built; activation is a separate owner action - D-018) |
| adapters/telegram | 5 | 548 | webhook + user-capture normalization |
| adapters/market | 2 | 351 | Yahoo daily bars |
| adapters/news | 3 | 373 | GDELT metadata |
| adapters/macro | 1 | 16 | stub |
| adapters/broker | 1 | 35 | contracts/registry stub (no vendor) |
| packages/database | 27 | 1850 | Drizzle schema + migrations 0000-0008 |
| packages/ingestion | 14 | 1370 | persistence, revisions, events, history primitive, quality |
| packages/signals | 24 | 2364 | extraction, options parse/assess, context, intelligence |
| packages/decision-intelligence | 10 | 709 | deterministic validation (APPROVE/REJECT/INSUFFICIENT_EVIDENCE) |
| packages/dataquality, entities, shared, types, config | 8/12/6/9/1 | 781/914/286/361/62 | supporting |
| packages/ai | 1 | 21 | stub, imported by nothing |
| packages/risk, market, analytics | 0 | 0 | `.gitkeep` placeholders only |
| tools/t1-feasibility | 2 | 1549 | one-off feasibility tooling |

## Data model
Tables (rehearsal catalog): accounts, analyses, approval_bot_events, approval_bot_state, audit_events, backtest_results, backtests, broker_connections, claim_review_cards, claim_reviews, decisions, entities, entity_aliases, entity_relationships, fills, instruments, jobs, macro_observations, market_observations, news_events, news_event_instruments, news_evidence, news_sources, options_claims, orders, portfolio_snapshots, positions, provider_health, quality_assessments, risk_decisions, signal_evidence, signal_validations, signals, telegram_message_events, telegram_messages, telegram_sources, users. Tables never read or written by runtime code: accounts, users, analyses, decisions, risk_decisions, orders, fills, positions, portfolio_snapshots, broker_connections, backtests, backtest_results.

Migrations: 0000-0003 (base), 0004 idempotency/revisions, 0005 signal_evidence unique links, 0006 options_claims, 0007 capture provenance + append-only events, 0008 approval bot tables + append-only triggers.

## Configuration, CI and deployment definitions
- CI: `.github/workflows/ci.yml` (typecheck, lint, unit, workspace builds, CI target guard, fresh migration chain, integration against PostgreSQL+Redis); Dependabot config present; no audit/secret-scan step.
- Staging: `infrastructure/staging/docker-compose.staging.yml` (project `twins-staging`; services postgres, redis, api, worker, migrate/scheduler/capture/approval-bot behind profiles; `LIVE_TRADING` literal false), Dockerfile, Dockerfile.capture, backup scripts and systemd units, two Telegram-only egress firewall chains + units.
- Dependencies: BullMQ, ioredis, Fastify 4, drizzle-orm, pg, node-cron, TDLib (Python client); see `docs/implementation/REUSE_INVENTORY.md`.

## Historical runtime evidence (staging, read-only, observed 2026-10-24T21:15:29Z; dated, NOT current status)
Only aggregate counts and image tags are recorded; run states, health, schedules and host details are deliberately omitted. These figures may have changed.
| Item | Observation |
|---|---|
| Image tags | api and worker `capture-8cb22f9`; approval bot `bot-aba762bb`; capture `capture-2762179-1ad16990` (run states not recorded) |
| Migrations | 9 recorded (matches repository) |
| Rows | telegram_sources 3, telegram_messages 45, telegram_message_events 45, options_claims 45, signals 0, signal_validations 0, market_observations 0, orders 0, positions 0, backtests 0, claim_review_cards 1 (test), claim_reviews 0, approval_bot_state 0 |
| Message provenance | api_history 32 (2026-10-21..23), api_live 12 (2026-10-23..24), bot_webhook 1 |
| Events | seen 43, edited_observed 1, deleted_observed 1; bot: handshake_card_sent 1, test_decision 1 |
| Claims | claim/INSUFFICIENT_EVIDENCE 44, unsupported 1 |

## Inferred (not observed)
Image-to-commit correspondence for api/worker (`capture-8cb22f9`) was not verified (F-009). Redis persistence settings are read from the compose file, not from a live `CONFIG GET`.
