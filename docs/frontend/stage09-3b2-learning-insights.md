# Stage 09.3B.2 — Learning & Insights

Status: **IMPLEMENTED LOCALLY. NOT COMMITTED. HOSTED CI NOT RUN.** Baseline `ef31d6d5c9e2230de056ff00cc1b092e14131bfe`. Frontend and contract-test work only: no backend endpoint, logic, migration, auth or permission change.

## 1. Implemented (route, components)
Route `/insights` (screen 7, TRADER only), inside the existing shell. Sections are chosen by `?section=` (unknown values fall back to Overview): Overview, Strategies, Channels, Independent, Agents, Decisions, Drift, Data quality, Calibration, Outcomes, Insights. One section mounts at a time, so opening the page makes **one** analytics request.
Components (`frontend/src/components/insights/`): `InsightsScreen`, `PerformanceSections` (overview, strategies), `PipelineSections` (channels, independent, agents, decisions), `ReliabilitySections` (drift, data quality, calibration), `OutcomesSection`, `InsightsSection`, `shared` (snapshot bar, fixture label, metric cards, state frame, safe generic rows), `guard` (section mount boundary). Hooks `src/api/analyticsHooks.ts`; types `src/api/analyticsTypes.ts`.

## 2. API routes and parameters (all GET, through the authenticated relay)
`/analytics/overview`, `/strategies`, `/channels`, `/independent`, `/agents`, `/decisions`, `/drift`, `/data-quality`, `/calibration` (no parameters sent), `/analytics/outcomes?limit=&finality=`, `/analytics/insights?limit=&kind=`. Permission `analytics:read`; private, owner-scoped; ADMIN receives 404 from the backend. `dataset`, `dimension`, `accountId` and `cursor` are **never sent**: the full response already carries every dataset and dimension (switched in the browser, which saves snapshot-triggering reads); `accountId` is accepted but ignored by the backend; **`cursor` is accepted but never used by the outcomes handler and the response carries no next cursor, so there is no paging beyond `limit`** (the page says so).

## 3. Contracts and BFF
`src/bff/schemas.insights.ts` defines relay response schemas for all 11 routes, built on the 09.3B.1 strict schemas, and they are **wired into `RELAY_RESPONSE_SCHEMAS`** (no relay, auth, CSRF, allow-list or permission code changed). Undeclared fields are stripped (outcome rows lose position and decision ids), money stays an exact string, nulls stay null, unverified inner structures (`channels` rows, agent outcome association, insight provenance/evidence/metrics) are `unknown` and shown only as inert text. A response that breaks the contract becomes the existing neutral 502 with no data. `INSIGHT_KINDS` was added to `api-contracts` with a parity test against the database constraint list.

## 4. Presentation rules
Every metric card shows its value or **Not computed** (never 0), `n`, the interval and note exactly as supplied, and the backend definition in plain view. Rates are labelled as fractions (no percentage arithmetic). Money uses string formatting only. No chart is drawn (tables and cards only; see §12).

## 5. PAPER, fixture and live
Always shown: PAPER, `DATASET PAPER`, **LIVE ANALYTICS UNAVAILABLE**. `FIXTURE-BACKED DATA` / `INCLUDES FIXTURE-BACKED DATA` is derived from the backend's data-source counts (nothing is summed). "Validated only" is explained as *not fixture-backed, still PAPER, never live*.

## 6. Snapshot side effect
The page states that a read may make the backend store one immutable PAPER snapshot. Reads are deliberate: 5-minute stale time, no refetch on focus, mount or reconnect, no polling, no retry; each section is requested once and cached. Displayed: generated time, snapshot id (short), as-of, freshness, stale reason, contract version, and (in details) evidence/input/config hashes, algorithm versions, creator, completeness and maximum age. Backend logic is unchanged.

## 7. Stale, partial, empty, error, denied, unavailable
All eight states are wired through one frame (`SectionFrame` → `DataRegion`): STALE (badge, reason, data kept), PARTIAL (notice, data kept), EMPTY (explanation), ERROR (code and a working Try again), DENIED (a 404 on this private route), UNAVAILABLE (explicit panels), LOADING (skeleton), READY. Filters sit outside the frame so they never disappear while loading (a unit test found this defect and it was fixed).

## 8. Permissions
The server page withholds the module from an ADMIN ("Not available to administrators") **before any section mounts**, so no analytics request is made; Playwright asserts zero analytics requests and a backend 404 on a direct call. Unauthenticated visitors are redirected to sign-in with no request. Per-user isolation is the backend's (09.3B.1 HTTP evidence); the browser sends no account or user parameter.

## 9. Insights
Rows are plain text. Recommendation is `REVIEW` ("FOR HUMAN REVIEW") or none; any other value is refused by the schema. There is no button or link that could accept, dismiss, apply or execute. Kinds offered: the 12 database kinds (a real run produced 10 of them).

## 10. Tests (local)
Frontend Vitest 19 files, 188 tests (new: `schemas.insights.test.ts` 16, `analytics.relay.test.ts` 17, `insights.test.tsx` 22, `insights-access.test.ts` 1); Playwright 172 (124 existing + 16 in `insights.spec.ts` + 32 accessibility/overflow runs for four insight pages × 4 widths × 2 themes); backend unit 274 files / 4,289 tests; related integration (api-contracts, userRoutes, outcomes) 6 files / 59 tests; typecheck, root and frontend lint (0 errors), production build, `npm audit --omit=dev` (0 vulnerabilities) and secret scan pass. The real-output sample behind the schema and e2e tests is `frontend/e2e/fixtures/analytics.sample.json` (synthetic FIXTURE data, test-only).

## 11. Status by section
| Section | Status |
|---|---|
| Overview, Strategies, Data quality, Calibration, Outcomes, Insights (list) | IMPLEMENTED against verified shapes |
| Decisions, Drift, Agents, Independent | IMPLEMENTED; inner rows beyond the real sample (not-executed estimates, populated drift reports) are UNVERIFIED |
| Channels | PARTIALLY IMPLEMENTED: channel rows are UNVERIFIED (empty in every dataset) and shown as plain fields |
| Calibration curve / probability buckets, live analytics, unrealised P&L, channel reliability, strategy evaluation, max drawdown % | UNAVAILABLE (not provided by the backend) |

## 12. Limitations and intentionally not implemented
No charts (no verified series suited to one; tables carry the figures). No cursor paging (backend ignores it). No account filter (ignored by the backend). Insight provenance, evidence references and metrics are shown as text, not interpreted. A 24-insight page is very tall on a phone (data-driven). Screenshots: `docs/frontend/stage09-3b2/screenshots/` (32 PNGs: four pages, 1440/820/390/320 px, dark and light); the overview at 1440 px dark was reviewed visually, the others were verified by the automated overflow and axe checks; no manual screen-reader test and no full WCAG audit was done.
