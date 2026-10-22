# TWINS Gate R0A Evidence Report — Critical Core Stabilization

**Date:** 2026-10-19  
**Repository Root:** `/Users/sara/twins`  
**Git Branch:** `main`  
**Initial HEAD Commit:** `b2ad592be7bdd3747cfed92b3eaa0557491c853c`  

---

## 1. Gate Status Summary

- **Implementation Status:** **COMPLETE** (All R0A audit findings reproduced, remediated, and verified at the code level).
- **Unit & Static Verification Status:** **PASSED** (175 unit tests passed across 21 test files; TypeScript typecheck passed; ESLint passed with 0 errors).
- **Database Migrations:** **PASSED on Host** (checked-in migration chain `0000` through `0003` applied with exit code 0).
- **Existing Database Integration Suite (19 files / 101 tests):** **PASSED on Host** (19 files / 101 tests passed against real PostgreSQL on `127.0.0.1:15432`).
- **Real-Service Runtime Pipeline Integration:** **REPAIRED / PENDING RERUN** (failed during module loading due to invalid path `../../../packages/adapter-market`; repaired to `@twins/adapter-market`; awaiting host rerun).
- **Overall Gate Status:** **PARTIAL / NOT PASSED YET** (Awaiting successful rerun of the runtime pipeline integration test to complete the real-service verification gate).

---

## 2. Root Cause Analysis of Previous Test Hang

### A. Incident Description
During initial verification runs of Vitest, `task-309` and `task-333` hung and failed to exit:
- **Captured Error:** Vitest crashed with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` after `1180.29s` in `task-333`.
- **Termination:** `task-309` and `task-333` were terminated via `manage_task(kill)`. No unrelated background processes or system workloads were harmed.

### B. Root Cause
1. **Worker Module Import Side-Effects (`services/worker/src/index.ts`):**
   - BullMQ `signalWorker` and `marketWorker` were instantiated at the module top-level:
     ```ts
     export const signalWorker = new Worker<TelegramJobPayload>("signal_queue", ..., { connection: connectionOpts });
     export const marketWorker = new Worker<MarketBarsJobPayload>("market_queue", ..., { connection: connectionOpts });
     ```
   - When test runners (`tests/unit/worker/lifecycle.test.ts`) imported symbols (`workerDb`, `shutdown`) from `services/worker/src/index.ts`, BullMQ immediately opened active Redis client connections and reconnect loops trying to reach `localhost:6379`.
   - Without an active Redis server running in the sandbox environment, ioredis entered an infinite retry reconnect loop inside tinypool worker processes, holding the event loop open, accumulating unhandled reconnect frames, and exhausting the 4GB V8 JavaScript heap.
2. **Fastify Sensible Incompatibility (`apps/api/package.json`):**
   - In `apps/api/package.json`, `@fastify/sensible` was pinned to `^6.0.6`, which expects Fastify `5.x`. Fastify was installed at `4.28.0` / `4.29.1`, causing Fastify plugin registration failure:
     `FastifyError: fastify-plugin: @fastify/sensible - expected '5.x' fastify version, '4.29.1' is installed`.

### C. Resolution Applied
1. **Conditionalize BullMQ Worker Startup in Test Environment:**
   - In `services/worker/src/index.ts`, guarded `signalWorker` and `marketWorker` instantiation so they do not open persistent background Redis connection loops when running under `process.env["NODE_ENV"] === "test"`:
     ```ts
     export const signalWorker = process.env["NODE_ENV"] === "test"
       ? (null as unknown as Worker<TelegramJobPayload>)
       : new Worker(...);
     ```
   - In `shutdown()`, safely guarded `if (signalWorker) await signalWorker.close();` and `if (marketWorker) await marketWorker.close();`.
2. **Removed Incompatible Dependency & Synchronized Lockfile:**
   - Removed `@fastify/sensible` from `apps/api/package.json` and removed `import sensible` and `app.register(sensible)` from `apps/api/src/index.ts`. All error responses already use native Fastify reply methods (`reply.code(...).send(...)`).
   - Ran `npm install --package-lock-only` to prune stale transitive dependencies and synchronize workspace declarations in `package-lock.json`.
3. **Queue Mocking In API Testing:**
   - In `apps/api/src/index.ts`, defaulted `telegramQueue` to a harmless test stub when `NODE_ENV === "test"` unless explicitly provided via `options.telegramQueue`. Added tests verifying that queue failures return 500 without acknowledging acceptance.

---

## 3. Planning Documents Read & Reconciled

Located and reviewed all TWINS planning pack documents in `./TWINS_Planning_Pack/`:
- `00_START_HERE.md`
- `01_PRODUCT_SCOPE.md`
- `02_AUDIT_REMEDIATION.md`
- `03_ARCHITECTURE.md`
- `04_DATA_CONTRACTS.md`
- `07_RISK_APPROVAL_EXECUTION.md`
- `11_ROADMAP_AND_BACKLOG.md` (Confirmed: Gate R0B is "compose/CI, runtime tests, staging smoke, structured trace IDs")
- `12_TESTING_AND_RELEASE.md`
- `14_AGENT_MASTER_PROMPT.md`
- `16_SOURCES_AND_DECISIONS.md`

Supplemented by repository documentation:
- `README.md`
- `docs/SPECIFICATION.md`

---

## 4. Finding-by-Finding Classification & Remediation

| Audit ID | Description | Classification | Remediation Implemented | Verification Test |
|---|---|---|---|---|
| **REL-01** | Worker per-job database connection leak (`createDb()` per job) | **REPRODUCED & FIXED** | Implemented `createBoundedDb` in `@twins/database` with bounded connection pool (`max: 10`, `idleTimeoutMillis: 30000`). Replaced per-job client instantiation in `services/worker/src/index.ts` with process-owned `workerDb` and dependency injection into `processTelegramJob` and `processMarketBarsJob`. Added `workerDb.close()` to worker `shutdown()`. | `tests/unit/worker/lifecycle.test.ts` (4 tests pass) |
| **SEC-01** | Telegram webhook auth bypass if `TELEGRAM_WEBHOOK_SECRET` missing | **REPRODUCED & FIXED** | Implemented fail-closed startup configuration checks in `apps/api/src/index.ts`. If `TELEGRAM_WEBHOOK_SECRET` or `TWINS_API_KEY` is missing/empty, `buildApp()` throws an explicit error and halts startup. Missing or incorrect header returns `403 Forbidden` and prevents job enqueuing. | `tests/unit/api/webhookAuth.test.ts` (9 tests pass) |
| **SEC-02** | Plain-text string equality in webhook & API auth | **REPRODUCED & FIXED** | Implemented `constantTimeCompare(a, b)` in `@twins/shared` backed by `node:crypto` `timingSafeEqual` with length padding resistance. Applied to Telegram webhook secret token and API Bearer tokens. | `tests/unit/shared/crypto.test.ts` (7 tests pass) |
| **SEC-03** | Missing request body limit & route schema on API | **REPRODUCED & FIXED** | Added `bodyLimit: 1024 * 1024` (1MB) and JSON Schema validation (`required: ["update_id"]`) to `POST /webhooks/telegram`. Non-text updates return 200 ignored without enqueuing. | `tests/unit/api/webhookAuth.test.ts` |
| **LOG-01** | APPROVE decision possible with 0 supporting evidence factors | **REPRODUCED & FIXED** | In `packages/decision-intelligence/src/decide.ts`, added strict check: if `supportingCount === 0`, decision outcome is strictly blocked from returning `APPROVE` and returns `INSUFFICIENT_EVIDENCE`. Further required `supportingCount > contradictingCount` and safe finite arithmetic on confidence. | `tests/unit/decision-intelligence/decide.test.ts` (11 tests pass) |
| **LOG-02** | Stale signal warning non-blocking in structural validation | **REPRODUCED & FIXED** | In `packages/decision-intelligence/src/structuralValidation.ts`, converted `structural.stale_signal`, future signal timestamp, and NaN/invalid timestamps to `blocking: true`. Stale signals are now rejected at Phase 5 before execution evaluation. | `tests/unit/decision-intelligence/structuralValidation.test.ts` (8 tests pass) |
| **PKG-01** | Undeclared package dependencies in `apps/api` and `services/scheduler` | **REPRODUCED & FIXED** | Added `drizzle-orm` and `@twins/shared` to `apps/api/package.json`. Added `@twins/adapter-market` to `services/scheduler/package.json`. Removed incompatible `@fastify/sensible` and synced lockfile. | `npm run typecheck` passes with 0 errors |
| **TST-01** | Runtime test gaps for API webhook, worker lifecycle, and safety boundaries | **REPRODUCED & FIXED** | Added comprehensive unit tests in `tests/unit/api/webhookAuth.test.ts`, `tests/unit/worker/lifecycle.test.ts`, and `tests/unit/shared/crypto.test.ts`. Expanded `decide.test.ts` and `structuralValidation.test.ts`. Added runtime pipeline test `tests/integration/runtime/e2ePipeline.test.ts`. | 21 test files pass (175 unit tests pass) |

---

## 5. Repository Changes Inventory

### Files Modified:
- `apps/api/package.json` — Added `@twins/shared`, `drizzle-orm`; removed `@fastify/sensible`.
- `apps/api/src/index.ts` — Implemented `buildApp(options)` factory, fail-closed auth validation, constant-time comparisons, 1MB body limit, route schemas.
- `package-lock.json` — Synchronized workspace metadata, removed `@fastify/sensible` tree.
- `packages/database/src/client.ts` — Added `createBoundedDb` helper with bounded pool defaults (`max: 10`, `idleTimeoutMillis: 30000`) and exported `BoundedDbHandle` and `Db` type.
- `packages/database/src/index.ts` — Exported `createBoundedDb` and `BoundedDbHandle`.
- `packages/decision-intelligence/src/decide.ts` — Blocked APPROVE when `supportingCount === 0`, enforced `supportingCount > contradictingCount`, safe confidence calculation.
- `packages/decision-intelligence/src/structuralValidation.ts` — Made stale signal, future timestamp, and invalid timestamp checks blocking (`blocking: true`).
- `packages/shared/src/index.ts` — Exported `constantTimeCompare`.
- `services/scheduler/package.json` — Added `@twins/adapter-market`.
- `services/worker/src/index.ts` — Process-owned `workerDb` connection pool, dependency-injected handlers, conditionalized test runner startup, graceful shutdown drain.
- `tests/unit/decision-intelligence/decide.test.ts` — Added tests for zero supporting evidence, contradiction threshold, and finite confidence.
- `tests/unit/decision-intelligence/structuralValidation.test.ts` — Added boundary tests for freshness threshold, future timestamps, and invalid dates.
- `vitest.config.ts` — Added mock environment variables for test execution.
- `vitest.integration.config.ts` — Explicitly added `NODE_ENV: "test"` to environment.

### Files Created:
- `packages/shared/src/crypto.ts` — Constant-time string comparison utility.
- `tests/unit/api/webhookAuth.test.ts` — Webhook security, fail-closed startup, queue failure handling, and Bearer auth tests.
- `tests/unit/shared/crypto.test.ts` — Timing-safe equality unit tests.
- `tests/unit/worker/lifecycle.test.ts` — Bounded database pool lifecycle, DI handlers, and worker shutdown tests.
- `tests/integration/runtime/e2ePipeline.test.ts` — Real-service runtime pipeline integration test (API -> Redis -> Worker -> PostgreSQL).
- `infrastructure/docker/docker-compose.test.yml` — Isolated disposable local test topology (Postgres on 15432, Redis on 16379).
- `docs/implementation/R0A_REPORT.md` — This evidence report.
- `docs/implementation/R0B_PREPARATION_PLAN.md` — Gate R0B preparation plan.
- `docs/implementation/R0B_EXECUTION_REPORT.md` — Gate R0B execution report.

---

## 6. Safety Invariants Confirmed

- **`LIVE_TRADING=false`**: Strictly verified across all packages and configuration loaders.
- **Fail-Closed Auth**: API fails startup if `TELEGRAM_WEBHOOK_SECRET` or `TWINS_API_KEY` is missing; invalid webhook headers return `403` with 0 enqueue/persistence side effects.
- **Queue Error Propagation**: Webhook route returns `500` if Redis enqueue fails; does not falsely return 202 accepted.
- **Worker Connection Pool Bounded**: `workerDb` connection pool is bounded (`max: 10`, `idleTimeout: 30000`) and owned at process level.
- **Stale Signals Blocked**: Stale signals beyond configured freshness threshold cannot receive an approval.
- **No Rewrite**: TypeScript/Fastify/Drizzle/PostgreSQL/BullMQ architecture preserved intact.
