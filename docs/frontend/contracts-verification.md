# TWINS Frontend — Contracts Verification Register (Stage 09.1)

Status: **IMPLEMENTED LOCALLY. CI PENDING** (nothing committed or pushed). Package: `packages/api-contracts`. Tests: `tests/unit/api-contracts/*.test.ts` (9 files, 70 tests) with the shared harness `tests/support/contractHarness.ts`.

This register says, for every contract, how it is known to be correct. **TESTED** = a test drives the real backend route (or compares with the backend's own export/source) and would fail on drift. **SOURCE** = typed from a backend interface or handler by reading it, with no test asserting the inner shape. **UNVERIFIED** = deliberately not typed (`unknown`) or not included.

## 1. Package

```
packages/api-contracts/
  package.json        name @twins/api-contracts, private, type module, main/types src/index.ts — NO dependencies, NO scripts
  tsconfig.json       extends tsconfig.base.json, Bundler resolution, types: [] (no Node typings)
  src/index.ts        re-exports everything below
  src/roles.ts        Role, permission groups, ROLE_PERMISSIONS (mirror of ROLE_PERMS), roleHasPermission
  src/errors.ts       platform error codes + HTTP map, approval error codes + { status, state } map, ErrorBody, ApprovalErrorBody
  src/enums.ts        decision states, order states, position statuses/event kinds, data sources, freshness, analytics datasets/states/dimensions,
                      LIVE_STATUS_UNAVAILABLE, PAPER_MODE, and FRONTEND-only vocabulary (DATA_STATES, PROVENANCE_BADGES, AVAILABILITY)
  src/rules.ts        idempotency key rule, reason rules, list limit, UUID pattern, refused identity fields
  src/wire.ts         response and request types (DecisionView, ApprovalsResponse, PortfolioResponse, PaperOrderView, ...)
  src/analytics.ts    ANALYTICS_CONTRACT_VERSION, ANALYTICS_NOTICE, AnalyticsEnvelope, AnalyticsResponse, SnapshotMetaView, OutcomeRowView, InsightRowView
  src/catalogue.ts    RouteEntry catalogue: AUTH_ROUTES (5), ADMIN_ROUTES (3), PRIVATE_ROUTES (18), ANALYTICS_ROUTES (11), SHARED_ROUTES (17), excluded platform routes
```
Wiring: added to the root `tsconfig.json` references and to `package-lock.json` (workspace link entries only; `npm ci --dry-run` succeeds). No CI workflow edit was needed: the root `vitest.config.ts` includes `tests/unit/**`, so the existing backend `unit` job runs the contract tests; `npm run typecheck` (`tsc -b`) builds the package.

Browser-safety is itself tested (`contractsBoundary.test.ts`): only relative imports; no dependency or script in `package.json`; no Node built-in, `process.env`, secret, token or service-key reference; no `Number(`, `parseFloat`, `Math.` or similar (no arithmetic on money); a future `frontend/` may not import backend packages.

## 2. Design decisions taken in 09.1

1. **Approval-class outcome names are not mirrored.** `DecisionView.outcome` is typed `string`. The audited-places safety scan (`tests/unit/safety/stopLossCoverage.test.ts`) allows approval-class literals only in listed files; rather than edit that allow-list, the package leaves the outcome vocabulary out. This also matches the rule that the browser never derives validity from an outcome name: it displays the string and follows the server's `action.available` / `expired`. (A test asserts the package contains no such literal.) If a reviewer wants the vocabulary mirrored, the alternative is a justified allow-list entry — a deliberate, separate change.
2. **Re-declare, don't import.** Every mirrored value is declared in the package and proven equal by a parity test; `@twins/outcomes`, `@twins/types` and others are imported **only by tests**.
3. **ADMIN is a role with no private permission** in the mirror, proven against the backend's `hasPermission`/`authorize`.
4. **Types are display types.** Money is `DecimalString` (string) or `number` exactly as the wire carries it; nothing in the package computes.

## 3. Verification matrix

| Contract | Evidence | Status |
|---|---|---|
| Permission lists, `ROLE_PERMISSIONS` (all roles × all permissions), private/shared grouping | `rolesParity.test.ts` against `hasPermission`, `authorize`, `isPrivatePermission` | TESTED |
| ADMIN: no private permission; every private/analytics route → 404 `NOT_FOUND`, data layer never called; TRADER reaches the same routes; TRADER → `/admin/users` 403 | `rolesParity`, `adminRestrictions.test.ts` | TESTED |
| Platform error codes and HTTP map | `errorsParity.test.ts` vs `PlatformError.httpStatus` and real 401/422/404 bodies | TESTED |
| Approval errors (7 codes × approve and reject): status, `error`, `state` (REVALIDATION_FAILED → INVALIDATED), body keys, `reasons` = failed check names | `errorsParity.test.ts` driving the real routes | TESTED |
| Login failures: 401 `invalid credentials` (wrong password, unknown email); 403 lockout after 5; correct password also locked (per-email key) | `errorsParity.test.ts` | TESTED |
| Route catalogue = live route table (auth, user, shared modules), both directions; ids/paths unique; counts 5/3/18/11/17 | `catalogueParity.test.ts` (Fastify `onRoute`) | TESTED |
| Private/analytics permission per route = the string written in `userApi.ts` (including templated approve/reject/watch/unwatch routes) | `catalogueParity.test.ts` source scan + `ANALYTICS_ENDPOINTS` | TESTED |
| Shared-intelligence routes = `docs/api/openapi-session.json` (paths, `x-required-permission`, query parameters, required flags) | `catalogueParity.test.ts` vs `sessionOpenApiDocument` | TESTED |
| Analytics: 11 paths, `analytics:read`, `SESSION_REQUIRED`, `ownerScoped`; backend-declared query names accepted | `catalogueParity.test.ts` vs `ANALYTICS_ENDPOINTS` | TESTED |
| Platform (shared-key) routes absent from the catalogue; `/intelligence/source`, `/intelligence/estimate`, `/risk/decisions/:id/intelligence` are not registered by the session modules; register and `/admin/*` not browser-callable | `catalogueParity.test.ts` | TESTED |
| Required query params: `accountId` required on `/capital/profile`, `/risk/policy`, `/portfolio` (missing/invalid → 422, foreign → 404, own → 200); unknown query key refused on every GET; identity fields refused (422) in query and body; list limit 1–200; `state` enum; analytics `dataset` (overview only), `dimension` (strategies only), `finality`, `limit` | `requestRules.test.ts` against the real routes | TESTED |
| Body specs: each POST's required/optional/unknown fields; `idempotencyKey` is a body field with pattern `^[A-Za-z0-9_.:-]{8,128}$` (10 samples; a header does not substitute); reason optional (1–300 after trim) on approve/reject/watch/unwatch; **cancel: reason required 5–300, no key**; non-object body and non-UUID id refused; login/change-password bodies | `requestRules.test.ts` | TESTED |
| Response key sets (no undeclared field, none missing) and value types for: accounts, `/auth/me` (single `role`, no permissions), approvals (+`expired`, `action.available`), decision detail, `permittedSize` (strings for money, numbers for counts), approve/reject/cancel/watch responses, capital profile, portfolio (no unrealised P&L / mark / live balance; backend note present), list envelopes | `wireShapes.test.ts` (+ compile-time key checks) | TESTED (synthetic data) |
| Analytics envelope `{contractVersion, generatedAt, dataset, mode, liveStatus, notice, data}` **plus** top-level `snapshot`, `freshness`, `state` on all 11 endpoints; `SnapshotMeta` key set; STALE served as STALE with reason; state EMPTY/PARTIAL/OK; never LIVE | `analyticsParity.test.ts`; version and notice equal `@twins/outcomes` | TESTED |
| Enums: order states, position event kinds (backend exports); decision states, strategy dimensions, dataset values (source); position status, side, purpose, finality, mode, data source, freshness (store type text) | `vocabularyParity.test.ts` | TESTED |
| Vocabulary LIVE / PAPER / FIXTURE / UNAVAILABLE; 8 data states; availability | `vocabularyParity.test.ts`; `liveStatus: "UNAVAILABLE"` pinned to the backend source | TESTED (frontend-only vocabulary is declared, not parity-tested) |
| Account, capital, risk-policy, controls, order, fill, position, position-event, outcome-row, insight-row, `PublicUser`, login-response field types | read from the store/service interfaces and route mappings (cited in `wire.ts`/`analytics.ts`) | SOURCE |

## 4. Still unverified (explicit; none is exposed as a guaranteed contract)

| Item | How it appears in the package | Evidence needed to resolve |
|---|---|---|
| Inner shape of `DecisionView.explanation`, `stopLossValidation`, `evidenceRefs`, `versions`, `simulationId`, `riskAssessmentId` | `unknown` | decision-engine output type (`packages/decision/src/engine.ts`) + a route test with real engine output |
| `comparables` body; position-event `payload`; outcome `dataQuality`/`missing`; insight `provenance`/`metrics`/`evidenceRefs`; `algorithmVersions` | `unknown` | the producing types + a populated-row route test |
| `data` payload of each of the 11 analytics sections | `unknown` (`AnalyticsResponse<unknown>`) | `AnalyticsReport` types in `packages/outcomes` and a section-by-section schema + test |
| Non-empty `policy`, `controls`, orders, fills, positions, position events | typed from store interfaces; only empty lists / `null` are exercised | route tests with populated fakes (or the integration suite's real rows) |
| `/portfolio` `facts: null` (when it occurs) | typed `PortfolioFacts \| null` | store behaviour for an account with no facts |
| Shared-intelligence response bodies (17 routes) | `response: "unverified"`; no types | the OpenAPI component schemas in `openapiSession.ts` turned into types with a test, or hand-typed and compared |
| Candidate/opportunity row (prices are **numbers**) | not typed | `opportunityApi.ts` mapping + test |
| Source of R-multiple / reward-to-risk figures shown on the decision card | outcome rows carry `rMultiple` (string, SOURCE); the planned ratio on a pending decision is not a typed field | where the engine records planned reward-to-risk |
| System Health fields (platform status routes) | not in the catalogue (shared-key routes are excluded by design) | `statusSurface.ts` / `systemApi.ts` response types, to be handled by the ADMIN-only BFF module in a later stage |
| Admin route response bodies | status codes only (`201`/`204`) | not needed in Stage 09 (no browser UI) |

## 5. Local verification evidence (this machine, not hosted CI)

- `npx vitest run tests/unit/api-contracts`: 9 files, 70 tests passed.
- **Drift-detection check:** four deliberate edits (watch permission, an extra ADMIN permission, an approval status, the cancel-reason minimum) each made the matching tests fail (7 failures); reverting them restored 100% green.
- `npm run typecheck` (`tsc -b`) passes; the test files also typecheck under the base compiler options.
- `npx eslint` on the package, the tests and the harness: no errors, no warnings.
- `npm run scan:secrets`: no findings (it scans tracked files; the package's own boundary test checks the untracked source).
- `npm ci --dry-run`: succeeds with the updated lockfile.
- Full backend unit suite after the final change (`npx vitest run`, which includes the safety suites): 272 files, 4,279 tests passed, exit 0.
- `npm run lint` (whole repository): 0 errors; the 831 warnings are pre-existing, none are in the new files.
- **Hosted CI: not run** (nothing pushed).

## 6. Stage 09.3A additions (local; hosted CI not run)

`src/opportunities.ts` adds typed views for `/opportunities/candidates`, `/opportunities/candidates/:id`, `/opportunities/scans`, `/research/candidates/:id/package` (envelope only) and `/intelligence/channels`. Evidence: `opportunityParity.test.ts` (4 tests) compares the exact key sets with the real routes — **TESTED** for key sets with synthetic data. Still unverified: candidate `evidence` item shapes, the research `package` body, scan `skipped`/`parameters`, `/intelligence/pipeline` and every other shared route.
