# R0B - End-to-end correlation LOGGING for the Telegram ingestion pipeline

Scope label: **end-to-end correlation logging**. It is NOT distributed tracing / OpenTelemetry: there are no spans, no trace/span ids, no collector or backend. No paid service was added. No database migration was needed or made.

## Identifier semantics (all distinct; none is a business deduplication key except the job id)
| Identifier | Meaning | Where created | Notes |
|---|---|---|---|
| `requestId` (`req_<uuid>`) | one HTTP request/delivery attempt | API, server-generated (`genReqId`) | Fastify v4 would trust a client `request-id` header; that is now disabled (`requestIdHeader:false`). A duplicate webhook request has its OWN requestId. |
| `correlationId` (`corr_<uuid>` or validated client value) | log-join key for one accepted intake through queue, worker and retries of that job | API, after authentication | Untrusted if supplied: accepted from `x-correlation-id` only after the webhook secret verified AND only if `^[A-Za-z0-9._-]{8,64}$`; otherwise an internal id is generated. Unauthenticated requests never influence it. NEVER used for deduplication. |
| `jobId` (`tg-<chat>-<message revision>`) | queue job = the existing deterministic business dedupe key | API | Unchanged. BullMQ keeps the first job per id. |
| message identity | `channelIdentifier` (chat id based), `externalMessageId`, `originMessageId` | normalized update | Logged on worker lines. |
| `attempt` / `maxAttempts` | 1-based processing attempt (BullMQ `attemptsStarted`, fallback `attemptsMade+1`) / `opts.attempts` | worker | A retry reuses the job's correlationId and reports the next attempt. |
| `intakeRequestId`, `intakeReceivedAt` | the request that CREATED the job | carried in the job | Present on worker lines when the job carries metadata. |
No claim of exactly-once delivery is made; correlation ids do not make delivery idempotent.

## Propagation path
`POST /webhooks/telegram` (secret verified) -> ids minted/validated -> `webhook.intake.accepted` -> job payload field `correlation: {correlationId, requestId, receivedAt}` (queue metadata, optional) -> `webhook.enqueue.succeeded` | `webhook.enqueue.deduplicated` | `webhook.enqueue.failed` -> worker `processTelegramQueueJob` builds a per-job child logger (`buildJobLogContext`) -> `worker.job.started` -> `worker.message.ingested` -> `worker.revision.state` -> `worker.signal.resolved|none` -> `worker.market_context.refreshed|refresh_failed` -> `worker.validation.recorded|skipped_existing|unknown_provenance` -> `worker.job.completed` (outcome, signalId, validationId, durationMs) or `worker.job.failed` (safe errorCode, errorName, retryable, durationMs). Other events: `webhook.intake.rejected` (403, reason only), `webhook.intake.invalid` (400, code), `webhook.intake.ignored` (200 no text), `worker.message.rejected`, `worker.queue.job_failed`.
Context is passed explicitly via child loggers (no shared mutable/global context), so concurrent jobs cannot leak into each other.

## Safety
Structured JSON lines with built-in redaction (`packages/shared/src/structuredLog.ts`): values under keys matching secret/token/authorization/password/api key/cookie/credential/raw/text/payload/body/content are masked; strings are truncated (200); arrays/depth bounded; Error objects log only their class name; error MESSAGES are never logged (they can embed row values) - only `errorCode` (`code` field if well-formed, else `UNEXPECTED_ERROR`) and `errorName`. The webhook secret, bearer/authorization headers, raw bodies and message text are never logged (tested with canary values). The ingestion-failure error thrown to BullMQ no longer embeds the underlying error text (it stays in the `jobs` table); it carries code `INGESTION_FAILED`.

## Legacy and duplicate handling
- Jobs queued before this change (no `correlation`) or with malformed metadata are processed normally; the worker generates an id and logs `correlationOrigin: "worker-generated"`.
- A duplicate webhook request whose job already exists is detected by comparing the stored job's correlation id with the request's (best effort, one extra `getJob`): `webhook.enqueue.deduplicated` logs this request's ids plus `existingJobCorrelationId` / `existingJobRequestId`. This request's ids do NOT become the job's context.

## Limits (be explicit)
- Log lines from the API and the worker are not strictly ordered relative to each other (the worker can start the job before the API logs the enqueue result; observed in a real run). Order is guaranteed only within a process; use `ts`, `attempt` and event names.
- Duplicate linkage exists only in the API log of the duplicate request; if the stored job is a legacy job, its correlation id is unknown. If `getJob` fails the duplicate cannot be classified (logged as `webhook.enqueue.link_lookup_failed`, then reported as succeeded).
- Two near-simultaneous duplicate requests racing before either job is visible may both log `enqueue.succeeded`; BullMQ still keeps one job (business dedupe is by job id, not logs).
- Worker lines for attempts that crash the process (worker crash) cannot log a failure event; not tested here.
- Market-bars jobs and the scheduler still use the old unstructured logs (outside this ingestion-pipeline scope).
- No log shipping, retention or alerting was added; output is JSON lines on the process console.

## Additional explicit limitations (owner-reviewed)
- `webhook.enqueue.succeeded` does NOT prove that a NEW job was created: `queue.add` with an existing jobId returns without creating one, and the duplicate lookup that would reveal this can fail.
- Duplicate linkage may be unknown whenever the post-enqueue `getJob` lookup fails or the stored job is a legacy job.
- Console-log redaction does not cover the FULL error text that is retained in the `jobs` table (`jobs.error`, written by the ingestion job runner) and in BullMQ `failedReason` for non-ingestion errors.

## Separate security item (open): database/diagnostic access and retention
Full error text in `jobs.error` (and any equivalent diagnostic store) can embed row values or provider fragments. Decide and document: who may read it, retention period, and whether it needs redaction/truncation at write time or restricted database roles. Not addressed by this logging work.
