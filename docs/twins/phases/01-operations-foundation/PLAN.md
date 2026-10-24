# P01 - Operations foundation: provenance, monitoring, backups, CI

- **State:** NOT_STARTED
- **Depends on:** P00
- **Primary requirements:** TG-12, XC-01, XC-02, XC-03, XC-04, XC-08
- **Also checked here (cross-phase dependencies/acceptance):** SRC-01, TG-14
- **Findings (primary owner):** F-008, F-009, F-015
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Make the staging system reproducible, observable and recoverable before more irreplaceable data and features accumulate.

Scope:
- Tie every running image to a commit (labels + manifest) and plan the redeploy of api/worker from a tagged commit.
- Monitoring and alerting with an out-of-band owner alert path: container health, worker liveness, queue depth, failed/dead-letter jobs, backup freshness, capture lag.
- Off-host encrypted backup copy, key escrow, backup-failure alert, restore drill from the off-host copy, retention policy.
- Dead-letter policy for poison jobs.
- CI hardening: dependency audit, secret scan, and a recorded hosted-CI run on a tagged commit.
- Host posture re-inspection (SSH, exposed services) and owner-run remediation decisions.

## 2. Explicit non-goals
- No new product features.
- No change to Traefik, DNS or the public webhook routing unless separately approved.
- No credentials handled by the assistant.

## 3. Required inputs and entry gates
- D-014a: transactional outbox selected as the DESIGN DIRECTION (2026-10-24), subject to implementation review and failure-test evidence. This is not implementation or deployment approval.
- D-030: initial outbox rules decided (no automatic pruning; unfinished and failed work never deleted; failed rows require an alert path). Still unresolved and therefore NOT configured: completed-row retention/grace, pending-age and depth thresholds (to come from rehearsal measurements plus owner approval), and the alert destination (Q-018).
- Q-007 (off-host backup target and key custody) for subphase 1C; Q-011 for host items; explicit approval before any staging deployment.
- Q-007 explicitly DEFERRED (D-040): off-host backup activation, key escrow, off-host restore acceptance and the relevant G1 acceptance stay BLOCKED; local-only copies are not claimed to mitigate loss of the host. Q-017 explicitly DEFERRED (D-041): production retention/pruning jobs, acceptance of the diagnostic-data remediation and exports/sharing needing the privacy decision stay BLOCKED; no existing data is pruned. Q-018 explicitly DEFERRED (D-042): external alert activation or test messages, production alert-readiness claims and the relevant acceptance and G1 stay BLOCKED; local rehearsal logging is not an approved production alert channel.

## 4. Existing reusable components and evidence
- `infrastructure/staging/twins-backup.sh, twins-backup.timer, restore-check-postgres.sh` - daily encrypted backup with restore proof (per the 2026-10-24 backup commit)
- `scripts/ops/capture-watch.sh` - event vocabulary and anomaly rules reusable for a persistent watcher
- `.github/workflows/ci.yml` - existing verify job to extend
- `infrastructure/staging/*egress-firewall*` - verified fail-closed network controls

## 5. Subphases (independently testable)
- **1A** Image provenance and reproducible build
- **1B** Monitoring and alerting
- **1C** Off-host backup, escrow, restore drill
- **1D** Dead-letter policy and CI hardening
- **1E** Durable intake (persist-then-enqueue / outbox)

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T01.1 | Add `org.opencontainers.image.revision` + manifest hash labels to every image build script; write a build-from-tag procedure. | infrastructure/staging/Dockerfile*, scripts/ops/ | - |
| T01.2 | Persistent watcher service for container state, queue depth, failed jobs, backup age, capture lag; alert delivery to an owner-controlled channel. | scripts/ops/, infrastructure/staging/ | T01.1 |
| T01.3 | Worker liveness signal (health file or heartbeat key) since it has no HTTP surface. | services/worker/src/index.ts | - |
| T01.4 | Off-host encrypted copy + escrowed key + failure alert; scripted restore drill from the off-host copy. | infrastructure/staging/twins-backup.sh, restore-check-postgres.sh | - |
| T01.5 | Dead-letter handling: failed-set retention, review command, alert on first failure. | services/worker/src/index.ts, scripts/ops/ | - |
| T01.6 | CI: `npm audit` (policy for accepted advisories), secret scan, record hosted run URL for tagged commit. | .github/workflows/ci.yml | - |
| T01.7 | Re-inspect host SSH/exposure posture read-only and produce owner action list. | docs/twins/audit/08_SECURITY_AND_OPERATIONS_AUDIT.md | - |
| T01.8 | Durable intake per the transactional-outbox design direction (D-014a): ingest transaction (raw + outbox), dispatcher with leases, reconciler, flag, restricted API role, completion in the same transaction as derived effects, failure matrix 1-10. No pruning job. | apps/api/src/internalIngest.ts, apps/api/src/index.ts (F1-scope file), services/worker/src/index.ts, packages/ingestion/src, packages/database/drizzle/ | - |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Alert record: `{component, severity, observed_at, evidence_ref}`; image label contract `revision`, `manifest_sha256`. Backup status file contract extended with `offhost: ok|failed|stale` and `age_seconds`.

### Proposed durability design for intake (design direction selected under D-014a; NOT implemented; NOT deployment approval)

**Current acknowledgement boundary.** `apps/api/src/internalIngest.ts` validates, authenticates, applies caps and the approved-chat gate, then enqueues a BullMQ job and returns HTTP 200. PostgreSQL persistence happens later in `services/worker`. Between the 200 and the worker's insert, the only copy is the Redis job. This is the **known legacy durability limitation**.

**Proposed acknowledgement boundary (transaction T1).** HTTP 200 is returned only after one PostgreSQL transaction commits containing (a) the raw message / revision / deletion-event rows (the same idempotent inserts the worker performs today) and (b) one `ingest_outbox` row per message/event: `(id, idempotency_key UNIQUE, kind, message/event ids, state, attempts, available_at, lease_until, last_error_code, created_at, completed_at)`. The outbox references ids and never copies content. Redis is never on the acknowledgement path. Authentication, caps and the chat gate run before any write. Database failure -> `503` + `Retry-After`, nothing acknowledged; the capture client's capped-backoff queue (`twins_capture/ingest.py`) redelivers.

**States.** `pending` -> `enqueued` -> `done`, or -> `failed`. (A job being processed is `enqueued` with a live lease; there is no separate in-memory state.)

**Authoritative completion state.** `done` in `ingest_outbox` is the only authoritative completion marker. BullMQ job state is transport and is never authoritative. `done` is written in the **same PostgreSQL transaction (T3)** as the derived effects it represents (for example the options-claim row for a parsed message), so `done` implies those effects are committed and committed effects without `done` are harmless to repeat because they are idempotent. Effects that need external I/O (market-data refresh, provider calls) are not part of a database transaction; they are modelled as separate follow-up outbox kinds, each with its own state, so one slow or failing external call cannot hold a message's completion or be silently skipped. Whether a given enrichment is required for `done` or is a follow-up kind is decided per effect at implementation review.

**Transaction boundaries.**
- T1 (acknowledge): raw + events + outbox insert, commit, then respond.
- T2 (claim): short transaction taking the lease with `FOR UPDATE SKIP LOCKED`; the Redis enqueue happens after it commits. A crash between T2 and the enqueue is covered by lease expiry.
- T3 (derive + complete): idempotent derived inserts and `UPDATE ... SET state='done'` (guarded by state and lease) in one transaction; any failure rolls both back.
- T4 (fail): after the capped attempts, a separate transaction sets `failed` with a sanitized error code (never content).

**Recovery for every non-done state.**
| State | Situation | Recovery |
|---|---|---|
| pending | dispatcher not running or slow | stays pending; the next dispatcher claims it; age is observable (alert threshold NOT configured - see D-030) |
| enqueued, lease live | worker running | wait; effects roll back if the worker dies (T3 is one transaction) |
| enqueued, lease expired (worker crash, Redis wiped, job lost) | no completion | row returns to pending (attempts + 1) and is re-enqueued with the same `jobId`; a surviving duplicate job is ignored by the queue |
| failed | attempts exhausted or poison payload | never deleted and never auto-retried further; an alert is required; an explicit, audited operator command moves it back to pending |
| any state during DB outage | cannot write | nothing is acknowledged (503); nothing is lost because the sender still holds the message |

**Duplicate replay handling.** A re-delivered message conflicts on the unique message key: the raw insert is a no-op, the outbox `idempotency_key` conflict creates no second row, and the API returns 200 with the item counted as a duplicate. A duplicate dispatch is ignored through the BullMQ `jobId`. A job running for a row already `done` exits without effect. Edits and deletions carry their own revision/event keys, so they produce distinct outbox keys and are order-independent. Reprocessing a `done` row is never automatic; it requires an explicit operator action under a new derive version.

**Retention (D-030, initial).** No automatic pruning of any outbox row. Unfinished (`pending`/`enqueued`) and `failed` rows are never deleted. How long `done` rows are kept (grace period) is a later owner decision; until then nothing is removed.

**Alerts (D-030, initial).** Failed rows require an alert path. Pending-age and depth thresholds stay explicitly **unconfigured** until rehearsal measurements exist and the owner approves values, and the alert destination is unresolved (Q-018). Production alert readiness must not be claimed while any of these is open.

**Security.** The API process needs INSERT on the message, event and outbox tables only; use a separate restricted role from the worker, proven by a privilege test in the style of `tests/integration/approvalBot/rolePrivileges.test.ts`. Content is never logged.

**Migration and rollback limitations.** One additive migration (migrations are frozen once applied; rollback is by flag and by restore-from-backup, never a down-migration). Flag `TWINS_INGEST_MODE=legacy|durable`, default `legacy`. **A rollback to `legacy` restores the known legacy durability limitation (acknowledge-after-Redis-enqueue); it is not equivalent durable operation.** Items acknowledged while in `legacy` mode again depend on Redis until processed. Safe rollback order: set `legacy`, keep the drain code running until every outbox row is `done` or explicitly accounted for, and only then change the image; never delete rows. Rolling the image back first would strand pending rows.

**Failure tests (real PostgreSQL + Redis, rehearsal database).**
| # | Scenario | Expected |
|---|---|---|
| 1 | API killed after commit, before the 200 | client retries; duplicate is a no-op; exactly one stored message |
| 2 | PostgreSQL down or slow | 503 + Retry-After; zero acknowledgements; client eventually delivers; no loss |
| 3 | Redis volume wiped after an acknowledged ingest | dispatcher replays from the outbox; message processed once |
| 4 | Dispatcher crash after enqueue, before marking | duplicate enqueue ignored (same jobId); one processing |
| 5 | Worker crash mid-processing (before T3 commits) | lease expiry -> retry; exactly one derived row; `done` only after T3 |
| 6 | Two dispatchers concurrently | each row dispatched once, or harmlessly twice |
| 7 | Poison payload | row `failed`, alert raised, row not deleted; other rows continue |
| 8 | Deletion/edit arrives before the original | eventually consistent end state; no loss |
| 9 | Burst above caps | 429 with Retry-After; nothing acknowledged is lost |
| 10 | Rollback to `legacy` with pending rows | worker drains them; no loss; the limitation label is shown |

**Still open:** completed-row grace period; pending-age/depth thresholds and their approval; alert destination (Q-018); API DB role scope; per-effect decision of required-vs-follow-up completion.

## 8. External dependencies and permissions
- Off-host storage target and scoped credentials entered by the owner.
- A notification channel the owner controls.
- Owner decisions on SSH hardening on the shared host.

## 9. Tests
- **Unit:** Static tests of scripts (existing pattern: tests/unit/infrastructure/twinsBackup.test.ts, captureWatch.test.ts).
- **Integration:** Watcher against injected log/state streams; backup script against a scratch PostgreSQL.
- **End-to-end:** Controlled failure of each monitored component produces exactly one alert.
- **Failure-path:** Backup destination unreachable -> alert and status `failed`.; Poison job -> failed set + alert, not silent loss.; Failure matrix scenarios 1-10 of the durability design; no-pruning check; rollback label check.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-01.1 `docker inspect` of each running TWINS image shows a revision label equal to a tagged commit.
- A-01.2 Each monitored failure in the controlled drill raises an alert within the documented interval.
- A-01.3 A restore from the off-host copy into a scratch database passes the existing checkpoint comparison.
- A-01.4 Hosted CI run on the tagged commit is green with audit and secret-scan steps present.
- A-01.5 After an acknowledged ingest, wiping Redis loses no message (outbox replay test on real PostgreSQL + Redis).
- A-01.6 The ingest failure matrix (crash after commit before 200, DB outage, dispatcher crash, worker crash, concurrent dispatchers, poison payload, out-of-order revision/delete) passes on real PostgreSQL + Redis.
- A-01.7 Rolling back to `legacy` drains or accounts for every outbox row without loss, and the rollback is documented and labelled as restoring the known legacy durability limitation - not equivalent durable operation.
- A-01.8 No outbox row is ever pruned automatically; unfinished and failed rows are never deleted (test and static check).
- A-01.9 Production alert readiness is NOT claimed while pending-age/depth thresholds or the alert destination are unresolved; rehearsal measurements are recorded as input to the owner's threshold decision.

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Image inspect output, hosted CI URL and log, alert drill transcript, restore drill report.

## 12. Rollback / recovery approach
Each sub-phase is additive: remove the watcher unit, revert image tags in staging.env (previous tags are retained), disable the off-host copy job.

## 13. Exit gate and handoff
User reviews evidence and authorizes the next phase; deployment of new images requires its own approval.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
