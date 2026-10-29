# Durable Telegram intake outbox - Stage 2 / Task 2

> Decision [D-050](DECISION_LOG.md); requirement [TG-12](REQUIREMENTS_TRACEABILITY.md); evidence in [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md); CI in [CI.md](CI.md). Not deployed: staging still runs the previous image until a later, separately approved task.

## What problem this closes
Before this task a message the API had acknowledged existed ONLY as a Redis job until the worker wrote `telegram_messages`. A Redis wipe, an unpersisted AOF tail or a dead worker with an exhausted job therefore lost an acknowledged message. Now **an acknowledgement means the message is a committed row in PostgreSQL**. Redis carries only a pointer (the row id) and is a performance path, not a source of truth.

## Flow
```
capture client / Telegram ──► API (auth, safety gate, chat gate, caps)
                                 │ 1. INSERT telegram_intake_outbox (PENDING)   ← durable; failure => 503, nothing acknowledged
                                 │ 2. queue.add("telegram_outbox", {outboxId}) ← best effort; failure => still 200/202, logged enqueue_failed_but_durable
                                 ▼
                      Redis (signal_queue, job id outbox-<row id>-<attempt_count>)
                                 ▼
worker: assert intake allowed ─► claim row atomically (PENDING|FAILED → PROCESSING, attempt_count+1, locked_by/at)
        run the EXISTING pipeline on the stored payload (telegram_messages → signals → validation …)
        COMPLETED | FAILED (retry scheduled) | DEAD_LETTER
reconciler (worker process, every 10 s): recover expired leases, re-enqueue rows whose Redis job was never created or was lost
```
Both intake routes (Bot API webhook `POST /webhooks/telegram`, User API capture `POST /internal/ingest/telegram-user`) use the same `IntakeService` (`apps/api/src/intakeService.ts`). Jobs queued before this change keep their full payload and are still processed by the unchanged legacy path (deploy-safe).

## Table `telegram_intake_outbox` (migration 0012)
| Column | Meaning |
|---|---|
| `id` | row id; the only thing Redis carries |
| `message_type` | `message`, `edit` (a later revision) or `deletion` |
| `intake_source` | `bot_webhook` or `user_capture` |
| `source_message_id` | the message's own revision identity (`externalMessageId`); for a deletion `del-<sha256/12 of the sorted id set>` |
| `channel_id`, `channel_type` | `tg_chat_<chat.id>` (canonical identity), `telegram_chat` |
| `author_id` | reserved, NULL (neither intake path carries an author id today) |
| `raw_payload` | the exact job payload the worker processes (message text and Telegram raw payload byte-for-byte, capture provenance, correlation). Untrusted external content, like `telegram_messages.raw_payload` |
| `correlation_id`, `received_at` | log correlation; API receipt time |
| `available_at` | earliest next attempt (`now()` at insert; backoff time after a failure) |
| `enqueued_at` | when a Redis job for the current attempt was accepted; NULL = not (yet) enqueued, which the reconciler repairs |
| `attempt_count`, `max_attempts` | attempts started / limit (default 8) |
| `status` | PENDING, PROCESSING, COMPLETED, FAILED, DEAD_LETTER |
| `last_error` | an error **code or class name only**, ≤ 60 chars (an error message can embed row values and is never stored) |
| `locked_at`, `locked_by` | lease start and holder (`<host>:<pid>`); set exactly while PROCESSING (check constraint) |
| `completed_at`, `created_at`, `updated_at` | set exactly when COMPLETED (check constraint); `updated_at` is maintained by the trigger |

No separate `normalized_payload` column: the worker re-derives everything from `raw_payload`, and a claim reference to the resulting `telegram_messages` row would be a second, non-atomic write; the downstream rows already carry the message identity. (Add one only if an operator query needs it.)

### Statuses and transitions (enforced by the BEFORE UPDATE trigger, `ENABLE ALWAYS`)
| From | To | Who |
|---|---|---|
| PENDING / FAILED | PROCESSING | worker claim (`due` rows only: `available_at <= now()`) |
| PROCESSING | COMPLETED | the lock holder, after the pipeline succeeded |
| PROCESSING | FAILED | the lock holder (retry scheduled, `available_at` = backoff) or the reconciler (lease expired, due at once) |
| PROCESSING | PENDING | a safety refusal after the claim: the attempt is **given back** (`attempt_count - 1`), so a pause can never dead-letter a message |
| PROCESSING | DEAD_LETTER | attempts exhausted, or a permanent invalid-input error, or an expired lease on the last attempt |
| PENDING / FAILED | same | only `enqueued_at` changes |
`COMPLETED` and `DEAD_LETTER` are terminal: **no column of such a row can change**. Identity and payload columns (`id`, `message_type`, `intake_source`, `source_message_id`, `channel_*`, `author_id`, `raw_payload`, `correlation_id`, `received_at`, `max_attempts`, `created_at`) never change. Rows are never deleted or truncated (trigger; the runtime role also has no DELETE grant, `app-role.sql` grants SELECT/INSERT/UPDATE to the runtime role automatically because the table is not append-only).

## Idempotency rules
1. **Outbox identity** = unique `(channel_id, source_message_id, message_type)`. A duplicate API delivery (Telegram redelivery, capture retry, live then history capture of one message) hits `ON CONFLICT DO NOTHING`: no second row, logged `outbox.duplicated`, answered as a duplicate. The payload and correlation of the FIRST delivery are kept.
2. **Edits** carry their own `source_message_id` (the shared revision identity, `revisionExternalId`) and type `edit`: an edit is a separate durable row, the original is never touched, and revision currentness is still decided downstream from `edit_date`, never from arrival order.
3. **Deletions**: one `deletion` row per distinct SET of deleted ids. Downstream they are recorded as append-only `deleted_observed` events; nothing in `telegram_messages` is removed or rewritten.
4. **Redis job id** `outbox-<id>-<attempt_count>`: repeated enqueues of one attempt (API retry, concurrent reconcilers) collapse in BullMQ; the next attempt gets a new id, so a retained completed job can never swallow a retry.
5. **Claim** is a single conditional UPDATE: of any number of concurrent or duplicate deliveries exactly one wins; the rest log `outbox.claim_skipped` and do nothing. The claim uses the **database clock** so a skewed application clock cannot make a fresh row unclaimable.
6. **Downstream** is the pre-existing idempotent pipeline (unique `(source, external_message_id)`, deterministic signal/validation keys, `onConflictDoNothing`). A replay after a crash re-uses the committed message row (`inserted 0, duplicates 1`); verified by a real SIGKILL test. The pipeline is still a sequence of autocommitted statements, not one transaction: exactly-once effects come from idempotency, not from atomicity (see Remaining limits).

## Retry policy
`delay = min(15 min, 5 s × 2^(attempt-1)) × random(0.5 … 1.0)` (full-jitter lower half), where `attempt` is the attempt that just failed: ≈ 5 s, 10 s, 20 s, 40 s, 80 s, 160 s, 320 s, 640 s (each ±50 %). `max_attempts` = 8. The handler never throws on a pipeline failure (the outbox, not BullMQ, owns the retry; BullMQ's own 3 attempts only cover a failure to *record* the outcome). After the last attempt the row is `DEAD_LETTER`, kept, and `safety.outbox.dead_lettered` (level error) is logged with `outboxId`, `attempt`, `permanent`, error code. A permanent invalid-input error (BullMQ `UnrecoverableError`, e.g. a malformed timestamp) dead-letters on the first attempt. There is no automatic replay of a dead letter and no tool yet to replay one (see Remaining limits).

## Reconciliation policy (`services/worker/src/outbox.ts`, `reconcileOutbox`)
Runs in every worker process every `TWINS_OUTBOX_RECONCILE_INTERVAL_MS` (default 10 000; 1 000-86 400 000). Safe in any number of processes at once.
1. **Gate first**: `evaluateSafety("intake")`. Intake disabled, kill switch active or state unreadable ⇒ log `outbox.reconcile_skipped` and touch **nothing**.
2. **Expired leases**: PROCESSING rows with `locked_at < now - lease` (`TWINS_OUTBOX_LEASE_MS`, default 300 000 = 5 min; must exceed the longest legitimate processing time) become FAILED and due at once (`last_error = lease_expired`), or DEAD_LETTER when `attempt_count >= max_attempts`. Logged `outbox.reconciled action=lease_expired`.
3. **Redeliver**: PENDING/FAILED rows with `available_at <= now` that were never enqueued for this attempt (after a 5 s grace so the API's own enqueue can finish) or whose enqueue is older than 60 s are enqueued with the attempt-scoped job id and marked `enqueued_at`. Logged `outbox.reconciled action=re_enqueued`.
A worker that lost its lease cannot complete or fail the row (conditional on `locked_by`); its replay is idempotent downstream.

## Runtime safety integration (fail closed)
* API: the existing `evaluateSafety("intake")` gate runs before anything is read or written; refused ⇒ 503 `intake_paused`, no row.
* Worker: `assertIntakeEnabled` runs **before the claim**. A refusal (also one raised after the claim) goes through the existing intake gate: the Redis job returns to the queue without consuming an attempt and the outbox attempt is given back.
* Reconciler: see above. Database unreachable at intake ⇒ the write throws ⇒ generic 503; nothing is acknowledged, nothing enqueued.

## Observability
Structured logs only (there is no metrics backend yet; counters can be derived from these events). Fields are ids, counts and codes - never message text, payload fields, credentials or error messages.
`outbox.accepted`, `outbox.duplicated`, `outbox.enqueued`, `outbox.enqueue_failed_but_durable` (warn), `outbox.persist_failed` (error; request answered 503), `outbox.mark_enqueued_failed`, `outbox.claimed`, `outbox.claim_skipped`, `outbox.completed`, `outbox.retry_scheduled` (warn), `outbox.released`, `outbox.lease_lost`, `outbox.reconciled`, `outbox.reconcile_skipped`, `outbox.reconcile_enqueue_failed`, `outbox.reconcile_failed`, `safety.outbox.dead_lettered` (error).

## Failure behaviour
| Failure | Result |
|---|---|
| PostgreSQL unreachable at intake | 503, nothing acknowledged, no Redis job |
| Redis down / slow / loses data after the row is committed | 200/202 returned (row is durable); `enqueue_failed_but_durable`; reconciler enqueues; sender need not retry |
| Worker dies after claim | row stays PROCESSING; BullMQ may redeliver the stalled job (finds the row leased: no-op); after the lease the reconciler returns it to FAILED and a new attempt completes it |
| Pipeline error | FAILED + backoff, then DEAD_LETTER after 8 attempts |
| Intake disabled / kill switch / state unreadable | API refuses; worker leaves rows untouched; reconciler idle; processing resumes when cleared, nothing lost |
| Duplicate API delivery / duplicate Redis job | no second row / harmless claim miss |

## Configuration
`TWINS_OUTBOX_RECONCILE_INTERVAL_MS` (10 000), `TWINS_OUTBOX_LEASE_MS` (300 000). Retry policy and `max_attempts` are code constants / column defaults (change by migration or code review, not by environment).

## Remaining limits (explicit)
* The pipeline after the claim is still autocommitted statements: a crash between them is repaired by an idempotent replay, not rolled back. TG-12 asks for done "in the same transaction as the derived effects"; that needs the pipeline moved into one transaction (future work) so TG-12 stays **PARTIAL**.
* The raw message exists in `telegram_intake_outbox.raw_payload` and later (byte-identical) in `telegram_messages.raw_payload`; the outbox copy is intentionally kept forever (no pruning; D-030).
* No operator tool or runbook to inspect or replay DEAD_LETTER rows, and no alert on `safety.outbox.dead_lettered` (alerting is a later stage). Query: `select id, last_error, attempt_count, updated_at from telegram_intake_outbox where status = 'DEAD_LETTER'`.
* A PROCESSING row whose pipeline legitimately runs longer than the lease would be reclaimed and replayed concurrently (idempotent, but wasteful); the 5 min lease is ≫ the observed seconds.
* Not covered by the hash-chained audit tables: the outbox is a work queue with a guarded state machine, not an audit trail (`telegram_messages` remains the chained record).
* Staging is not redeployed; the Python capture client is unchanged (it already treats 200 as accepted and 5xx as retry).
