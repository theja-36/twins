# TWINS Frontend — API Integration Map

Status: PROPOSED (corrected after the Stage 09.0 final review). Route inventory verified by reading the backend registrations on `feat/master-build`: `apps/api/src/{authApi,userApi,researchApi,opportunityApi,telegramIntelApi,intelligenceApi}.ts`, `packages/outcomes/src/contracts.ts` (`ANALYTICS_ENDPOINTS`), `packages/types/src/platform/{auth,errors}.ts`. Stage 09.1 has since implemented `packages/api-contracts` with parity tests (see [contracts-verification](contracts-verification.md)); items still marked **UNVERIFIED** below have no contract test yet. This table is documentation; the 09.1 tests are the guard.

## 1. Two API worlds

| World | Auth | Browser reach |
|---|---|---|
| **A. Session routes** — per-user or shared-intelligence, permission-checked | `Authorization: Bearer tws_…` added by the BFF from the HttpOnly cookie | TRADER and ADMIN, subject to each route's permission |
| **B. Legacy platform routes** — shared service key (`checkBearerToken`), single tenant | shared key held server-side in the BFF | **ADMIN only, via a dedicated server-side module. Never TRADER. Never browser code.** |

Verified World B members relevant to the frontend (all registered with the shared key, **not** session): `GET /health`, `/health/status`, `/system/config`, `/agents/status`, `/intake/status`, and in `intelligenceApi.ts`: `GET /intelligence/source`, `POST /intelligence/estimate`, `GET /risk/decisions/:id/intelligence` (registered via `registerIntelligenceRoutes(..., { authorized: checkBearerToken })`, `index.ts:365`). Earlier drafts wrongly listed `/intelligence/source` and `/intelligence/estimate` as session routes; they are World B and **not exposed to TRADER**.

## 2. Error model

Platform error body: `{ "error": CODE, "message": string, "reasons": string[] }` with fixed messages.

| Code | HTTP | UI state |
|---|---|---|
| UNAUTHENTICATED | 401 | session ended → sign-in, caches cleared |
| FORBIDDEN | 403 | DENIED (shared routes; also login lockout, see §3) |
| NOT_FOUND | 404 | "Not found". **Also returned for a private route called without the permission (e.g. any ADMIN call) and for another user's resource.** |
| VALIDATION | 422 | field errors |
| CONFLICT / STALE_DATA | 409 | refetch + notice |
| RISK_BLOCKED | 422 | show `reasons[]` (platform routes that use it) |
| EXECUTION_DISABLED | 403 | UNAVAILABLE |
| DEPENDENCY_UNAVAILABLE | 503 | UNAVAILABLE / retry |
| INTERNAL | 500 | ERROR with correlation id |

**Approval actions use their own codes** (verified `APPROVAL_HTTP`, `approvalError`, `userApi.ts:41-77`). Body: `{ error: CODE, state: STATE, message, reasons: string[] }` where `reasons` are the **names of failed re-validation checks**.

| error | HTTP | state | UI |
|---|---|---|---|
| NOT_FOUND | 404 | NOT_FOUND | not found |
| NOT_PENDING | 409 | NOT_PENDING | "No longer pending"; refetch |
| NOT_QUALIFIED | 422 | NOT_QUALIFIED | "Not eligible for approval" |
| EXPIRED | 409 | EXPIRED | expired panel, no actions |
| REVALIDATION_FAILED | 409 | INVALIDATED | invalidated panel listing failed checks (`reasons`); nothing approved |
| ALREADY_ACTIONED | 409 | ALREADY_ACTIONED | "Already actioned" (idempotent replay: request changed nothing) |
| NOT_PERMITTED | 403 | NOT_PERMITTED | DENIED |

The frontend renders these states and reason names; it never recomputes validity, risk or eligibility.

## 3. World A — session routes (BFF relay allow-list)

"Query/body" lists the only keys the backend accepts (it rejects unknown ones with VALIDATION).

### Auth (BFF-owned)
| Route | Notes | Screens |
|---|---|---|
| `POST /auth/login` `{email,password}` → `{token,expiresAt,user}` | BFF sets cookies; token never reaches JS. Lockout: after `maxLoginFailures` (5) failures per **email** key within the lockout window the backend throws **FORBIDDEN 403 "too many attempts, try again later"** (`service.ts:102-107`). Wrong credentials, unknown email or inactive user: **401 UNAUTHENTICATED `invalid credentials`** (VERIFIED by test; the 6th attempt after 5 failures is the 403 lockout, even with the correct password). | Sign-in |
| `POST /auth/logout` → 204 | BFF clears cookies | shell |
| `GET /auth/me` → `{ user: { id, email, displayName, role, isActive } }` | single `role`; no permission list | shell |
| `POST /auth/change-password` `{currentPassword,newPassword}` → 204 | revokes **other** sessions (`service.ts:145`) | Account |
| `POST /auth/register` | closed unless `TWINS_REGISTRATION_OPEN=true` (`index.ts:343`); **not exposed** | — |
| `POST /admin/users`, `/admin/users/:id/role`, `/admin/users/:id/active` | ADMIN; role change/deactivation revoke sessions. **No browser UI in Stage 09** (not authorised; no user-list route) | Users & Access (planned) |

### Accounts, capital, risk, portfolio (TRADER)
| Route | Permission | Query | Response (verified fields) | Screens |
|---|---|---|---|---|
| `GET /accounts` | capital:read | none | `{accounts:[{id,name,tradingMode,baseCurrency,isActive}]}` | shell, 8, 10 |
| `GET /capital/profile` | capital:read | **accountId required** | `{accountId, isolation:"PER_USER_ACCOUNT", effective, versions}`; `effective`/`versions` typed from `StoredCapitalProfile` (keys VERIFIED by test for a non-null profile) | 8 |
| `GET /risk/policy` | risk:read | **accountId required** | `{accountId, policy}`; `policy` typed from `StoredRiskPolicy` (source-verified; the route test only exercises `null`) | 8 |
| `GET /risk/controls` | risk:read | none | `{controls}`; rows typed from `ActiveControlRow` (source-verified; the route test only exercises an empty list) | 1, 8 |
| `GET /portfolio` | positions:read | **accountId required** | `{accountId, mode:"PAPER", isolation, facts, notes[]}`; `facts` = `{accountId, openPositions:number, allocatedNotional:string, realizedPnl:string, totalCapital:string\|null, availableCapital:string\|null, unallocatedCapital:string\|null, capitalProfileVersion:number\|null}` | 10, 1 |

`/portfolio` carries **no unrealised P&L, no mark prices and no live balance**; its note says "no live portfolio source is connected". `allocatedNotional` is paper notional at entry price.

### Decisions and approvals (TRADER)
| Route | Permission | Query / body | Screens |
|---|---|---|---|
| `GET /decisions` | decisions:read | `state` (decision-state enum), `accountId`, `limit` | 11 |
| `GET /decisions/:id` | decisions:read | – → `{decision, events[], approval, watching}` | 2, 11 |
| `GET /decisions/:id/comparables` | decisions:read | – | 2 |
| `GET /approvals` | decisions:read | none → `{pending[], history[]}`; pending items carry `expired` and `action` (availability decided by the server) | 1, 2 |
| `POST /decisions/:id/approve` | decisions:approve | body `{idempotencyKey (required), reason?}` → 200 `{decisionId, status?}` | 2 |
| `POST /decisions/:id/reject` | decisions:approve | same body | 2 |
| `POST /decisions/:id/cancel` | decisions:approve | body `{reason}` **required, 5–300 chars; no idempotencyKey** → 200 `{decisionId, result}` | 2 |
| `POST /decisions/:id/watch`, `/unwatch` | **decisions:watch** | body `{idempotencyKey (required), reason?}` → 200 `{decisionId, status, watching, grantsApproval:false}` | 2 |

Request rules (verified `key()`, `reason()` in `userApi.ts:36-39`): `idempotencyKey` is a **body field** matching `^[A-Za-z0-9_.:-]{8,128}$` (not an HTTP header). `reason` when present is trimmed, 1–300 chars; **optional for approve and reject**; **required (≥ 5 chars) for cancel**. Unknown body keys are rejected. A decision's `permittedSize` has `maxLossAtStop`, `riskPerLot`, `grossExposure` as strings and `lots`, `quantity`, `sizeMultiplier` as numbers.

### Execution reads (TRADER)
| Route | Permission | Query | Row fields (verified types) | Screens |
|---|---|---|---|---|
| `GET /execution/orders` | orders:read | `decisionId`, `status`, `limit` | `PaperOrderRow`: ids, `purpose` ENTRY\|EXIT, `side`, `orderType`, `quantity`/`limitPrice`/`filledQuantity`/`avgFillPrice` strings, `status`, `stateReason`, `createdAt` | 9 |
| `GET /execution/orders/:id/fills` | orders:read | none | fills: quantity/price/costs strings, `priceSource` | 9 |
| `GET /execution/positions` | positions:read | `status` OPEN\|CLOSED, `limit` | `PaperPositionRow`: `quantity`, `initialQuantity`, `avgEntryPrice`, `initialStop`, `stopLoss`, `targets[]`, `realizedPnl`, `realizedCosts` strings, `status`, `exitReason`, `openedAt`, `closedAt` | 9, 1 |
| `GET /execution/positions/:id/events` | positions:read | none | event list | 9 |

There is **no `accountId` filter** on these two lists. The routes return the store rows verbatim (`{orders}` / `{positions}` are `ops.orders()` / `ops.positions()` unmapped, `userApi.ts`); the row types are taken from the store interfaces; tests exercise only the envelope keys with empty lists, so row-level keys are source-verified, not test-verified.

### Analytics (TRADER; all `analytics:read`, owner-scoped)
`GET /analytics/{overview, strategies, channels, independent, agents, decisions, outcomes, insights, drift, data-quality, calibration}` — 11 endpoints from `ANALYTICS_ENDPOINTS` (`packages/outcomes/src/contracts.ts`, each with `auth:"SESSION_REQUIRED"`, `ownerScoped:true`, query spec and response name).
- Query keys: `accountId`, `dataset` (`ALL|VALIDATED|FIXTURE`, **overview only**), `dimension` (strategies; map in `STRATEGY_DIMENSIONS`), list params for `outcomes`/`insights` (`kind?`, `limit<=200`).
- **Envelope** (`ResponseEnvelope`): `{ contractVersion, generatedAt, dataset:"PAPER", mode:"PAPER", liveStatus:"UNAVAILABLE", notice, data }`. Responses also carry `snapshot`, `freshness` and `state` (`EMPTY|PARTIAL|OK`; insights: `EMPTY|OK`) **at the top level**, alongside the envelope keys (`{ ...envelope, ...meta(view), state }`, `userApi.ts:163-195`) — VERIFIED by test on all 11 endpoints. `accountId` is accepted in the query allow-list but ignored by every analytics route (VERIFIED).
- `SnapshotMeta` (`snapshot.ts:72`): exactly `id, asOf, createdAt, verifiedAt, evidenceHash, inputHash, configHash, algorithmVersions, createdBy, freshness: "CURRENT"|"STALE", staleReason, complete, maxAgeSeconds` (key set VERIFIED by test). `liveStatus:"UNAVAILABLE"` is real backend support for never showing a LIVE badge.

### Shared intelligence (session-authenticated; shared data, no owner) — TRADER and ADMIN
| Route | Permission |
|---|---|
| `GET /opportunities/candidates`, `/opportunities/candidates/:id`, `/opportunities/scans` | opportunities:read |
| `GET /research/candidates/:id/package`, `/research/packages/:id`, `/research/agents` | research:read |
| `GET /intelligence/channels`, `/intelligence/channels/:id` | channels:read |
| `GET /intelligence/claims`, `/intelligence/claims/:id`, `/intelligence/claims/:id/historical-matches` | signals:read |
| `GET /intelligence/candidates`, `/intelligence/pipeline` | opportunities:read |
| `GET /intelligence/channels/:id/performance`, `/intelligence/playbooks`, `/intelligence/playbooks/:id`, `/intelligence/archive/channels` | strategies:read |

Candidate prices (`entryLow/entryHigh/stopLoss/targets`) are **number-typed** on the wire (see §6).

## 4. World B — platform routes (ADMIN-only server module)

`/health`, `/health/status`, `/system/config`, `/agents/status`, `/intake/status` → Screen 13 only. The `runtimeState` (trading/intake enabled, kill-switch) and outbox counts exist in `statusSurface.ts`; exact response fields shown by the System Health screen are **UNVERIFIED** and must be confirmed from `statusSurface.ts`/`systemApi.ts` at implementation.

**Not wired in Stage 09:** `/paper/*`, legacy `/risk/*`, `/notifications`, `/market/*`, `/news/telegram`, `/telegram/*`, `POST /admin/paper/switch`, `/intelligence/source`, `POST /intelligence/estimate`, `/risk/decisions/:id/intelligence`.

**Accepted residual risk (not equivalent to backend authorization):** for World B the backend sees only the shared key and does not know the user. "ADMIN-only" is enforced solely by the BFF's server-side role check. A compromised or misconfigured BFF could read platform status. These routes carry platform status, not private trader data. Closing it requires session/role-protected backend equivalents (separate approval).

## 5. Gaps shown as UNAVAILABLE / PLANNED

| Gap | Where |
|---|---|
| HTTP request to run paper execution after approval (only the operator CLI `decision-control execute`) | 2, 9 |
| Capital write, risk-policy write (permissions exist, no routes) | 8 |
| Enable PAPER execution permission | 8, 15 |
| Admin user list, audit viewer, `system:read` route | 14, 13 |
| Per-user notification inbox | shell |
| Market regime / per-user market data (G-16, G-20) | 6 |
| Unrealised P&L, mark prices, live balance (no live source) | 1, 9, 10 |
| Cursor pagination (limit-only) | lists |
| Machine-readable contract for `userApi` routes (G-51, partly; see §7) | all |

Implementing any of these needs separate explicit approval.

## 6. Money and number representation (verified)

| Value | Wire type |
|---|---|
| order/fill/position quantities and prices, `avgEntryPrice`, `stopLoss`, `realizedPnl`, costs, `targets[]` on positions | decimal **string** |
| `permittedSize.maxLossAtStop`, `riskPerLot`, `grossExposure`; portfolio `allocatedNotional`, `realizedPnl`, capital fields | decimal **string** |
| `permittedSize.lots`, `quantity`, `sizeMultiplier`; `openPositions` | **number** (integer or ratio) |
| candidate `entryLow`, `entryHigh`, `stopLoss`, `targets[]`, `rankScore` | **number** |

Rule: the frontend **displays** both kinds and never performs financial or risk calculations: no totals, P&L, R-multiples, sizing, exposure or validity checks. Numbers are formatted for display only (fixed decimals, Indian grouping) with no arithmetic. Anything a screen needs that the backend does not supply is shown UNAVAILABLE. (Mockup R-multiples and ratios are illustrative of backend `explanation` content; the exact backend field is **UNVERIFIED**.)

## 7. Contract seeds and Stage 09.1 parity tests

Existing seeds (verified):
- `docs/api/openapi-session.json` (+ `docs/api/README.md`), generated from `apps/api/src/openapiSession.ts`; `tests/unit/api/openapiSession.test.ts` fails if a described route is missing, a route is undescribed, the committed JSON is stale, or any operation is not a read. It covers the **session Telegram/intelligence read routes** only.
- `ANALYTICS_ENDPOINTS` and the `ResponseEnvelope` type (`packages/outcomes/src/contracts.ts`).

G-51, restated: the session intelligence routes and the analytics routes have machine-readable descriptions; the `userApi` routes (accounts, capital, risk, portfolio, decisions, approvals, execution) do **not**. Stage 09.1 adds that, seeding from the two sources above. `packages/api-contracts` must **re-declare** types/enums (no runtime import of `@twins/outcomes`, which pulls backend code) and prove equality with parity tests: catalogue vs the Fastify route table; catalogue vs `openapi-session.json` and `ANALYTICS_ENDPOINTS`; permission/role constants vs `auth.ts`; error codes and both HTTP maps; response schemas vs existing test fixtures.

*Implemented in 09.2:* the BFF relay serves **GET only**, generated from the route catalogue (`frontend/src/bff/allowlist.ts`); write actions are intentionally not relayed until the screens that use them (09.3). `/accounts` is the only relayed read with a verified response schema so far.

## 8. Client conventions

One typed function and one query hook per catalogue entry; keys `[endpoint, accountId?, params]`; cache purged on logout/user change. Responses validated against contract schemas at the BFF edge (failure → ERROR, never partial render). Mutations send `idempotencyKey` in the **body** (generated when the confirmation dialog opens, reused on retry); success invalidates `approvals`, `decisions`, `portfolio`; the UI shows the server-returned status, never an optimistic one. Polling: 15 s approvals/positions while visible, 60 s elsewhere. Limit-only pagination → "Load more". Fixture mode (dev/CI only) points the BFF at a stub generated from the contracts; production bundles exclude fixtures.
