# Stage 09.3B.4 — Strategy & Decisions (read-only)

Four read-only screens on the existing standalone frontend. No backend production code changed.

| Screen | Path | Gate | Data |
|---|---|---|---|
| Decision History | `/decisions` | private (TRADER only; ADMIN is blocked by the screen gate and the backend answers 404) | `GET /decisions?[state=]&limit=200` |
| Decision Detail | `/decisions/[id]` | same | `GET /decisions/:id`; `GET /decisions/:id/comparables` only when the reader asks |
| Playbooks | `/strategies` | shared (`strategies:read`, TRADER and ADMIN) | `GET /intelligence/playbooks?limit=25&offset=` |
| Playbook Detail | `/strategies/[id]` | shared | `GET /intelligence/playbooks/:id` |

Strategy performance is NOT duplicated: Playbooks links to the existing Learning Insights strategy section (fixture-backed, labelled FIXTURE there).

## Rules that shape the screens
- **Latest 200, no paging.** `/decisions` has a limit (1–200) and no offset. History says "latest decisions, up to 200", warns when 200 rows return, and shows no pager. Playbooks use the API's own limit/offset.
- **Outcome ≠ workflow state ≠ approval.** Outcome is an opaque engine verdict string; workflow state is one of PENDING/APPROVED/REJECTED/EXPIRED/SUPERSEDED/CANCELLED; invalidation is separate. Each has its own column or row. No lifecycle state or outcome is invented.
- **Exact decimals.** Permitted size money (`maxLossAtStop`, `riskPerLot`, `grossExposure`) is a decimal string end to end; a numeric value breaks the contract (502). A null size or stop-loss validation is shown as "not recorded", never zero.
- **Unverified JSON never reaches the browser.** A playbook version's `content` and `performance` are not declared in the relay schema and are stripped; the screen says why.
- **`influencesLive`** is displayed as "record flag only; live trading is disabled".
- **Research link** to `/research/[candidateId]` only when the decision's provenance records a research package.
- **Comparables** are optional: not requested until "Load comparables"; AVAILABLE, NOT_AVAILABLE (with reason), AVAILABLE-but-empty, loading and error are distinct.
- **Post-trade outcome** is not implemented: the decision→outcome link is unverified. The detail page says so.
- **Read-only.** No approve/reject/cancel/watch/unwatch, order, strategy edit/activation, risk/capital/sizing control exists; the relay stays GET-only (`WRITES_ENABLED=false`) and tests assert the five decision actions and every write verb never reach the backend.

## Files
- Schemas: `src/bff/schemas.decisions.ts`, `src/bff/schemas.strategies.ts` (wired in `schemas.ts`; `decisions.list` now uses the strict list schema).
- Hooks/types: `src/api/strategyHooks.ts`, `src/api/strategyTypes.ts`.
- Components: `src/components/decisions/{DecisionsScreen,DecisionDetail}.tsx`, `src/components/strategies/{PlaybooksScreen,PlaybookDetail}.tsx`.
- Routes: `src/app/(shell)/decisions/[id]`, `src/app/(shell)/strategies/[id]`; list screens via the catch-all page.
- Navigation: `src/nav/registry.ts` (Decision History enabled; Playbooks added as screen 16 under UNDERSTAND; detail breadcrumbs).
- Tests: `src/bff/schemas.strategies.test.ts`, `src/bff/strategies.relay.test.ts`, `src/components/decisions/strategies.test.tsx`, `e2e/strategies.spec.ts`, additions to `e2e/responsive-a11y.spec.ts`, `src/nav/registry.test.ts`; backend `tests/unit/api-contracts/playbookParity.test.ts` (test only).
- E2E stub: `e2e/stubBackend.mjs` gains shape-faithful, TEST-ONLY synthetic decisions and playbooks (not captured from the real engine; shapes are asserted by `realOutputShapes.test.ts` and `playbookParity.test.ts`).

## Known limitations
- Playbooks are probably empty in production (no production job writes them); the screen is empty-state-first.
- The research package id is not on the decision view; the link relies on `explanation.provenance.researchPackageId`.
- Comparables are flagged `unverified` in the route catalogue.
- Decisions older than the latest 200 are unreachable.
