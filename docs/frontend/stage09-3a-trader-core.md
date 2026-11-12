# Stage 09.3A — Trader core: four screens

Status: **IMPLEMENTED LOCALLY. NOT COMMITTED. HOSTED CI NOT RUN.** Baseline: Stage 09.2 (`695fc4e`).

| # | Screen | Path | Roles | Data (all read-only, through the BFF relay allow-list) |
|---|---|---|---|---|
| 1 | Overview | `/` | TRADER (ADMIN is redirected to Platform overview) | `/accounts`, `/approvals`, `/decisions?limit`, `/execution/positions?status=OPEN`, `/opportunities/candidates`, `/opportunities/scans` |
| 6 | Market Intelligence | `/market` | TRADER, ADMIN | `/intelligence/channels`, `/opportunities/scans`, `/opportunities/candidates` |
| 3 | Opportunity Discovery | `/opportunities` | TRADER, ADMIN | `/opportunities/candidates` (`source`, `state`, `limit`, `offset`), `/opportunities/scans` |
| 4 | Opportunity Detail | `/opportunities/<uuid>` | TRADER, ADMIN (decisions section TRADER only) | `/opportunities/candidates/:id`, `/research/candidates/:id/package`, `/decisions?limit=200` (TRADER) |

## What was verified, and how
- **Contracts** (`packages/api-contracts/src/opportunities.ts`): candidate, candidate detail, scan, research-package envelope and channel views. `tests/unit/api-contracts/opportunityParity.test.ts` drives the REAL opportunity, research and Telegram-intelligence handlers (fake data layer) and asserts the exact key sets (4 tests).
- **BFF**: relay response schemas for 8 more routes (`schemas.ts`); undeclared fields are stripped, wrong types refused (`schemas.stage093a.test.ts`, 7 tests). The research `package` (agent results) is deliberately NOT relayed: its inner shape is unverified.
- **Catalogue**: the shared routes keep their `unverified` flag in `catalogue.ts` (route-level register unchanged); the five shared routes used here now have a key-parity test, recorded in `contracts-verification.md` §6.

## What the screens do not do
No frontend calculation of score, reward-to-risk, size, eligibility, exposure, P&L or validity (lint rule enforces no arithmetic helpers). No order, approval or execution control. No legacy shared-key route is called or relayed. Nothing is shown as LIVE; FIXTURE data carries a FIXTURE badge and banner.

## Backend gaps shown as NOT AVAILABLE (not invented)
Portfolio equity / cash balance, unrealised P&L and mark prices, account performance, notifications inbox, market regime, live quotes, news feed, technical-indicator feed, options chain / Greeks / IV, economic events, instrument reference data, per-agent research findings (shape unverified), channel reliability, candidate→channel link, candidate→scan link, candidate-level risk assessment (risk checks surface only on a rejected approval).

## Known limits
- The candidate API has no text search or date filter: the text box narrows loaded rows only; "today" is not available, so counts are "most recent N".
- Decisions for a candidate are matched client-side from the trader's latest 200; older decisions may not appear (the API has no candidate filter).
- Pagination is offset/limit; "Next" is enabled when a full page returned, so the last page can be empty.
- Evidence items are rendered generically (labelled text) because their inner shapes are not contract-guaranteed.

## Local evidence (not hosted CI)
Backend unit suite 273 files / 4,283 tests; frontend Vitest 130; Playwright 124 (incl. axe in both themes at 1440/820/390/320 for the new pages); `tsc -b`, lint (0 errors), `next build` pass.

## Endpoint-to-screen map, permissions and ownership (all GET, no body)

| Route | Query | Permission | Roles the BACKEND allows | Data | Handler | Test evidence | Screens |
|---|---|---|---|---|---|---|---|
| `/opportunities/candidates` | `source`, `state`, `limit` (1–200), `offset` | `opportunities:read` | TRADER, ADMIN | shared | `opportunityApi.ts` | `tests/unit/api/opportunityApi.test.ts`; keys: `opportunityParity.test.ts` | 1, 3, 6 |
| `/opportunities/candidates/:id` | none | `opportunities:read` | TRADER, ADMIN | shared | `opportunityApi.ts` | same | 4 |
| `/opportunities/scans` | `limit`, `offset` | `opportunities:read` | TRADER, ADMIN | shared | `opportunityApi.ts` | same | 1, 3, 6 |
| `/research/candidates/:id/package` | none | `research:read` | TRADER, ADMIN | shared | `researchApi.ts` | `tests/unit/api/researchApi.test.ts`; envelope keys: parity test | 4 |
| `/intelligence/channels` | `limit` | `channels:read` | TRADER, ADMIN | shared | `telegramIntelApi.ts` | parity test (masked identifier) | 6 |
| `/accounts` | none | `capital:read` | TRADER only (ADMIN → 404) | private | `userApi.ts` | `adminRestrictions.test.ts` | 1 |
| `/approvals` | none | `decisions:read` | TRADER only | private | `userApi.ts` | `wireShapes`, `adminRestrictions` | 1 |
| `/decisions` | `limit` | `decisions:read` | TRADER only | private, owner-scoped | `userApi.ts` (passes the session principal to the store) | `wireShapes`, `requestRules`, `adminRestrictions` | 1, 4 |
| `/execution/positions` | `status`, `limit` | `positions:read` | TRADER only | private | `userApi.ts` | `adminRestrictions` | 1 |

**ADMIN access to Market, Discovery and Detail is backend-authorised:** `ADMIN` holds every shared permission in `ROLE_PERMS` (mirror proven by `rolesParity.test.ts`), and `opportunityParity.test.ts` ("ADMIN access … granted by the BACKEND") shows an ADMIN session gets 200 on all five shared routes while no session or the service key gets 401. The browser never requests private routes for an ADMIN (Playwright asserts it); a stray request would receive the backend's 404.

**Ownership:** the BFF adds no ownership logic. Owner scoping of `/decisions`, `/approvals` and `/execution/*` is enforced by the backend store keyed on the session principal; this stage relies on, and did not re-test, that store-level SQL isolation (covered by earlier-stage integration tests).

Screenshots (dark and light; 1440, 820, 390, 320 px): `docs/frontend/stage09-3a/screenshots/` (32 PNGs).
