# Runtime safety state and kill switch (Stage 1 / Task 2)

> Implemented 2026-10-29 at base commit `4646ee7` + uncommitted Stage 1 changes. Requirement entries: [XC-11 and EX-08](REQUIREMENTS_TRACEABILITY.md); decision [D-046](DECISION_LOG.md); test evidence in [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md). Complements (does not replace) the process-start `LIVE_TRADING` guard (EX-01).

## What it is
Three database-backed controls that every critical loop reads at run time, so the system can be halted without a redeploy and an unreadable state halts it too.

| Control | Seeded default | Meaning |
|---|---|---|
| `TRADING_ENABLED` | **false** | Nothing may create an order intent or act on trade state unless true. |
| `INTAKE_ENABLED` | **true** | New Telegram signals are accepted and processed only while true. |
| `KILL_SWITCH_ACTIVE` | **false** | When true: no new intake, no new decisions/proposals/cards, no approvals persisted, no order intent. **Dominates the other two** (intake and trading are refused whatever their values). |

Storage: `system_controls` (exactly three permanent rows; migration `0009_system_controls_kill_switch`) and `system_control_events` (append-only audit). Schema: `packages/database/src/schema/systemControl.ts`.

## Audit (immutable, written by the database itself)
Each change records **previous value, new value, reason, changed_by, changed_at, version and event type** in `system_control_events`. The rows are written by triggers on `system_controls`, not by application code, so raw SQL cannot change a control without an event:
- `BEFORE UPDATE`: control name immutable; version must be exactly old+1; the value must flip; the reason must be new; `changed_at` is stamped by the database (cannot be back-dated).
- CHECK constraints: reason 8-500 characters (non-blank), `changed_by` `^[A-Za-z0-9._@:-]{2,64}$`.
- `AFTER INSERT/UPDATE`: insert the event (the migration's three seed rows each produce a `seed` event with `previous_value` NULL).
- `DELETE`/`TRUNCATE` on `system_controls` and `UPDATE`/`DELETE`/`TRUNCATE` on `system_control_events` are rejected (SQLSTATE 23001), like the other append-only tables (0007, 0008).
Since Task 3 the table is also hash-chained and the guards are ENABLE ALWAYS, the runtime role cannot write it, and disabling a guard is recorded and detected ([IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md)); a superuser can still bypass everything and is the residual risk.

## The shared module: `@twins/runtime-state` (`packages/runtime-state`)
`isTradingEnabled()`, `isIntakeEnabled()`, `isKillSwitchActive()`, `assertTradingEnabled(op)`, `assertIntakeEnabled(op)`, `assertKillSwitchInactive(op)` (+ non-throwing `evaluateSafety(requirement, op)` for gates that must answer rather than throw, `forceRefreshRuntimeState()`, and `assertOrderIntentAllowed(op)` = live-trading guard then trading state). A process calls `configureRuntimeState({ source, logger })` once at start; an unconfigured process refuses everything (`state_unavailable`/`not_configured`).
- `assertIntakeEnabled`: refuses if the kill switch is active or intake is disabled. `assertTradingEnabled`: refuses if the kill switch is active or trading is disabled. `assertKillSwitchInactive`: refuses if the kill switch is active.
- A refusal is one error type, `SafetyRefusalError{operation, reason}` with `reason` = `kill_switch_active | intake_disabled | trading_disabled | state_unavailable`.

## Fail closed
The query rejects, the query exceeds the timeout (default 2 s), the result is not an array, a control row is **missing**, duplicated, non-boolean or has an invalid version, or the process is unconfigured -> every assertion refuses (`state_unavailable`), `isTradingEnabled()`/`isIntakeEnabled()` return false and `isKillSwitchActive()` returns **true**. Nothing defaults to enabled. Errors are not swallowed: each failure is logged as `safety.state_unavailable` (reason code and SQLSTATE-class code only, never a driver message) and surfaces as the refusal's `cause`. A failed refresh **drops** the previous snapshot, so a stale "enabled" is never served.

## Cache policy
Process-local, **3 s TTL** (configurable 0-5 s; anything else throws at construction). Concurrent callers share one in-flight read. A failed read is remembered for 1 s so an outage does not hammer the database (still failing closed). The clock is monotonic and a clock that goes backwards expires the cache. `forceRefresh()` bypasses and replaces the cache and ignores an older in-flight read (tests, operational tooling). Consequence: a change made by the CLI reaches every process within one TTL (<= 3 s by default). No Redis is used: the cache is per process by design.

## Integration points (all tested; static proof in `tests/unit/safety/runtimeStateCoverage.test.ts`)
| Boundary | Where | Requirement | On refusal |
|---|---|---|---|
| Telegram intake worker | `processTelegramQueueJob`, `processTelegramEventsQueueJob` (`services/worker/src/index.ts`), first statement | intake | job returned to the queue untouched, **no attempt consumed**, worker paused 5 s (`services/worker/src/safetyGate.ts`, BullMQ `RateLimitError`); nothing read or written |
| API intake | `POST /webhooks/telegram`, `POST /internal/ingest/telegram-user` (after authentication) | intake | `503` + `Retry-After: 30`, body `{error:"intake_paused", reason}`; nothing enqueued; Telegram redelivers and the capture client keeps the event in its bounded queue and retries |
| Signal / claim creation | `createSignalFromTelegramMessage`, `reparseTelegramMessage`, `recordOptionsIntake` | intake | `SafetyRefusalError` before any database access |
| Decision creation | `validateSignal` (`decision-intelligence`) | kill switch inactive | `SafetyRefusalError` before any database access |
| Approval-card creation | approval bot `sendNew` | kill switch inactive | no card created or sent; event `safety_refused:card_creation:*` |
| Approval decision persistence | approval bot, **approve only** | kill switch inactive | approve not persisted, approver told "System halted"; **reject is still recorded** (risk-reducing) |
| Order intent / broker call | `adapters/broker` `guardExecutionProvider`, applied to every provider by `executionProviders.register` | live-trading guard, then trading enabled + kill switch inactive | `placeOrder` refused before the broker is contacted. `cancelOrder`, `getOrderStatus`, `getHealth` are **not** gated (cancel is risk-reducing and must work during a halt). No broker code exists yet |
| Scheduler | `runScheduledJob` (`services/scheduler/src/scheduledJob.ts`) | `trade_state` jobs: trading enabled + kill switch inactive | job skipped, event `scheduler.job.skipped_by_safety`. `market_data` jobs (the only job today) are explicitly not trade state and are not gated |
| Capture client | no database access by design | n/a | gated through the API ingest endpoint above (it keeps events and retries) |
Not gated on purpose: read-only routes (existing records stay readable under the kill switch), the market-data worker queue, `migrate` (it creates the tables) and the operations CLI.

## Kill-switch behaviour
Active -> all of the above refuse. Every process that observes the flip emits `safety.kill_switch.observed` (error level, once per transition per process); the admin process emits `safety.control.changed` and `safety.kill_switch.activated`. **Extension point for a future emergency flatten:** `packages/runtime-state/src/emergency.ts` (`emergencyActions.register({name, run})`). Registered actions run fire-and-forget (a slow or failing action never delays a safety assertion; failures log `safety.emergency_action.failed`) on observation and in the admin process after the activating commit; a future flatten must be idempotent and decide for itself which single process acts. **Nothing is registered and no flatten logic exists.**

## Changing the controls (no public endpoint)
`scripts/ops/safety-control.ts` (`npm run safety:control -- ...`, or `docker compose ... --profile ops run --rm safety-control ...`):
`status` | `events [--limit N]` | `set --control <NAME> --value <true|false> --reason "<8-500 chars>" --changed-by operator:<name> [--expected-version N]`. A change **requires** an explicit control, an explicit boolean, a reason and a changed-by; there are no defaults or shortcuts. Rules: enabling `TRADING_ENABLED` is refused while the kill switch is active; a no-op records nothing; `--expected-version` gives compare-and-set; one transaction locks all three rows in a fixed order so concurrent changes serialize. The CLI runs the live-trading guard first, never prints the connection string or driver messages, and exits 0 ok / 1 failure / 2 usage / 3 refused.
**Authorization boundary:** possession of the owner database credential on the host or via the one-shot compose job (same boundary as migrations). The approval-bot role can only `SELECT (control_name, value, version)` on `system_controls` and has no access to the events table (`infrastructure/staging/approval-bot-role.sql`, enforced by its startup self-check and an integration test). `changed_by` is a **self-declared identity**, not authenticated; since Task 3 it must follow the convention `operator:<name>` (CLI) / `service:<name>` (automated), and each event also records the source process, declared operator context and the database-observed session (see [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md)). Authenticated operator identity is future work.

## Operational notes
- Deploy order: **migrate first (0009), then start the new images.** New images started against an un-migrated database refuse everything (fail closed), which is safe but means no intake until migrated.
- Re-granting the bot role (`approval-bot-role.sql`) is required after migration 0009 for the bot to read the controls; until then the bot's startup privilege check fails closed.
- Seeded state after migration: trading off, intake on, kill switch off, i.e. today's behaviour is unchanged until an operator changes a control.
