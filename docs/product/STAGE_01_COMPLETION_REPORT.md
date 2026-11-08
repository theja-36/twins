# Stage 01 completion report: session authentication and user isolation

Status: **IMPLEMENTED, NOT YET VERIFIED.** Everything below is in code and covered by unit tests that pass locally (232 files / 3,875 tests). The integration tests that prove the database behaviour (`tests/integration/auth/stage01.test.ts` already green in CI at 64e730a; `userRoutes.test.ts` and `runtimeRole.test.ts` are new) have never run: they need PostgreSQL, which exists only in CI, and pushing needs approval. Nothing here may be called VERIFIED, and G-13 / G-26 may not be called closed, until that run is green.

## What exists

| Piece | Where |
|---|---|
| Passwords (scrypt, policy), opaque hashed sessions, expiry, revocation, lockout, role/active doors | `packages/auth` |
| Database protection of roles (trigger, doors, runtime-role grants) | migration 0040, `infrastructure/staging/app-role.sql` |
| Account and session routes | `apps/api/src/authApi.ts` |
| Owner-scoped routes (this stage) | `apps/api/src/userApi.ts` (routes), `apps/api/src/userOps.ts` (data layer) |
| Pure authorisation model | `packages/types/src/platform/auth.ts` (`authorize`, `ownerScope`; added `decisions:read`, `risk:read`) |

## The one rule for every user-scoped route
1. Identity comes only from the verified session: `auth.authenticate(bearer token)` then `ownerScope(principal)`. A `userId`, `user_id`, `ownerId`, `owner`, `accountOwner`, `approverUserId` or `actorId` in the query or body is **refused (422)**, not ignored.
2. Permission: `authorize(principal, permission, ownerScope(principal))`. A role without the permission gets **NOT_FOUND** for private data (no existence leak). ADMIN holds no private permission.
3. Data: every `UserOps` function takes the session user id and calls a store that filters on `user_id` and runs under row-level security (`withUser`).
4. The shared service API key is not a session and is never accepted on these routes (a static test forbids referencing it).
5. Any error is a fixed code and fixed message; revalidation failures expose check names only.

## Endpoint-by-endpoint matrix

Auth column: S = verified session required; ADMIN = session whose role is ADMIN; SK = shared service API key (owner-run, no user identity); none = public.

| Method and path | Auth | Permission | Ownership | Notes |
|---|---|---|---|---|
| POST /auth/register | none | - | creates a TRADER only | closed unless `TWINS_REGISTRATION_OPEN=true`; role fields refused |
| POST /auth/login | none | - | - | generic failure, per-email lockout |
| POST /auth/logout | S | - | own session | revokes the presented session |
| GET /auth/me | S | - | self | |
| POST /auth/change-password | S | - | self | signs out every other session |
| POST /admin/users | ADMIN | users:manage (role check) | - | re-checked in `twins_create_user` |
| POST /admin/users/:id/role | ADMIN | users:manage | target is another user | not self, not the last admin; DB door repeats it |
| POST /admin/users/:id/active | ADMIN | users:manage | target is another user | not self, not the last admin |
| GET /accounts | S | capital:read | own accounts | |
| GET /capital/profile?accountId | S | capital:read | account must be the user's, else 404 | per-account, never pooled |
| GET /risk/policy?accountId | S | risk:read | account must be the user's, else 404 | |
| GET /risk/controls | S | risk:read | platform controls plus the user's own (RLS) | |
| GET /decisions, /decisions/:id | S | decisions:read | own decisions; another user's id = 404 | |
| GET /approvals | S | decisions:read | own pending QUALIFIED decisions (expired flagged) and own history | |
| POST /decisions/:id/approve, /reject | S | decisions:approve | own decision only; 404 otherwise | one-time (ALREADY_ACTIONED), expiry (EXPIRED), fresh revalidation (INVALIDATED), paper permission (NOT_PERMITTED), append-only approval record via the database door |
| POST /decisions/:id/cancel | S | decisions:approve | own decision only | reason required |
| GET /execution/orders, /execution/orders/:id/fills | S | orders:read | own rows only | another user's order id yields an empty list |
| GET /execution/positions, /execution/positions/:id/events | S | positions:read | own rows only | |
| GET /analytics/overview, strategies, channels, independent, agents, decisions, drift, data-quality, calibration | S | analytics:read | computed from the user's own records | Stage 08 envelope (PAPER only, live UNAVAILABLE) plus `state` EMPTY / PARTIAL / OK |
| GET /analytics/outcomes, /analytics/insights | S | analytics:read | own records | list parameters validated (`parseListQuery`) |

Legacy owner-run routes (SK, unchanged): `/health*`, `/openapi.json`, `/market/*`, `/telegram/channels|claims`, `/news/telegram`, `/intake/status`, `/agents/status`, `/notifications`, `/system/config`, `/paper/*`, `/risk/decisions*`, `/risk/approvals`, `/risk/decisions/:id/approval*`, `/intelligence/*`; `POST /admin/paper/switch` (separate admin key). These serve the **single-tenant legacy pipeline** (`risk_decisions`, `paper_trades`; G-28) and system status. They hold no per-user identity and must never be exposed to end users directly; the frontend reaches them only through the server-side proxy.

## Tests that prove it
Unit (run): `tests/unit/auth/auth.test.ts` (24), `tests/unit/api/authApi.test.ts` (10), `tests/unit/api/userApi.test.ts` (18: 401 on every route for missing/garbage/service-key credentials, expired and revoked sessions, deactivated user, ADMIN gets 404 on every private route, per-user fake data layer proves user A never receives B's data and every data call carries the session's id, spoofed ids refused, approval replay/expiry/revalidation mapping, analytics envelope and owner scoping, static checks).
Integration (CI only, not yet run on this commit): `userRoutes.test.ts` (real users, sessions, RLS: expired / revoked / too-old / deactivated sessions; own vs foreign decisions, accounts, capital, orders, positions; spoof refusal; A cannot approve/reject/cancel B's decision; approval replay; expired approval becomes EXPIRED with no approval row; reject and cancel states; analytics owner scoping with FIXTURE labelling; TRADER cannot change roles; ADMIN has no private data) and `runtimeRole.test.ts` (applies the real `app-role.sql`: the runtime role cannot change `users.role` / `is_active`, insert or delete users, write decision/order/fill/position tables or delete the auth log; the doors work only for the right actor).

## Remaining Stage 01 gaps (honest)
- CI has not run on these commits. Until it does, nothing is VERIFIED.
- Legacy single-tenant routes (above) are not per-user. Migrating them means migrating the legacy tables (G-28), a separate decision.
- The frontend still talks to the legacy proxy only; it has no login BFF (httpOnly session cookie) yet, so the new routes are not reachable from the UI (Stage 09 follow-up).
- The new routes are not yet in `openapi.json`.
- No login rate limit by IP (only per email); no password reset or email verification (needs a mail provider, Stage 10).
- Controlled-auto / assisted-live approval modes (Stage 07) and per-user capital/risk write APIs (Stage 02) are not part of this stage.
