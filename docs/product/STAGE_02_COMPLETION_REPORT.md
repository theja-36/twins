# Stage 02 completion report: database architecture and domain model

Status: **IMPLEMENTED, NOT YET VERIFIED.** All code, migration 0041 and the tests exist and the unit suite passes locally (233 files). The PostgreSQL integration tests (`tests/integration/database/stage02.test.ts`) run only in CI; they have not run, so nothing below is VERIFIED and G-34 stays open.

## Phase A audit (what was found, from the code, migrations 0000-0040)
Already correct and reused (no rebuild): 119 tables; every master-build table owner-keyed with composite `(account_id, user_id) -> accounts(id, user_id)` keys; forced owner-only RLS on 21 of 24 user tables; the whole lifecycle guard set (decision guard v2, approval door, execution request / paper order / fill / position guards, append-only triggers, live modes refused by constraint); exact `numeric` money everywhere (no float or integer money column found in 119 tables); all timestamps `timestamptz`; SECURITY DEFINER doors; Stage 01 role protection.
Defects and gaps found:
1. `accounts` and `broker_connections` carried `user_id` but had **no RLS** (`user_sessions` too; that one is a documented exception).
2. `accounts.broker_connection_id` could point at **another user's** broker connection (no composite owner key).
3. `broker_connections` had no way to hold a credential reference safely (no `credential_ref`, no format rule).
4. A decision's linked risk assessment and simulation were pinned to the same user (0033) but not to the same **account and candidate**, and only QUALIFIED decisions were checked.
5. Legacy account-owned tables (`orders`, `fills`, `positions`, `portfolio_snapshots`) had no owner protection at all.
6. No database-side proof that a position's quantity agrees with its fills; no per-account portfolio view (allocated capital, open exposure).
7. No catalog-level guard that a future user table cannot be added without RLS.

## Phase B-F: what changed (migration 0041, forward-only)
- RLS (enabled and forced, owner-only) on `accounts` and `broker_connections`; cross-user listing for the worker and scheduler replaced by two identifier-only SECURITY DEFINER functions (the two store functions were re-pointed).
- `accounts_broker_owner_fk` (composite), `broker_connections.credential_ref` with the `secretref:<name>` check.
- Account-join RLS on the four legacy tables.
- `user_decisions_links_guard` (same user, account and candidate, for every outcome).
- Views `account_portfolio_facts` and `paper_position_fill_check` (security-invoker, exact decimals); `getAccountPortfolioFacts` store function and `GET /portfolio?accountId` (session-protected, owner-only; paper notional at entry price, null capital when no profile; no live balance, margin not modelled).
- app-role.sql: EXECUTE on the two listing functions.
- Documentation: `DATABASE_ARCHITECTURE.md` (ownership model, domain map, lifecycle diagram), ADR-018, DATABASE_CHANGE_LOG, gap register (G-34..G-36), tracker.

## Tests written (CI-only unless stated)
Unit (run, pass): `tests/unit/database/stage02Migration.test.ts` (7). `tests/unit/api/userApi.test.ts` now also covers `/portfolio` (18).
Integration (not yet run): `tests/integration/database/stage02.test.ts` covers migration chain equals the repository chain; **catalog scan: every table with `user_id` is RLS-enabled and forced except `user_sessions`**; account-owned legacy tables protected; user A cannot read / update / delete / create / re-own rows of user B's account or broker connection; cross-user broker connection refused; credential reference format; capital profile / execution permission for another user's account refused (FK and RLS); composite owner key present on every account-owned table; live modes cannot be enabled; decision link guard (another user's and another candidate's risk assessment refused); a full paper trade leaves one owner-pure chain; position quantity equals entry minus exit fills for open, partly exited and closed positions; portfolio facts exact and null without a profile; an unapproved decision cannot produce an order, position or APPROVED state; **global scans over every row any integration test created** (approved decision without approval, order without approval, position without filled entry, fills versus filled quantity, cross-user order / position, non-PAPER rows, un-refused live requests, FILLED/PARTIALLY_FILLED consistency, QUALIFIED without VALID stop); several fills per order with exact weighted average (0.17, not 0.17000000000000003); two simultaneous fills (exactly one succeeds); fills on cancelled orders and invalid fills refused; two simultaneous approvals (one record); two simultaneous identical execution requests (one order, one position); live-mode requests refused; approvals / fills / position events cannot be changed, deleted or truncated even by the owner role; no float or integer money column; numeric arithmetic exact; no timestamp without time zone.

## Local results
`tsc -b` clean for database, auth and api; ESLint 0 errors; unit suite 233 files pass (including the updated migration-count assertions, 41 -> 42, with no assertion weakened).

## Requirements
MU-01, MU-03..09, MU-11..13 set to IMPLEMENTED with evidence; none VERIFIED. MU-10 (per-user approval settings) NOT_STARTED: no table exists and it belongs with Controlled Auto (Stage 07, G-36).

## Remaining gaps and risks
- **CI has not run on 0041.** Risks I expect CI to find, since the SQL was written without a database to run it against: view column names, the legacy-table policies, and the new integration tests' assumptions about helper behaviour. Any fix will be reported, never papered over.
- User-facing WRITE endpoints for capital, risk policy and execution permissions do not exist (owner-run stores only); broker connections have no API (Stage 10).
- `user_sessions` has no RLS by design (G-35).
- No live portfolio, margin or market data source (G-22, G-25, G-20): shown as unavailable.
- Assisted Live and Controlled Auto remain disabled by constraint and absent as flows (Stage 07).
- Stage 02 is **not** claimed COMPLETE: verification requires the CI run.
