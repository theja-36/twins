# API contracts

## Conventions (Stage 01, ADR-003/ADR-006)
- **Authentication:** every route except `/health` requires a principal. Today: the shared bearer key (the `system` principal used by the frontend proxy). Target: per-user sessions (opaque token, hash stored) for user routes.
- **Authorisation:** routes call `authorize(principal, permission, ownerId)` from `@twins/types`; private resources are scoped with `ownerScope(principal)`. A foreign private resource answers `404`, never `403`.
- **Errors:** the `PlatformError` taxonomy (`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `VALIDATION` 422, `CONFLICT`/`STALE_DATA` 409, `DEPENDENCY_UNAVAILABLE` 503, `RISK_BLOCKED` 422, `EXECUTION_DISABLED` 403, `INTERNAL` 500). Body: `{ error, message, reasons[] }`. No secret or private value appears in a body.
- **States for every read:** a response distinguishes ok, empty, stale, unavailable and unauthorised; a failed read is never presented as empty.
- **Writes** go through the decision/approval/execution gates; no route can place a live order (`checkExecutionGate`).
- **OpenAPI:** `docs/api/openapi.json` is regenerated from `apps/api/src/openapi.ts` whenever routes change.

## Existing routes (preserved)
See `docs/api/openapi.json` (30 documented routes plus the Telegram webhook and the internal capture ingest).

## Planned contract families (added per stage, each with schemas and tests)
Auth and users · user capital and risk policy · broker connections (per user) · channels (read, then managed) · signals and classifications · evidence · research packages · regimes · playbooks and strategy versions · opportunity candidates · confidence and risk assessments · simulations · decisions and approvals · orders, fills, positions · trade monitoring · analytics and learning versions · notifications · admin and audit.

## Telegram intelligence read API (Stage 03; session-protected, shared data, read-only)
Auth: `Authorization: Bearer tws_...` (user session; the shared service key is refused with 401). Permissions: `channels:read`, `signals:read`, `opportunities:read`, `strategies:read`. Errors: fixed codes (401, 403, 404, 422). Channel identifiers are masked (`***` + last four); raw message text is never returned. Lists accept a bounded `limit` and `offset`; ordering is deterministic.
| Route | Notes |
|---|---|
| `GET /intelligence/channels`, `/channels/:id` | health, counts; reliability always `NOT_AVAILABLE` |
| `GET /intelligence/claims`, `/claims/:id` | parsed fields, classification, candidacy decision with reason codes |
| `GET /intelligence/candidates`, `/pipeline` | candidate state, outcome counts per policy version |
| `GET /intelligence/claims/:id/historical-matches` | as-of the claim's own time; states UNAVAILABLE, NOT_APPLICABLE, INSUFFICIENT_EVIDENCE, NO_COMPARABLE_CASES; association only, not a prediction |
| `GET /intelligence/channels/:id/performance` | funnel counts; `outcomes` and `reliability` `NOT_AVAILABLE` until real outcomes are linked |
| `GET /intelligence/playbooks`, `/playbooks/:id` | versions, audited state events, drift; `limit` <= 200, `offset` <= 100000 |
| `GET /intelligence/archive/channels` | imported-history score tables (not linked to live channels); `limit` <= 100 else 422 |
Tests: `tests/unit/telegramCandidates/{api,historyApi}.test.ts`, `tests/integration/telegram/{stage03,strategyReads}.test.ts`.

## Research read API (Stage 04; session-protected, shared data, read-only)
Same authentication and error codes as the Telegram intelligence read API; permission `research:read`. Packages and the agent registry are shared platform intelligence (no owner).
| Route | Notes |
|---|---|
| `GET /research/candidates/{id}/package` | latest package of a candidate plus the derived status (PENDING, RUNNING, COMPLETED, PARTIAL, FAILED, EXPIRED, SUPERSEDED, CANCELLED); `package: null` and a note when none is stored; 404 for an unknown candidate |
| `GET /research/packages/{id}` | one package by id (the version a risk assessment or decision recorded), with its candidate's status |
| `GET /research/agents` | contract metadata of the thirteen agents, twelve roles, the extra specialist and its supplements, soft dependencies; no model |
A package is `research-package-v1` JSON: reports, contradictions, roleCoverage, missingRequired, agentVersions, evidenceIndex, optional `optionsRisk` (option candidates only), `asOf` (packages stored before 2026-11-10 lack it), `grantsApproval: false`, hashes. Machine description: `docs/api/openapi-session.json`. Tests: `tests/unit/api/researchApi.test.ts`.

## Opportunity read API (Stage 05; session-protected, shared data, read-only)
Same authentication and error codes as the other intelligence read APIs; permission `opportunities:read`. Candidates are proposals for research: no order, approval or size field exists.
| Route | Notes |
|---|---|
| `GET /opportunities/candidates` | both sources (TELEGRAM, INDEPENDENT) always labelled; filters `source`, `state`; `limit` 1-200 (default 50), `offset` 0-100000; newest first (created_at, id); `state: EMPTY` on an empty page |
| `GET /opportunities/candidates/{id}` | candidate, lifecycle history, recorded evidence (setup, rank factors, reward:risk screen, provenance incl. engine version, config hash, calendar status), derived research status and package ref; 404 for an unknown id |
| `GET /opportunities/scans` | recent scans: slot, status, counts, recorded skip reasons (incl. MARKET_CLOSED, EVENT_WINDOW, REWARD_RISK_BELOW_MIN), parameters |
Machine description: `docs/api/openapi-session.json`. Tests: `tests/unit/api/opportunityApi.test.ts`.

