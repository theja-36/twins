# Risk-decision expiry and loss circuit breakers - Stage 3 / Task 4

> Decision [D-058](DECISION_LOG.md); requirement [SZ-15](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [RISK_DECISIONS.md](RISK_DECISIONS.md), [POSITION_SIZING.md](POSITION_SIZING.md), [PORTFOLIO_RISK_LIMITS.md](PORTFOLIO_RISK_LIMITS.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/risk/src/expiry/`, `packages/risk/src/breakers/`, `scripts/ops/risk-control.ts`, scheduler jobs, migration `0017_circuit_breakers`.

Nothing here places an order, calls a broker, sends an approval card or creates executable state.

## 1. Risk-decision expiry
**Validity windows** (measured from the creation time of a decision's LATEST version; configurable, a malformed value throws): `PENDING` **30 minutes** (`TWINS_RISK_EXPIRY_PENDING_MINUTES`), `APPROVED_FOR_REVIEW` **15 minutes** (`TWINS_RISK_EXPIRY_APPROVED_MINUTES`). A new version (sizing, portfolio evaluation) starts its own window.
**Mechanism:** a stale decision gets a NEW `EXPIRED` version (`service:risk-expiry`, reason `expired_pending` / `expired_approved_for_review`, the plan and an `expiry` record in the snapshots); the original row is never touched. Idempotent (key per decision) and concurrency-safe (the unique successor index: one expirer wins, the rest report `already_expired`).
**Exposure frees immediately:** the portfolio query applies the same windows, so a lapsed decision stops counting at once - even before the job has recorded the EXPIRED version. A candidate that is itself past its window is not sized or evaluated (`decision_expired`).
**Under the kill switch:** expiry only removes exposure, so an `EXPIRED` version (and only that status, only when the expiry module asks) bypasses the intake controls; nothing else can.
**Job and command:** scheduler job `risk_decision_expiry` (`TWINS_RISK_EXPIRY_CRON`, default every minute; effect `risk_housekeeping`, not gated by trading state). Operations: `risk-control expiry list|run [--dry-run] [--as-of ISO] [--limit N]` (compose: `--profile ops run --rm risk-control ...`; local: `npm run risk:control -- ...`).

## 2. Circuit breakers
Daily limit **2%** and weekly limit **5%** of capital (`TWINS_BREAKER_DAILY_LOSS_PCT`, `TWINS_BREAKER_WEEKLY_LOSS_PCT`; weekly ≥ daily), warning at **75%** of a limit (`TWINS_BREAKER_WARN_PCT`). Capital is the same configured value as sizing (`TWINS_SIZING_AVAILABLE_CAPITAL`).
**Periods (IST, `TWINS_BREAKER_UTC_OFFSET_MINUTES`=330):** a day is local midnight to midnight, a week Monday 00:00 to the next Monday 00:00. A **daily breach lasts until the next trading day** (the next weekday - a Friday or weekend breach lifts on Monday 00:00; there is no holiday calendar); a **weekly breach until the next Monday**.
**State is derived, never updated.** Two append-only, hash-chained tables (chains 8 and 9; UPDATE/DELETE/TRUNCATE rejected, also under replica role): `loss_events` and `circuit_breaker_events` (WARNED / BREACHED / RESET). A breaker is open while a BREACHED event's reset time is in the future and no RESET references it - or while the computed realized loss for the current period is at/over its limit. `getCircuitBreakerStatus` reports per scope: realized loss, planned (at-risk) exposure of decisions created in the period, limit, loss %, status (CLEAR / WARNING / BREACHED), breach time and reason, reset time, last reset and its authorization.
**Breach rules:** realized loss ≥ limit → one `BREACHED` event per scope and period (idempotent), reason `daily_loss_limit_breached` / `weekly_loss_limit_breached`, reset time recorded. Planned exposure is reported but does not trip a breaker (only realized loss does).
**Reset rules:** only **automatic, at the period rollover** (`RESET` with authorization `automatic:period_rollover`, recorded by the next evaluation after the reset time). There is deliberately **no early/operator reset** (D-058): a breached limit is not lifted mid-period without an owner decision.
**Separate from the kill switch.** The breaker never reads, writes or lifts `KILL_SWITCH_ACTIVE`; every enforcement point checks the kill switch FIRST and independently. The kill switch therefore overrides a reset: after the breaker resets, new work is still refused while the switch is on (tested). `LIVE_TRADING` guard, `TRADING_ENABLED` and `INTAKE_ENABLED` are unchanged and independent.

## 3. Loss accounting foundation
`loss_events`: loss **magnitude** > 0, occurred-at, source (`synthetic`, `manual_adjustment`, `broker_reconciliation`), unique external `source_ref`, optional risk-decision link, idempotency key, actor. **No P&L is ever derived from a signal or a decision, and a profit never offsets a loss.** No fills exist yet, so the only producers are tests/drills (`synthetic`, refused when `APP_ENV=production`) and an operator (`manual_adjustment`). The future broker reconciliation implements the `LossEventSource` interface (`fetchLossEvents(range)`) and calls `ingestLossEvents`; the `broker_reconciliation` source value is reserved for it. Recording a loss is never blocked by any control.

## 4. Enforcement
| Point | Behaviour while a breaker is open |
|---|---|
| New **sized** decision (`sizeRiskDecision`) | not created; a `REJECTED` sizing version `sizing_circuit_breaker_open` is recorded (sizing is redone after the reset) |
| Transition to `APPROVED_FOR_REVIEW` (`evaluatePortfolioRisk`) | not granted; a `REJECTED` version `portfolio_circuit_breaker_open` is recorded (re-evaluated after the reset) |
| **Database** (migration 0017) | trigger `risk_decisions_b_breaker_before_insert` refuses any `APPROVED_FOR_REVIEW` row; `orders_require_risk_decision` refuses any order - raw SQL included |
| Future approval-to-order / order intent | covered by the orders trigger above |
| Reading signals/decisions, recording rejections or audit events, loss events, expiry, `getCircuitBreakerStatus`, the CLI `status` | **never blocked** |
The state is evaluated (and the breach recorded) at the enforcement point itself, so there is no gap between scheduler runs. **If the breaker state cannot be read the operation is refused** (`circuit_breaker_unavailable`, nothing written, no driver text). The database gate uses the database clock; the application logic takes an `asOf` (tests, drills).

## 5. Alerts (existing alerting system; fixed templates, scope and percentages only)
`risk.circuit_breaker.warning` **WARNING** at 75% of a limit · `risk.circuit_breaker.breached` **CRITICAL** on a breach · `risk.circuit_breaker.reset` **INFO** on a reset; codes `daily_|weekly_loss_warning`, `..._loss_limit_breached`, `..._breaker_reset`. Details are limited to the allow-listed `scope`, `lossPct`, `limitPct` (no amounts, identities, messages or free text; secret-shaped values are redacted). An alert is raised only by the call that CREATED the event, so each event alerts once. The scheduler job `circuit_breaker_evaluation` (`TWINS_BREAKER_CRON`, default every minute) uses an alerter that delivers INFO; the destination is the configured relay/webhook.

## 6. Operations
`risk-control expiry list|run`, `risk-control breakers status|evaluate [--capital N] [--as-of ISO]`, `risk-control breakers record-loss --amount N --source-ref REF --created-by operator:NAME [--source manual_adjustment|synthetic] [--occurred-at ISO]`. Exit codes 0 ok, 1 failure, 2 usage, 3 refused. The live-trading guard runs first; the connection string is never printed.

## 7. Limits and remaining risks
* **No real losses exist yet** (no fills / reconciliation), so in practice the breakers can only be tripped by operator or synthetic events; the interface for broker reconciliation is in place but unimplemented.
* The scheduler is a `scheduler` compose profile that is OFF in staging; expiry and breaker alerting run only while it is on (enforcement points evaluate the breakers regardless; expiry's effect on exposure is also applied by the portfolio query).
* No holiday calendar: a weekday holiday counts as a trading day for the reset.
* Realized loss only; open (unrealized) losses and planned exposure do not trip a breaker.
* The worker has no alerter, so a breach first noticed by sizing/evaluation is alerted only if it was created by a process with a hook (the scheduler); the event is always recorded.
* The breaker uses the single configured capital; if capital changes mid-period the limit moves with it.
