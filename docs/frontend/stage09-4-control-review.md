# Stage 09.4: Portfolio, Paper Trading, Outcomes & Performance (read-only)

Three read-only TRADER screens on the existing standalone frontend (`frontend/`), plus a linked-activity section on Decision Detail. **Capital & Risk is deliberately NOT built**: it stays a placeholder until the runtime-role / RLS verification and the risk-control hardening design are decided.

| Screen | Path | Gate | Data |
|---|---|---|---|
| Portfolio | `/portfolio` | private (TRADER only; ADMIN is blocked by the screen gate, the backend answers 404) | `GET /portfolio?accountId` |
| Paper Trading | `/paper` | private | `GET /execution/positions?[status]&limit=200`, `GET /execution/orders?[status]&limit=200`, on request `GET /execution/orders/:id/fills` and `GET /execution/positions/:id/events` |
| Outcomes & Performance | `/performance` | private | the existing Learning Insights sections (overview, outcomes, strategies, decisions): `GET /analytics/overview`, `/outcomes`, `/strategies`, `/decisions`, one section per page view |
| Decision Detail (addition) | `/decisions/[id]` | private | on request `GET /execution/orders?decisionId=` and the latest positions |

## Contract basis (real output, not inference)
The relay schemas (`src/bff/schemas.control.ts`) are built from the REAL engine output proved by `tests/integration/api-contracts/paperAndControlShapes.test.ts` (37 assertions against PostgreSQL and the real execution engine). The e2e fixtures (`e2e/fixtures/paper.sample.json`) are that real output with ids re-pointed at the stub account; entries marked "Variant" are TEST-ONLY mutations.

## Rules that shape the screens
- **Exact decimals.** Every money, quantity, price and stop value is a decimal STRING that must match `^-?\d+(\.\d+)?$`; a number or other text refuses the whole response (neutral 502). The scale the backend sent is shown as sent (`4500` and `4500.00000000` are different strings; fill prices keep 16 decimals).
- **Nothing private reaches the browser.** The position `userId`, the position `rules` object (fee schedule and management rules) and every position-event `payload` are not declared in the schema and are stripped. Events show kind and time only.
- **Missing is not zero.** Capital figures that are `null` show "not provided" with an UNAVAILABLE badge; a market order's limit price shows "none (market)"; an open position's `closedAt` shows "not closed". The backend's own `"0"` for an account with no positions is shown as sent.
- **Latest N, never full history.** `/execution/orders` and `/execution/positions` take only `limit` (1 to 200) and a `status` filter: no account filter, no offset, no total. Both lists say "latest rows, up to 200", warn when 200 rows came back, and state that narrowing to the selected account happens in the browser over the loaded rows (with the "X of Y loaded rows" count). They never present that as an account's complete history.
- **No join between orders and positions.** Entry orders carry `positionId: null`; the two lists are separate and linked only through their decision. Positions cannot be filtered by decision on the server, so Decision Detail matches them inside the latest 200 and says so.
- **No decision-to-outcome link.** Outcome rows carry no decision id; none is displayed or implied.
- **Empty lists for foreign or unknown ids** (fills, events) are stated as "can also mean the id is not yours", never as proof that nothing exists.
- **Read-only.** No place, exit, move-stop, cancel, approve, reject, watch, capital or risk control exists; the BFF stays GET-only (`WRITES_ENABLED=false`). Execution, exits and stop changes are shown as UNAVAILABLE.
- **Analytics are per user, not per account** (the backend ignores `accountId`); the Performance screen says so, labels PAPER and FIXTURE, and states that live performance is unavailable.

## Files
- Schemas, hooks, types: `src/bff/schemas.control.ts` (wired in `schemas.ts`; `positions.list` now uses the strict schema), `src/api/controlHooks.ts`, `src/api/controlTypes.ts`.
- Components: `src/components/control/{PortfolioScreen,PaperTradingScreen}.tsx`, `src/components/performance/PerformanceScreen.tsx`; `DecisionDetail.tsx` gains `LinkedPaper`.
- Routes and navigation: catch-all page, `src/nav/registry.ts` (stale `arrivesIn` labels corrected).
- Tests: `src/bff/schemas.control.test.ts`, `src/bff/control.relay.test.ts`, `src/components/control/control.test.tsx`, additions to `src/components/decisions/strategies.test.tsx`, `e2e/control.spec.ts`, additions to `e2e/{responsive-a11y,security,roles}.spec.ts`.
- Test backend: `e2e/stubBackend.mjs` (orders, fills, positions, events and portfolio routes mirroring the real parameter rules) and `e2e/fixtures/paper.sample.json`.

## Known limitations
- Capital & Risk is not built (held behind the runtime-role verification and the hardening design).
- Orders and positions are the latest 200 only; older rows are unreachable from the UI.
- Portfolio capital facts come from a database view that uses the database clock, so a profile that is not yet effective shows `null` there while `/capital/profile` may still list it.
- The event kind vocabulary is only partly known (seven kinds observed); kinds are shown as labelled text, not interpreted.
- Order statuses other than FILLED were not produced by the real scenarios; they are checked only for membership in the declared vocabulary.
