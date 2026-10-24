# 03 Architecture and data-flow audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Flow as built (evidence)
```
Telegram (TDLib read-only client, Python)  --HTTP, bearer, caps-->  apps/api internal ingest
Telegram Bot API webhook (legacy, not routed)  ------------------>  apps/api /webhooks/telegram
        apps/api: validate -> chat allowlist -> volume caps -> enqueue BullMQ job -> HTTP 200   [apps/api/src/internalIngest.ts]
        services/worker: persist raw message/revision/event (PostgreSQL) -> options parse -> options_claims (UNVERIFIED, approval_possible=false)
        (equity-style path) -> signals -> context -> signal_validations (immutable)
        services/approval-bot (separate service, DB role twins_bot): reads new parsed claims -> cards -> approver -> claim_reviews (append-only)
        services/scheduler (off): cron -> market_bars jobs -> Yahoo -> market_observations
```
No path leads to any order, broker, risk engine or paper/live execution.

## Architectural strengths
- Separate processes and DB roles for the approval bot (cannot read raw text or write claims).
- Idempotency keys, unique indexes as correctness boundaries, bounded producers, crash/concurrency integration tests.
- Network controls: internal-only data network, Telegram-only egress chains for capture and bot.

## Architectural gaps against the baseline
| Gap | Evidence | Requirement |
|---|---|---|
| Acknowledge-before-persist (no outbox) | internalIngest.ts: enqueue then 200 | TG-12 |
| No evidence snapshot / feature layer | no `packages/market`; context built ad hoc per signal | RE-02 |
| No risk evaluator, approvals package, execution package | placeholders only | SZ, AP, EX |
| Decision engine decoupled from options intake | 0 signals/validations on staging | F-014 |
| No end-to-end version tagging (trace id, snapshot id, strategy/model/policy versions) | only parser_version and correlation ids exist | OL-03 |
| Two scripts/servers for read-only views and API | apps/web server.ts vs apps/api | maintainability (low) |

## Durability and concurrency notes
PostgreSQL is authoritative for persisted records, but the in-flight window between acknowledgement and persistence relies on Redis AOF (TG-12). Serialization of account risk reservation and approval consumption has no implementation (SZ-06); the approval bot's single-use decision uses one transaction with a state-conditioned UPDATE (`services/approval-bot/src/db.ts:211`).

## Boundaries
- AI: no AI code runs; the planned boundary (no broker credentials, no tool access) cannot be violated today and is not yet enforced by static tests (SZ-09, TG-11).
- Browser/secrets: apps/web shows no secrets; staging.env/bot.env are host-local files outside the repository with restricted permissions.
- One service owns migrations: the `migrate` compose profile; confirmed as the only runner on staging.
