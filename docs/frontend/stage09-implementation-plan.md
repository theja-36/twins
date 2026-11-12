# TWINS Stage 09 — Implementation Plan

Status: PROPOSED (corrected after the Stage 09.0 final review). **Stage 09.1 is COMPLETE with hosted CI green** (commit `ee58650`, run 43113185775; see [contracts-verification](contracts-verification.md)). **Stage 09.2 is IMPLEMENTED LOCALLY, hosted CI not run** — see [foundation](foundation.md); phases 09.3 onward have not started. **No implementation has started.** Each phase below needs its own go-ahead; nothing is committed, pushed, merged or deployed without explicit authorisation. The old frontend repository is read-only throughout.

## 1. Phases

| Phase | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| **09.0 Documentation & mockups** (this set) | 7 docs + 7 mockups + screenshots | – | reviewer sign-off |
| **09.1 Contracts** | `packages/api-contracts` (types/enums **re-declared**, no runtime import of backend packages) + parity tests in the backend `unit` job: catalogue vs Fastify route table, vs `openapi-session.json`, vs `ANALYTICS_ENDPOINTS`; `ROLE_PERMS` mirror; platform and approval error maps; request-rule constants; response schemas vs existing fixtures. Narrows G-51 for `userApi` routes | 09.0 approved | backend CI green (run id); no behaviour change; forbidden-import scan passes |
| **09.2 Frontend foundation** (implemented locally; see foundation.md) | `frontend/` scaffold (Next 15 / React 19 / Tailwind 3.4 / TS strict), design tokens, BFF (hardened), sign-in, shell, role-based nav, 8-state `DataRegion`, availability registry, stub backend from contracts, `frontend` CI job (trial, not yet gating) | 09.1 | frontend CI green on a trial branch; BFF security suite; axe on shell |
| **09.3 DECIDE + CONTROL read screens** | Overview, Approval Center (with approve/reject/cancel/watch), Capital & Risk (read), Paper Trading, Portfolio | 09.2 | Playwright journeys 1–3; axe 0; CI green |
| **09.4 UNDERSTAND + REVIEW** | Opportunities, Opportunity Detail, Research Package, Market Intelligence (with UNAVAILABLE panels), Learning Insights, Decision History, Outcomes | 09.3 | journeys 4, 8; chart table alternatives |
| **09.5 OPERATE + hardening** | Account, System Health (ADMIN), Users & Access (planned page), visual regression, perf budgets, docs, **add `frontend` to `ci-gate`**, README, GAP_REGISTER updates | 09.4 | full suite green; gate wired and proven by a deliberately failing branch; Stage 09 completion record with CI run id |

Between phases: a short review checkpoint and a written status entry (what is verified, what is not).

## 2. Scope boundaries (Decision 3)

In: frontend, docs, browser-safe contracts, non-behaviour-changing contract tests, integration with *existing* endpoints.
Out (needs separate approval): HTTP paper-execution request, order creation, capital write, risk-policy write, PAPER-permission enablement, admin user list/audit viewer/`system:read`, per-user notification inbox, market regime route, session-protected replacements for World B routes, any change to risk/approval/ownership/execution behaviour, live or broker features.

## 3. Dependencies

Chosen per Decision 5 and pinned at 09.2 against the registry. Versions observed in the registry during the audit (for reference; **not** adopted where they conflict with Decision 5): Next 16.4.x (not adopted), React 19.3.x, Tailwind 4.3.x (not adopted; use 3.4.x), TanStack Query 5.107.x, TanStack Table 9.3.x, React Hook Form 7.92.x, Zod 4.6.x, Recharts 3.10.x (use the line compatible with React 19; check peer ranges), Vitest 5.1.x (match the backend's major unless there is a reason), Playwright 1.65.x, axe-core/playwright 4.14.x. Licences: all MIT except Playwright (Apache-2.0) and axe-core (MPL-2.0, dev-only). Not added: Zustand, framer-motion, lightweight-charts, any analytics/SaaS SDK. Each new dependency needs a one-line justification in the PR.

## 4. CI plan

1. Add `frontend` job as a separate job (Node 22; `npm ci --prefix frontend`); run on PRs and pushes touching `frontend/**`, `packages/api-contracts/**`, or the workflow; always also on `main`.
2. Do **not** put it in `ci-gate.needs` until it has passed on the trial branch at least five consecutive runs; then add it, treating "skipped by path filter" as pass.
3. Backend jobs remain unchanged; contract tests live in `tests/unit/contracts/**` and ride the existing `unit` job.
4. Workspace globs are unchanged so `npm run build --workspaces --if-present` does not build `frontend/`.
5. Rollback: removing the `frontend` job and the gate line restores the pre-Stage-09 pipeline.

## 5. Risks & open questions

| # | Risk / question | Impact | Mitigation / decision needed |
|---|---|---|---|
| R1 | World B ADMIN-only enforced solely by BFF role check | a compromised BFF could read platform status (not private trader data) | accepted interim; recommend later session/role-protected backend equivalents (separate approval) |
| R2 | TRADER has little real data in Market Intelligence, Notifications, System Health | thin screens | UNAVAILABLE panels, clear "planned" copy; no fake data |
| R3 | No browser path to request paper execution after approval | approval looks like an end state | explicit copy on Approval Center/Paper Trading; recommend a future, separately authorised execution-request endpoint |
| R4 | Capital/risk read-only | users cannot self-serve | UNAVAILABLE edit affordance; operator does it |
| R5 | All outcome data fixture-backed (G-30) | risk of mistaking for real results | persistent `FIXTURE` badges; `LIVE` badge never rendered until verified |
| R6 | `/auth/me` returns only `role`, no permission list | UI could show regions that then fail | **Resolved without backend change:** mirror the static `ROLE_PERMS` table in `api-contracts` (parity-tested) for UX gating only; the backend stays authoritative |
| R7 | Limit-only pagination | large histories | "Load more" with clear loaded-count; client filters labelled |
| R8 | Old frontend assumptions are stale (registry, "approve in Telegram") | porting mistakes | port only reviewed files; registry rewritten against Stage 04–08 reality |
| R9 | Next 15/Tailwind 3.4 will age | upgrade debt | pinned deliberately; revisit as a separate stage |
| R10 | `__Host-` cookie needs HTTPS and Path=/ | local dev differs from prod | env switch for dev; test on final domain before release |
| R11 | `/intelligence/source`, `POST /intelligence/estimate`, `/risk/decisions/:id/intelligence` are World B (shared key) routes | would expose platform routes to TRADER if wired | **Resolved by exclusion:** not wired anywhere in Stage 09; earlier docs wrongly listed two of them as session routes |
| R12 | Two lockfiles / independent installs | duplicate tooling | accepted for CI isolation |
| R13 | Recharts accessibility | chart-only data | table alternative mandatory |
| R14 | Contract drift between backend and frontend | silent breakage | 09.1 tests are part of backend CI |
| R15 | Hosting provider undecided | CSP, cookie, proxy and secret handling depend on it | architecture target is fixed (single origin, Next 15 standalone behind a TLS reverse proxy, API on a private network; architecture §12); provider and the listed dependent decisions stay OPEN; no deployment in Stage 09 |
| R16 | Login lockout is keyed by **email** (5 failures): anyone can lock a known user out; the lockout response (403 "too many attempts") also differs from wrong-credentials | targeted denial of service on ~10 users; mild enumeration signal | BFF per-IP and per-IP+email throttle, proxy-level IP limit, one neutral UI message; residual risk from distributed sources accepted; any backend change (e.g. IP+email keys) needs separate approval |
| R17 | **ADMIN holds no private permissions** (`ROLE_PERMS`) | an ADMIN-as-super-trader design would be wrong and would 404 | ADMIN screens limited to shared intelligence, platform status and account; ADMIN never gets private screens (tested) |
| R18 | Some response shapes remain unverified after 09.1: decision `explanation`/`stopLossValidation`/`versions`, analytics `data` sections, shared-intelligence bodies, candidate rows, populated risk/order/position rows, System Health fields, planned reward-to-risk source | contract errors | 09.1 resolved the others (login code, analytics envelope placement, capital/portfolio keys, rows returned verbatim); the rest are typed `unknown`/absent and listed with the evidence needed in contracts-verification §4; resolve before the screens that need them |
| R19 | Mixed wire types for money (strings and numbers) | tempting to compute or coerce | display-only rule; schemas encode wire types; lint/test forbids arithmetic |

Review decisions: (a) inventory — 15 screens plus sign-in kept; Portfolio vs Paper Trading overlap flagged (merge optional); (b) visual direction — approved subject to the corrections now applied; (c) 09.1 — awaiting your approval after this correction pass; (d) `/auth/me` — keep the current contract and mirror `ROLE_PERMS` (R6); (e) hosting — architecture target recorded, provider OPEN.

## 6. Definition of done for Stage 09

All screens implemented per [screen-map](screen-map.md); contracts package and drift tests in backend CI green; `frontend` job green and wired into the gate; BFF security suite, axe and Playwright suites green with CI run ids recorded; docs updated to match what was built; gap register updated; no protected file or old-frontend change; unavailable capabilities clearly shown as such; completion recorded only with CI evidence.

## 7. Recommended next step

Review this documentation set and the mockups (`mockups/index.html`), answer decisions (a)–(e), then authorise **09.1 (contracts package and tests only)** — it is small, backend-adjacent, fully testable in existing CI, and removes the biggest integration risk before any UI code exists.
