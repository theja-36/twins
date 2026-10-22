# T1 pool-error handling and T6 bounded HTTP producer - implemented behaviour and limits

Self-implemented by the implementing agent; **not an independent review**. Controlled-dependency tests only: nothing here is a PostgreSQL or Redis outage drill, no container was stopped or created.

## T1 - pool errors (`packages/database/src/client.ts`)
**Ownership found:** three pool creation sites, all in `client.ts`: the shared singleton (`getPool()/getDb()`, used by the API; closed by `closeDb()`), `createDb(string)` (scripts/migrations; no close path, legacy), and `createBoundedDb()` (worker and tests; explicit `close()`).
**Change:** `attachPoolErrorHandler(pool, label, sink?)` is applied once to every pool the module creates (and to a caller-supplied pool only if it has no `error` listener). On a pool-level `error` it records a diagnostic `{pool, errorCode, errorName, errorCount}` and updates cumulative `poolErrors` stats on the bounded handle. It never throws (sink failures are swallowed), never logs the error message or payload (code only, validated `^[A-Za-z0-9_]{1,24}$`, else `UNEXPECTED_ERROR`), never replaces or ends the pool, and never touches a query's result.
**Why:** `pg` emits `error` on the pool when an idle client fails; with no listener the emitter throws (shown in a test) and can terminate the process.
**Supported recovery policy (what the code does, nothing more):** the failed idle client is discarded by `pg`; the same pool keeps serving; the next query opens a fresh connection; if the database is still down that query rejects to its caller (shown: queries still reject after an event). No circuit breaker, no automatic pool rebuild, no health/readiness flag, no process exit - restart decisions stay with the orchestrator. Errors on a checked-out client surface through that query.
**Not claimed:** recovery from a real PostgreSQL restart/failover (events were synthetic); readiness gating on pool stats (the stats are diagnostics only); drain/backoff behaviour under sustained outage.

## T6 - bounded producer (`apps/api/src/index.ts`)
**Observed before the change:** Redis never ready -> `queue.add` waited indefinitely (webhook request pending); Redis lost after being healthy -> `maxRetriesPerRequest: 3` made `add` reject quickly (observed 310 ms through a cut network path) -> an unclassified 500.
**Configurable bound:** `TWINS_ENQUEUE_TIMEOUT_MS` / `enqueueTimeoutMs`, **default 3000 ms, allowed 250-30000**, anything else fails startup. Reason: a healthy local/staging enqueue is milliseconds, so 3 s leaves ample headroom for a slow-but-working Redis while staying far below reverse-proxy defaults (tens of seconds) and Telegram's patience, so a dependency problem becomes a prompt 503 that Telegram retries. Not derived from a measured SLA; revisit with staging data. The bound covers the readiness wait + the submission together; the best-effort duplicate lookup after a CONFIRMED submission is capped at min(1000 ms, remaining) and can never turn a confirmed 202 into a failure.
**Startup/readiness policy:** the API does not block startup on Redis or Postgres. Liveness `/health` is unchanged (says nothing about dependencies). There is NO `/ready` endpoint yet (proposed for staging; also relevant to T3). If the owned Redis client is not ready, the webhook waits up to the bound for it; ioredis keeps reconnecting in the background (library backoff, capped at 2 s), so the API recovers by itself when Redis returns (observed through the forwarder test). Redis/queue `error` events are recorded as safe codes at most once per 10 s (`api.redis.error`).
**Request-time semantics:** 202 only after the queue confirmed the submission. Otherwise, with a generic body `{statusCode:503,error:"Service Unavailable",message:"Service Unavailable"}` and no underlying text:
| Situation | HTTP | Knowledge about the job | Log event / `submission` |
|---|---|---|---|
| Redis not ready within the bound | 503 | **confirmed: nothing was submitted** | `webhook.enqueue.unavailable` / `not_attempted` |
| queue call rejected with a connectivity-class error | 503 | **unconfirmed**: the job may or may not exist | `webhook.enqueue.unavailable` / `failed_unconfirmed` |
| bound elapsed while the call was pending | 503 | **unknown**: the call is NOT cancelled and may complete later; the late result is logged (`webhook.enqueue.late_completion`) | `webhook.enqueue.outcome_unknown` / `timed_out_unconfirmed` |
| any other error | 500 (generic, as before) | n/a | `webhook.enqueue.failed` |
A timeout never proves "no job exists". **Safe retry:** the job id is deterministic (`tg-<chat>-<message revision>`) and BullMQ returns the existing job for a repeated id, so a client/Telegram retry cannot create a second job: verified with a fake that has those semantics (timed-out first call completes later; two retries; one job) and with real BullMQ (unique test queue; two retries; exactly one job). Business-level idempotency in the worker/database is independent of this.
**Worker retry policy untouched:** job options remain `attempts: 3`, exponential backoff 1000 ms (asserted); the API producer's `maxRetriesPerRequest: 3` is a connection-level setting of the API only; the worker's connection stays `maxRetriesPerRequest: null`.
**Limits (explicit):**
- The bound covers the enqueue, not the whole request (JSON parsing etc. are separate).
- No circuit breaker: while Redis is down every request waits up to the bound, so concurrent requests hold connections for up to the bound.
- No `Retry-After` header; Telegram's retry behaviour on non-2xx is assumed from its documentation, not tested.
- A real Redis server outage and recovery were not exercised; the integration test only cuts and restores a test-owned TCP path to a healthy Redis, using a unique test queue.
- BullMQ job retention affects dedupe over long horizons: if a completed job were removed from Redis, a much later retry of the same update would create a new job (database idempotency would still prevent duplicate business records).
- The API's own queue name remains the fixed `signal_queue`.
