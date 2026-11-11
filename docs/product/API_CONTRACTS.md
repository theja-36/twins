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


## Decision watch and comparables (Stage 07; session-protected, owner-only)
| Route | Behaviour |
|---|---|
| `POST /decisions/{id}/watch` and `/unwatch` | body `{idempotencyKey (8-128 chars), reason?}` only (strict; any other field 422). Records a private, append-only bookmark. 200 `{decisionId, status: RECORDED|DUPLICATE, watching, grantsApproval: false}`; 404 for a decision that is not the caller's. It never approves, rejects, consumes an approval or changes state. Permission **`decisions:watch`** (private, owner-scoped, TRADER only; a write, so it is not served under `decisions:read`, and it does not imply `decisions:approve`). |
| `GET /decisions/{id}` | now also returns `watching` (latest watch event decides). |
| `GET /decisions/{id}/comparables` | `{comparables: {state: AVAILABLE|NOT_AVAILABLE, patterns, ...}}` taken from the decision's stored research package (historical-pattern agent). NOT_AVAILABLE with a reason code when no pattern provider ran (G-23); never invented. 404 for another user's decision. |
Tests: `tests/unit/api/userApi.test.ts`, `tests/unit/trading/comparables.test.ts`, integration `tests/integration/trading/stage07.test.ts`.

## Analytics read API (Stage 08; session-protected, owner-only, paper only)

All eleven endpoints are `GET`, need a verified session and the private permission `analytics:read`, and return only the caller's own data (another user's data is never reachable; an ADMIN holds no private permission and gets 404). They are registered by the session-protected user API only; a source-scan test pins that none exists on a shared-token surface. They are NOT in `docs/api/openapi-session.json`, which by design covers only the shared intelligence modules (carry-over, see the gap register).

| Endpoint | Query | Response `data` |
|---|---|---|
| `/analytics/overview` | `dataset=ALL\|VALIDATED\|FIXTURE` (optional; narrows `data` to exactly that set; any other value, or use on another endpoint, is 422) | `{all, validatedOnly, fixtureOnly}` performance metrics |
| `/analytics/strategies` | `dimension=strategy\|version\|instrument\|timeframe\|regime\|exit\|stop\|target\|confidence\|risk\|plannedrr\|decision\|pattern` (optional; narrows `data` to that one slice set; unknown or misplaced = 422) | `byStrategy`, `byVersion`, `byInstrument`, `byTimeframe`, `byRegime`, `byExitReason`, `byStopBehaviour`, `byTargetBehaviour`, `byStopMoved`, `byConfidenceBand`, `byRiskVerdict`, `byPlannedRewardToRisk`, `byDecisionOutcome`, `bySignalType`, `bySignalPattern` |
| `/analytics/channels`, `/independent`, `/agents`, `/decisions`, `/drift`, `/data-quality`, `/calibration` | none | the section of the report |
| `/analytics/outcomes` | `finality=FINAL\|PARTIAL`, `limit<=200` | the user's latest attribution of each position (append-only records, newest first) |
| `/analytics/insights` | `kind`, `limit<=200` | stored REVIEW-only insights |

Every response carries the envelope (`contractVersion`, `generatedAt`, `dataset: PAPER`, `mode: PAPER`, `liveStatus: UNAVAILABLE`, `notice`, `data`, `state`) and, since Stage 08, **which stored snapshot it came from and whether it is current**:
`snapshot: { id, asOf, createdAt, verifiedAt, evidenceHash, inputHash, configHash, algorithmVersions, createdBy, freshness, staleReason, complete, maxAgeSeconds }` and top-level `freshness`.
- `freshness: CURRENT` - the snapshot was built from exactly the user's current evidence, settings and algorithm versions and is not older than `TWINS_LEARNING_SNAPSHOT_MAX_AGE_SECONDS` (default 3600; the platform-level pipeline counts it also reports age independently). Otherwise the API builds a new snapshot first.
- `freshness: STALE` - served ONLY when the current evidence could not be analysed; `staleReason` says why. A stale snapshot is never presented as current. With no snapshot at all the request fails.
- `complete: false` - an input source reached the 5,000-row read bound (G-50); the report is of the newest rows.
- `asOf` is the newest record of the evidence (never the wall clock): the same evidence always reproduces the same report (`reportSha256` is stored with it).
Metrics (`performance-metrics-v2`): `winRate` and `lossRate` (Wilson 95%), `expectancyR` (unrounded R; `exact` 8-place string; Student-t 95% interval with `degreesOfFreedom`), `payoffRatio` and `profitFactor` (computed in exact decimals; `exact` 8-place string; the profit factor reports no interval, with the reason), `maxDrawdown` (cumulative net P&L), `maxDrawdownPct` (**NOT_AVAILABLE**: needs an equity curve), `bySignalPattern` (**NOT_AVAILABLE**: needs the G-23 pattern provider). No figure is reported below the 30-outcome floor.

Operator command (not an HTTP route): `scripts/ops/outcome-correction.ts` (dry run by default; see the acceptance report). It is the only way to supersede a FINAL attribution.

## Execution modes and lifecycle contract (Stage 07)
Decision outcome (QUALIFIED, WAIT, REJECT, EVALUATION_ONLY, NO_TRADE) is separate from workflow state (PENDING, APPROVED, REJECTED, EXPIRED, SUPERSEDED, CANCELLED), which is separate from order status (PROPOSED, SUBMITTED, ACCEPTED, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED, EXPIRED) and position status (OPEN, CLOSED). Approval never creates an order; execution re-checks ownership, permission, approval, gate, fresh revalidation and kill switch, then creates one keyed order; fills are applied once against the order state they were computed from; positions are derived from fills. PAPER is the only operational mode. ASSISTED_LIVE and CONTROLLED_AUTO are refused by `checkExecutionGate`; their rules are specified and tested in `packages/types/src/platform/liveArchitecture.ts` but are called by no application code.
