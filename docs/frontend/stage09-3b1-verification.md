# Stage 09.3B.1 — Contracts and real-output verification

Status: **IMPLEMENTED LOCALLY. NOT COMMITTED. HOSTED CI NOT RUN.** Baseline `2d56130`. Tests and browser-safe contracts only: no UI, endpoint, backend logic, migration, auth or permission change.

## Evidence method
`tests/integration/api-contracts/realOutputShapes.test.ts` (13 tests, real PostgreSQL, synthetic data) runs the REAL research orchestrator, decision engine and cycle, paper execution, outcome ingestion, snapshot and learning cycle, and reads everything back through the REAL session routes. Contract key lists in `packages/api-contracts` must equal the output exactly (nothing undeclared, nothing missing). Mutation checks: dropping an explanation key, dropping a metrics key, and changing a permission row during analytics reads each made the matching test fail.

## Verified (against real output)
| Area | Verified |
|---|---|
| Research package | envelope; package body (19 required keys, optional `asOf`, `optionsRisk`); agent report keys; role coverage; contradictions; `grantsApproval:false`; verdict vocabulary equals backend `SPEC_VERDICTS`; unavailable agents are `INCOMPLETE` with an error code |
| Decision | 17 view keys; `explanation` = engine explanation **plus** `reasons`, `restrictions`, `whatWouldChange`, `provenance` (**corrects the 09.3B.0 audit**, which said the rationale was not exposed); `permittedSize` money as strings; events; approval; approvals list items |
| Comparables | route envelope and the NOT_AVAILABLE shape through the route; the AVAILABLE shape through the real function; `patterns` are strings |
| Analytics | envelope on all 9 section routes + outcomes + insights; snapshot metadata; data keys of every section; `PerformanceMetrics` (28 keys), every metric has `value`, `n`, `definition`; money exact strings; `maxDrawdownPct` always NOT_AVAILABLE; `validatedOnly.eligible` 0 for fixture data; calibration UNCALIBRATED; dataset and dimension narrowing |
| Insights | API returns none until the learning cycle runs; rows match `INSIGHT_ROW_KEYS`; `recommendation` is null or `REVIEW`; reliability never ADEQUATE on fixture data |
| Stale / partial | PARTIAL attribution gives state PARTIAL; an analysis fault serves the newest snapshot as STALE with the reason |

## Still UNVERIFIED (kept `unknown` or `string`)
Research assessment and role vocabularies; `optionsRisk`; non-VALID stop-loss validation fields beyond the four typed ones; decision **outcome** vocabulary (deliberately not mirrored); inner rows of sections empty in the test data (channels list, `byOpportunityType`, `notExecuted`); insight `provenance`, `metrics`, `evidenceRefs`; populated drift reports beyond the keys listed; any numeric value.

## A. Analytics GET side effects — DECISION: keep unchanged (approved)
**Behaviour (source read, `packages/outcomes/src/snapshot.ts` `currentAnalytics`, `apps/api/src/userOps.ts`):** every `GET /analytics/*` (the 9 section routes, outcomes, insights) calls `currentAnalytics`. It computes the hashes of the user's current evidence and looks for a stored snapshot with the same evidence hash. If one exists and either its input hash is identical or it is not older than `snapshotMaxAgeSeconds`, it is served (CURRENT) and **nothing is written**. Otherwise `captureSnapshot` builds the report from one consistent read-only transaction and **inserts one `analytics_snapshots` row** (`createdBy:"API"`, mode PAPER). If the rebuild fails, the newest stored snapshot is served as STALE and nothing is written.

**Trigger conditions:** no snapshot for the current evidence, or the matching snapshot is older than the maximum age and the input hash changed (for example the pipeline counts).

**Idempotency and concurrency:**
- The insert is `ON CONFLICT (user_id, input_hash) DO NOTHING` and takes a per-(user, input hash) advisory lock, so identical inputs yield one row (source read).
- The existing integration test `stage08Snapshots.test.ts` ("eight concurrent requests for the same evidence create exactly one snapshot", and the concurrent first-build case) passed in this stage's full local integration run.
- The rows are append-only and immutable (database triggers; proved here by a rejected UPDATE).

**Evidence from this stage (real Postgres):** first GET took the user's snapshot count 0 → 1; ten further GETs across all sections left it at 1; new evidence (a second closed trade plus ingestion) then added exactly one more (2); learning-insight rows stayed 0 and the attribution count stayed 1 throughout; every row was `createdBy:"API"`, mode PAPER. The "governing tables unchanged" test (section C) also holds while analytics are read.

**What it cannot do:** it writes no policy, capital, decision, order, position, permission, control, insight or attribution row, and calls no provider.

**UNVERIFIED:**
- That no audit-event row is written (inferred from source: neither `currentAnalytics` nor `insertSnapshot` references audit; no test counted audit rows, which other tests also write concurrently).
- Concurrency through the HTTP layer specifically (the existing concurrency tests drive `currentAnalytics` directly).
- Snapshot table growth and retention over time (no retention policy was inspected).
- Behaviour under a read-replica or read-only database (not exercised).
- Frontend implication to handle in 09.3B.2: a first request can be slower (it builds a snapshot), and a viewing session can cause one stored row; the UI must not poll analytics aggressively.

## B. Cross-user isolation over HTTP
Two traders each with a closed paper trade, plus an ADMIN session. Trader B gets 404 on A's decision, comparables, capital, risk policy and portfolio, and 404 on watching A's decision (no bookmark row created); B's lists, approvals, orders, positions and all 11 analytics responses contain none of A's decision, account, user, order or position ids or symbol. ADMIN gets 404 on every private route. Shared research is readable by B by design and carries no private id. The existing `userRoutes.test.ts` (real RLS) is unchanged and still passes.

## C. Review-only evidence
No POST/PUT/PATCH/DELETE route exists under `/analytics` (404/405). Reading all analytics endpoints and running the learning cycle leaves every user-scoped table outside outcome/analytics/learning/calibration/audit byte-identical (policy, capital, decisions, permissions, controls, orders, positions). Stored insights cannot be edited (append-only trigger). The only recommendation value is `REVIEW`.

## Local environment note
The full local integration run (Postgres 16 and Redis 7 in throwaway containers, CI settings) gave 1,160 passed, 15 skipped and **1 failed**: `tests/integration/backup/offhostBackup.test.ts`. The failure is environmental: this machine has no `pg_dump`/`pg_restore`, which the backup test needs. The CI workflow installs `postgresql-client` before the integration step. The test was not skipped or weakened; its result here is unknown until hosted CI runs it.

## Files
New: `packages/api-contracts/src/{research,decisions,learning}.ts`, `tests/integration/api-contracts/realOutputShapes.test.ts`, `tests/unit/api-contracts/verified093b.test.ts`, `frontend/src/bff/schemas.verified093b.{ts,test.ts}`, this file. Edited: `packages/api-contracts/src/{index,analytics}.ts` (export; `algorithmVersions` tightened to a string map), `docs/frontend/contracts-verification.md`.
