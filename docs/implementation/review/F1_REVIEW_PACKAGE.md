# F1 review package - R0A-era product code (for an INDEPENDENT reviewer)

**Status: NOT independently reviewed.** Prepared by the implementing agent; an agent self-review or self-remediation is not independent review. F1 stays open until a person or separate reviewer examines the CURRENT code (the `f1/*.diff` files were regenerated after the remediation below) and records findings. Nothing was sent to any external service.

## Remediation applied 2026-10-19 (by the implementing agent; to be reviewed, not self-certified)
| # | Change | Where | Tests |
|---|---|---|---|
| R1 | **Removed the `NODE_ENV === "test"` queue stub.** Queue selection is explicit: injected `telegramQueue` (unit: clearly test-owned fake; integration: real queue) or, when omitted, a REAL owned BullMQ queue from `REDIS_URL`. With an unreachable real Redis a valid webhook is never acknowledged (observed: the request stays pending, see tracked item T6) | `apps/api/src/index.ts` | `webhookBoundary.test.ts` (queue selection), `webhookAuth.test.ts` (health/auth tests now inject a fake) |
| R2 | **Secret verified in an `onRequest` hook, before body read/parse** (Fastify v4 order: onRequest -> preParsing -> parsing -> validation -> handler). Handler re-checks as defence in depth. Fail-closed startup config unchanged; 1 MB body limit preserved for authenticated requests | `apps/api/src/index.ts` | `webhookBoundary.test.ts` (403 for missing/wrong secret even with malformed/poisoned/oversize bodies, no enqueue) |
| R3 | **Body fragments kept out of every log path**: stock JSON parser wrapped (keeps prototype/constructor-poisoning rejection) with a fixed error message; one app-wide error handler logging only status/code/class name (never `error.message`) and answering 5xx generically; file comments corrected | `apps/api/src/index.ts` | canary tests capture BOTH Fastify pino output and the structured event log: no canary from malformed/poisoned/oversize bodies, wrong secret values, or queue-error messages appears in any log or response |
| R4 | **Non-finite confidence no longer becomes 1**: a high-severity REJECT with a non-finite counter-thesis confidence keeps the REJECT, stores placeholder 0, sets `confidenceUnavailable`, and states "UNAVAILABLE" in `confidenceLabel` and rationale (schema unchanged; persisted via the label text). The producer actually yields only finite values (`0` or `min(1, 0.3+0.2n)`), so this path is defensive | `decide.ts`, `types.ts` | `decideConfidenceSafety.test.ts` (4) |
| R5 | **Historical age vs executable freshness separated in documentation**: the 30-day default is an ingestion/analysis horizon, not an execution policy; no new threshold introduced | `structuralValidation.ts`, `decide.ts` comments | existing `structuralValidation.test.ts` (unchanged behaviour) |
| R6 | **T1 pool errors:** process-owned `error` listener on every pool the module creates (safe code + class only, never throws, no pool replacement, queries still reject); recovery policy documented | `packages/database/src/client.ts` | `tests/unit/database/poolErrorHandler.test.ts` (7, synthetic events - not an outage drill) |
| R7 | **T6 bounded producer:** configurable bound (default 3000 ms, 250-30000), readiness wait for the owned Redis, generic 503 for confirmed/unconfirmed/unknown submissions, late-completion logging, bounded duplicate lookup and bounded shutdown; deterministic job id preserved; worker retry policy untouched | `apps/api/src/index.ts` | `tests/unit/api/webhookEnqueueBound.test.ts` (21), `webhookBoundary.test.ts`, integration `enqueueBounded.test.ts` (real ioredis/BullMQ through a test-owned cut-and-restore forwarder - not an outage drill). Details: `T1_T6_POOL_AND_PRODUCER_POLICY.md` |
**Not a finding by itself:** a 400 for an unauthenticated malformed body (pre-remediation) was a lifecycle-order and information-exposure issue; no unauthenticated request was ever enqueued (verified by probe), so it was not an authentication bypass.
**Unresolved product decisions (execution stays blocked on them):** (a) the executable-freshness policy (intraday window, session boundaries, market-data age) does not exist - APPROVE means "evidence sufficient for analysis" only and nothing may execute on it; (b) future-timestamp clock-skew tolerance (currently none -> fail-closed REJECT).

## Tracked items - NOT remediated here, ranked by relevance (not equally severe)
| ID | Item | Threat / operational relevance | Rank | Smallest eventual step |
|---|---|---|---|---|
| T1 | **[addressed by R6, agent self-implemented; reviewer to verify]** No `pool.on("error")` handler (`packages/database/src/client.ts`) | A Postgres restart/failover/network reset makes idle clients emit `error`; an unhandled pool `error` event can terminate the process. Availability, hits exactly the outage scenarios planned for R4 | **Medium, before staging** | log safe code and let the pool reconnect |
| T6 | **[addressed by R7, agent self-implemented; reviewer to verify]** Enqueue blocked indefinitely when Redis is unreachable (observed: webhook request pending, no 5xx) | No false acceptance, but connections pile up during a Redis outage and Telegram retries later; availability | **Medium, with outage testing** | bounded enqueue deadline -> 503 |
| T5 | No API rate limiting (bearer routes) | Unauthenticated webhook floods are now rejected cheaply at `onRequest`; the remaining exposure is bearer brute-force/flood on operator routes if the API is publicly reachable (may be handled by the reverse proxy) | Medium if public, otherwise Low | decide where it is enforced |
| T2 | `shutdown()` has no timeout | `pool.end()` waits for in-flight queries; a stuck query delays exit until the orchestrator SIGKILLs. Operational | Low-Medium | bounded wait, then forced exit |
| T3 | `/health` unauthenticated and returns `appEnv`, `tradingMode`, `liveTradingEnabled` | Fingerprinting aid for anyone who can reach the port; also useful operator reassurance | Low | reduce to `{status}` or keep behind the network boundary |
| T7 | Pino request logging default is `false` when `NODE_ENV=test` | A mis-set variable would silently remove request logs (observability only) | Low | explicit option instead of env |
| T4 | `constantTimeCompare` returns early on unequal length | Reveals only the secret's length via timing; negligible for a high-entropy random secret | Low | compare fixed-length HMACs |
Other reviewer questions from the original package (pool `max`/timeouts, `createBoundedDb` loading config, legacy `createDb` pool) remain open and unranked.

---
How to read: `git diff HEAD -- <path>` equals the supplied `.diff` files (HEAD = `b2ad592`, nothing of R0A/R0B is committed). Code of R0A origin vs later R0B additions is mixed in two files; attribution below comes from `docs/implementation/R0A_REPORT.md` (a historical claim, not proof) and from the diff itself. Tests listed are the ones that exercise the area; all passed in the last run (`vitest run tests/unit/api tests/unit/shared tests/unit/decision-intelligence tests/unit/worker/lifecycle.test.ts`: 10 files, 69 tests).

## 1. API webhook / auth - `apps/api/src/index.ts` (`f1/api_webhook_auth.diff`)
Mixed file: R0A = fail-closed config, constant-time secret and bearer checks, enqueue shape, owned queue/redis, test-queue stub, `/signals/:id/validation`; R0B (mine, later) = `structuredLogger`, `requestIdHeader:false` + `genReqId`, correlation metadata, duplicate-job lookup, enqueue/duplicate events.
**Intended invariants (as documented in the file header):** startup fails if `TWINS_API_KEY` or `TELEGRAM_WEBHOOK_SECRET` is missing; a missing/wrong secret never enqueues and returns 403; secret and bearer comparisons are constant time; failed enqueue returns 5xx and is not acknowledged; operator routes need the bearer token; `/health` is unauthenticated.
**Tests:** `tests/unit/api/webhookAuth.test.ts` (9: startup fail-closed x2, missing/incorrect secret 403 + no enqueue, valid 202, non-text 200, enqueue failure 500, bearer protection, unauthenticated health), `tests/unit/api/webhookCorrelation.test.ts` (7), integration `tests/integration/runtime/{e2ePipeline,failureHandling}.test.ts`.
**Observed by probe BEFORE the remediation (in-process app, mock queue, 2026-10-19):**
| Request | Result |
|---|---|
| no / wrong secret, valid body | 403, no enqueue |
| **no secret, schema-invalid body** | **400** (`FST_ERR_VALIDATION`) |
| **no secret, malformed JSON** | **400**; the error message echoes a fragment of the body, and **one server log line contains that fragment** |
| correct secret, schema-invalid body | 400 |
| correct secret, valid body | 202, 1 enqueue |
| no secret, > 1 MB body | 413 (limit works) |
| `GET /health`, no auth | 200 `{status, service, appEnv, tradingMode, liveTradingEnabled}` |
| `GET /signals/:id/validation`, no auth | 401 |
**Reviewer questions / known limitations (all observed in code or probe):**
1. **[addressed by R2; reviewer to verify]** The header said secret verification happens "before parsing body", but Fastify parses and schema-validates the body BEFORE the handler runs, so the check is after parsing. Unauthenticated callers can therefore (a) distinguish 400 from 403 and (b) cause body parsing up to the 1 MB limit. Is moving the check to an `onRequest`/`preParsing` hook required?
2. **[addressed by R3; reviewer to verify]** Malformed-JSON error text (included a body fragment) is written to the Fastify server log: for authenticated Telegram requests that could be message text. Belongs to the diagnostic-data item.
3. **[addressed by R1; reviewer to verify]** `NODE_ENV === "test"` replaced the real queue with a stub that returns a fake job: if that variable were ever set in a deployed environment the webhook would answer 202 and silently drop messages. Should this be an explicit option only?
4. `/health` exposes `appEnv`, `tradingMode`, `liveTradingEnabled` without auth. Intended?
5. No rate limiting seen (your test matrix lists it); not verified elsewhere.
6. Bearer auth is one static key shared by all operator routes; no rotation/scoping (documented as single-operator).

## 2. Shared crypto helper - `packages/shared/src/crypto.ts` (untracked; `f1/shared_crypto.diff`)
**Invariant:** `constantTimeCompare(a,b)` returns true only for two non-empty strings with identical UTF-8 bytes; returns false (never throws) for undefined/null/non-string/empty; uses `crypto.timingSafeEqual` when lengths match.
**Tests:** `tests/unit/shared/crypto.test.ts` (7: ASCII, UTF-8 multibyte, different same-length, different length, null/undefined, empty, non-string).
**Reviewer notes:** unequal lengths return early, so secret length is observable via timing (common and usually accepted; a reviewer may prefer comparing fixed-length HMACs); two empty strings compare false (fail-closed, deliberate); no test asserts constant-time behaviour itself (not practical in a unit test).

## 3. Database pool lifecycle - `packages/database/src/{client,index}.ts` (`f1/db_pool_lifecycle.diff`) and `services/worker/src/index.ts` (`f1/worker_index_full_MIXED.diff`, MIXED with idempotency/correlation: read only the `workerDb`/`shutdown` parts)
**Invariants:** `createBoundedDb` returns a process-owned pool with explicit `max` (default 10) and `idleTimeoutMillis` (default 30000) and a `close()` that ends the pool; worker module creates exactly one such pool (`workerDb`) and `shutdown()` closes workers, Redis clients and the pool before exit; importing the worker module under `NODE_ENV=test` opens no BullMQ workers.
**Tests:** `tests/unit/worker/lifecycle.test.ts` (4: bounded options, isolated handles with working `close()`, `shutdown` exists, jobs accept an injected db), integration harnesses close every handle they open (`harness.ts`).
**Reviewer questions (read from code; not tested):**
1. No `pool.on("error", ...)` handler exists: an error on an idle client can surface as an unhandled `error` event on the pool and terminate the process.
2. `createBoundedDb` calls `loadConfig()` even when given an explicit URL, so it throws when `REDIS_URL`/`DATABASE_URL` are unset; the coupling may surprise scripts.
3. `createDb(string)` still creates an unmanaged pool with no close path (legacy).
4. `shutdown()` has no timeout (`pool.end()` waits for checked-out clients) and exits 0 even if a close failed.
5. No query/statement timeout is configured on the pool.

## 4. Decision and structural-validation guards - `packages/decision-intelligence/src/{decide,structuralValidation}.ts` (`f1/decision_guards.diff`; R0B idempotency changes to `engine.ts`/`persist.ts` are separate: `f1/decision_engine_persist_R0B_idempotency.diff`)
**Intended invariants (R0A LOG-01/LOG-02 per the code comments):** blocking structural issues (unresolved instrument, invalid direction, invalid timestamp, future timestamp, stale beyond `maxSignalAgeMs`) -> REJECT before evidence; high-severity counter-thesis -> REJECT; no APPROVE without supporting evidence; contradicting >= supporting -> INSUFFICIENT_EVIDENCE; non-finite or zero-denominator confidence is clamped to [0,1]; confidence is a decision confidence, never a probability of profit.
**Tests:** `decide.test.ts` (11: approve path, absent supporting evidence -> INSUFFICIENT (LOG-01), contradiction >= support, zero/NaN denominators, blocking structure, stale (LOG-02), high counter-thesis, no-evidence, no profit claim, source reliability UNKNOWN, confidence in [0,1]), `structuralValidation.test.ts` (8: pass, unresolved instrument, invalid direction, future, NaN timestamp, stale, exact staleness boundary, bare signal non-blocking).
**Reviewer questions / known limitations:**
1. **[documented by R5; policy decision still open]** Default `maxSignalAgeMs` is **30 days** (`structuralValidation.ts:9`): a month-old signal is not "stale" by default; is that acceptable for trading signals?
2. Future timestamps are blocking with **no clock-skew tolerance**: a few seconds of skew between Telegram `date` (or `edit_date`) and the server clock rejects the signal.
3. **[addressed by R4; reviewer to verify]** In `decide.ts`, a high-severity counter-thesis with a non-finite `confidence` was clamped to **1** (maximum), not to a neutral value; confirm intent.
4. The `evidenceDomainsPresent` / `supportingCount` rules depend on factor counts, not factor weights; thin evidence can pass if one supporting factor outweighs zero opposition. Policy question, not a defect.
5. Evidence references used in theses come from the gathered contexts, not from the `signal_evidence` link table (see F2 analysis), so link duplication does not alter any decision.

## 5. Review protocol
Reviewer should record: name/date, files and commits examined, findings with severity, and explicit accept/changes-requested per area. Only after that may this package be labelled "independently reviewed". Suggested order: API (section 1) -> database lifecycle (3) -> decision guards (4) -> crypto (2).
