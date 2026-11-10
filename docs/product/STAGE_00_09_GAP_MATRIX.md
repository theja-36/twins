# Stages 00-09: evidence-based gap matrix (read-only audit, then Stage 01 work)

Source of truth: `docs/product/tracker.json` (421 requirements), `GAP_REGISTER.md`, the code on `feat/master-build`, and the frontend on `feat/stage09-frontend` (f4db42c). A stage is COMPLETE only when every in-scope requirement is implemented AND supported by test or inspection evidence. Nothing below is marked COMPLETE on documentation alone.

## Environment limits that decide what can be proven in one session
- No local PostgreSQL (G-11): database behaviour (migrations, RLS, the new 0040 doors, every integration test) is proven only by CI after a push. Pushing needs your approval, so new DB work is IMPLEMENTED but not VERIFIED until then.
- No provider credentials, live data, broker or Telegram production access (Stage 10): requirements that need them cannot be completed and are marked BLOCKED, not faked.
- Order of work: Stage 01 (auth) gates every user-scoped route, so the approval API (G-26), analytics routes (Stage 08), Assisted Live/Controlled Auto (Stage 07) and the frontend login/data wiring (Stage 09) all depend on it.

## Stage classification now

| Stage | Name | Classification | Open requirements | Main dependency |
|---|---|---|---|---|
| 00 | Baseline audit | COMPLETE | 0 | - |
| 01 | Platform foundation (auth, sessions, roles) | INCOMPLETE | 20 | CI proof of the 0040 doors; wiring session auth into every user-scoped route |
| 02 | Database and domain models (per-user isolation) | INCOMPLETE | 0 | Stage 01 sessions; per-user capital/risk/permission services (tables exist) |
| 03 | Telegram intelligence | INCOMPLETE | 30 | G-19 claim to candidate; M01/M02/M06/M07 items; real-message accuracy needs owner-approved data |
| 04 | Research and market intelligence | INCOMPLETE (part BLOCKED on Stage 10) | 1 | A13 mapping; G-15/G-16 need Stage 10 (hosted AI, live regime source) |
| 05 | Independent opportunity engine | INCOMPLETE (part BLOCKED on Stage 10) | 4 | G-16/G-20/G-21 need live data (Stage 10) |
| 06 | Capital, confidence, risk, simulator | INCOMPLETE (part BLOCKED on Stage 10) | 9 | G-22 portfolio source, G-23/G-25 need specs/option-chain data (Stage 10) |
| 07 | Decisions, approvals, execution, monitoring | INCOMPLETE | 14 | Stage 01 + broker adapter interface and test double; Modes B and C |
| 08 | Outcome learning and analytics | INCOMPLETE (part BLOCKED on Stage 10) | 8 | G-30..G-33 need real prices (Stage 10); analytics routes need Stage 01 |
| 09 | Frontend | COMPLETE (frontend, in scope); backend wiring waits on 01-08 | 0 | Backend routes (Stages 01-08) to turn contract-only screens LIVE |

## Done in this session (Stage 01 core)
- `packages/auth`: scrypt password hashing and policy, 256-bit opaque session tokens (only a SHA-256 stored), sliding idle expiry with an absolute maximum, revocation, per-email lockout, generic login failures, password change that signs out other devices, role/active changes with self-change and last-administrator protection, first-admin bootstrap, audit events without secrets.
- Migration 0040 + `scripts/product/append-0040.py` + `app-role.sql`: G-13 closed in code: a privilege trigger and SECURITY DEFINER doors (`twins_create_user`, `twins_set_user_role`, `twins_set_user_active`, `twins_clear_login_failures`) bound to the transaction user; the runtime role loses INSERT and role/active UPDATE on `users`.
- `apps/api/src/authApi.ts`: `/auth/register|login|logout|me|change-password`, `/admin/users`, `/admin/users/:id/role`, `/admin/users/:id/active`; strict bodies (a `role`/`isAdmin`/`isActive` field is refused), session tokens only (the shared API key is never a user).
- Evidence: 34 new unit tests; full unit suite 231 files / 3,857 tests pass; `tsc -b` for the new package and the API; the integration test `tests/integration/auth/stage01.test.ts` exists but has NOT run (needs CI).

## Open requirements (from the tracker)

| Stage | ID | Status | Requirement | Blocker / dependency |
|---|---|---|---|---|
| 01 | P04 | IN_PROGRESS | API contracts | not yet built |
| 01 | P07 | IN_PROGRESS | User isolation | not yet built |
| 01-02 | MU-01 | IN_PROGRESS | Separate account | not yet built |
| 01-02 | MU-03 | IN_PROGRESS | Individual capital | not yet built |
| 01-02 | MU-04 | IN_PROGRESS | Individual available balance | not yet built |
| 01-02 | MU-05 | IN_PROGRESS | Individual risk percentage | not yet built |
| 01-02 | MU-06 | IN_PROGRESS | Individual daily loss limit | not yet built |
| 01-02 | MU-07 | IN_PROGRESS | Individual position limits | not yet built |
| 01-02 | MU-08 | IN_PROGRESS | Individual trading permissions | not yet built |
| 01-02 | MU-09 | IN_PROGRESS | Individual broker connection | not yet built |
| 01-02 | MU-10 | NOT_STARTED | Individual approval settings | not yet built |
| 01-02 | MU-11 | NOT_STARTED | Individual portfolio | not yet built |
| 01-02 | MU-12 | NOT_STARTED | Individual trade history | not yet built |
| 01-02 | MU-13 | NOT_STARTED | Individual analytics | not yet built |
| 01-02 | MU-14 | IN_PROGRESS | Isolation: no user can view another user's private broker details | not yet built |
| 01-02 | MU-15 | IN_PROGRESS | Isolation: no user can access another user's capital | not yet built |
| 01-02 | MU-16 | IN_PROGRESS | Isolation: no user can approve another user's trade | not yet built |
| 01-02 | MU-17 | IN_PROGRESS | Isolation: no user can modify another user's risk settings | not yet built |
| 01-02 | MU-18 | IN_PROGRESS | Isolation: no user can view another user's private trade history | not yet built |
| 01-02 | MU-19 | IN_PROGRESS | Authorisation checks at API, service and database-access boundaries (not fronten | not yet built |
| 03 | M01-03 | NOT_STARTED | Channel management. | not yet built |
| 03 | M01-10 | NOT_STARTED | Delayed signal detection. | not yet built |
| 03 | M01-11 | NOT_STARTED | Signal freshness and validity. | not yet built |
| 03 | M01-12 | NOT_STARTED | Channel health monitoring. | not yet built |
| 03 | M01-14 | NOT_STARTED | Source reliability tracking. | not yet built |
| 03 | M01-23 | NOT_STARTED | Signal type. | not yet built |
| 03 | M01-24 | NOT_STARTED | Intraday, positional, scalping or other strategy classification. | not yet built |
| 03 | M01-25 | NOT_STARTED | Relevant instructions and conditions. | not yet built |
| 03 | M02-01 | IN_PROGRESS | Signal type classification. | not yet built |
| 03 | M02-03 | IN_PROGRESS | Strategy identification. | not yet built |
| 03 | M02-04 | IN_PROGRESS | Breakout classification. | not yet built |
| 03 | M02-05 | IN_PROGRESS | Reversal classification. | not yet built |
| 03 | M02-06 | IN_PROGRESS | Momentum classification. | not yet built |
| 03 | M02-07 | IN_PROGRESS | Gap strategy classification. | not yet built |
| 03 | M02-08 | IN_PROGRESS | Scalping classification. | not yet built |
| 03 | M06-03 | IN_PROGRESS | Identify strike-distance preference. | not yet built |
| 03 | M06-05 | IN_PROGRESS | Identify market conditions used by the channel. | not yet built |
| 03 | M06-07 | IN_PROGRESS | Identify breakout strategies. | not yet built |
| 03 | M06-08 | IN_PROGRESS | Identify reversal strategies. | not yet built |
| 03 | M06-09 | IN_PROGRESS | Identify momentum strategies. | not yet built |
| 03 | M06-10 | IN_PROGRESS | Identify gap strategies. | not yet built |
| 03 | M06-11 | IN_PROGRESS | Identify scalping strategies. | not yet built |
| 03 | M06-19 | IN_PROGRESS | Best market conditions. | not yet built |
| 03 | M06-20 | IN_PROGRESS | Worst market conditions. | not yet built |
| 03 | M06-23 | IN_PROGRESS | Performance by market regime. | not yet built |
| 03 | M06-25 | IN_PROGRESS | Strategy classification. | not yet built |
| 03 | M07-05 | IN_PROGRESS | Evidence chain. | not yet built |
| 03 | M07-07 | IN_PROGRESS | Performance tracking. | not yet built |
| 03 | M07-12 | IN_PROGRESS | Regime-specific performance. | not yet built |
| 03 | M02-15 | IN_PROGRESS | Classifier accuracy measured on real channel messages | owner go to read staging messages for labelling |
| 04 | A13 | NOT_STARTED | options-risk-v1: preserve and map (not in the spec's 12) | not yet built |
| 05 | M16-03 | IN_PROGRESS | Market-regime analysis. | no live regime source (G-16): the worker wires no regime provider, so rankings record the regime as missing |
| 05 | M16-06 | IN_PROGRESS | Macro and calendar analysis. | the scan itself has no calendar/macro provider; both are only reached during research, and no provider data is |
| 05 | M16-07 | IN_PROGRESS | Historical pattern matching. | no historical pattern/outcome provider is wired in the worker, so that agent reports UNAVAILABLE |
| 05 | M16-08 | IN_PROGRESS | Risk-to-reward screening. | targets are R multiples by construction; there is no separate reward:risk screen against structure levels, and |
| 06 | M08-07 | IMPLEMENTED | Trading budget. | no distinct budget concept beyond available capital and the notional cap |
| 06 | M08-09 | IMPLEMENTED | User permissions. | not yet built |
| 06 | M08-10 | IMPLEMENTED | Broker account reference. | not yet built |
| 06 | M08-19 | IMPLEMENTED | Portfolio exposure. | needs a portfolio-state source (G-22) |
| 06 | M08-20 | IMPLEMENTED | Remaining daily risk capacity. | needs a portfolio-state source (G-22) |
| 06 | M09-12 | IN_PROGRESS | Strategy reliability. | no strategy-performance provider is wired; the component reports missing (G-23) |
| 06 | M09-18 | IN_PROGRESS | Historical comparison. | not yet populated on assessments: no resolved outcomes exist (Stage 08) |
| 06 | M10-19 | IMPLEMENTED | Optional research-only Kelly analysis. | not yet built |
| 06 | M11-04 | IMPLEMENTED | Implied-move analysis. | no option-chain / implied-volatility source (G-20); first-order vega shocks exist only when greeks are supplie |
| 07 | M12-28 | IN_PROGRESS | Which historical patterns are comparable. | no separate listing of comparable historical patterns; the historical provider is not wired (G-23) |
| 07 | M13-09 | IN_PROGRESS | Approve / reject / watch actions. | no WATCH action; no user-facing approval API until authentication sessions exist (G-26, Stage 01) |
| 07 | M13-18 | NOT_STARTED | Mode B — Assisted Live: User reviews the proposed order. | not yet built |
| 07 | M13-19 | NOT_STARTED | Mode B — Assisted Live: User explicitly confirms each live order. | not yet built |
| 07 | M13-20 | NOT_STARTED | Mode B — Assisted Live: System rechecks risk and eligibility. | not yet built |
| 07 | M13-21 | NOT_STARTED | Mode B — Assisted Live: Broker adapter executes only after valid authorisation. | not yet built |
| 07 | M13-22 | NOT_STARTED | Mode B — Assisted Live: Order and fill status are reconciled. | not yet built |
| 07 | M13-23 | NOT_STARTED | Mode C — Controlled Auto: Explicitly authorised automation. | not yet built |
| 07 | M13-24 | NOT_STARTED | Mode C — Controlled Auto: Pre-approved strategy and risk policy. | not yet built |
| 07 | M13-25 | NOT_STARTED | Mode C — Controlled Auto: Strict capital and quantity limits. | not yet built |
| 07 | M13-26 | NOT_STARTED | Mode C — Controlled Auto: Kill switches. | not yet built |
| 07 | M13-27 | NOT_STARTED | Mode C — Controlled Auto: Order monitoring. | not yet built |
| 07 | M13-28 | NOT_STARTED | Mode C — Controlled Auto: Emergency stop. | not yet built |
| 07 | M13-29 | NOT_STARTED | Mode C — Controlled Auto: Complete audit trail. | not yet built |
| 08 | M15-01 | IN_PROGRESS | Actual versus predicted results. | no predicted-versus-actual summary view yet beyond calibration bins and the stored fields; no real-price outco |
| 08 | M15-03 | IN_PROGRESS | Channel performance. | Telegram-originated candidates do not exist yet (G-19), so channel outcomes are empty; duplicate and stale ana |
| 08 | M15-04 | IN_PROGRESS | Pattern performance. | comparable-pattern listing missing (G-27); historical provider not wired (G-23) |
| 08 | M15-08 | NOT_STARTED | Entry timing quality. | MAE / MFE and reference prices are not recorded for paper fills; listed as missing on every outcome and as a r |
| 08 | M15-09 | IN_PROGRESS | Stop-loss quality. | no MAE / MFE, so 'was the stop too tight / wide' cannot be judged |
| 08 | M15-10 | IN_PROGRESS | Target quality. | no MFE, so 'was the target too near / far' cannot be judged |
| 08 | M15-12 | IN_PROGRESS | Verdict accuracy. | estimates need later price bars from an OHLC provider; none is wired in the worker (G-20); verdict accuracy is |
| 08 | M15-14 | IN_PROGRESS | Source-confidence adjustment. | automatic adjustment is intentionally not implemented; any change must go through learning_versions with its o |

## Not done, with the exact next action
1. Stage 01: add a `userScoped` route helper (requireSession + ownerScope) and move decisions, approvals, risk, capital, paper and analytics reads behind it (G-26, MU-14..19). Needs the 0040 CI run first.
2. Stage 02: per-user capital / risk / permission services over the existing 0033 tables (MU-03..13, M08-09/10).
3. Stage 07: Mode B (assisted live) and Mode C (controlled auto) internal flows with a test-double broker adapter, all behind the disabled live gate (M13-18..29).
4. Stage 03: G-19 claim-to-candidate and the remaining M01/M02/M06/M07 items.
5. Stage 08: analytics routes from `ANALYTICS_ENDPOINTS` behind the session helper; MAE/MFE capture (G-31).
6. Stage 09: switch the registry entries from NEEDS_SESSION/CONTRACT_ONLY to LEGACY-style reads as each backend route lands; add the login BFF (httpOnly cookie).
7. Approve a push of `feat/master-build` so CI can prove migration 0040 and the integration tests.

BLOCKED until Stage 10 (do not fake): live regime/market data, hosted AI, option chain / implied volatility, production Telegram, real broker, real-price outcomes (G-15, G-16, G-20, G-23, G-25, G-29, G-30, G-32).
