# TWINS Frontend — Testing and Accessibility

Status: PROPOSED (corrected after the Stage 09.0 final review). Nothing below is claimed as passing for the new app (it does not exist). Evidence recorded so far: the mockups passed axe-core in 32 page/theme/width combinations with 0 violations; the old frontend's 79 unit + 50 Playwright tests are a reference for what to port, not evidence for the new code.

## 1. Test pyramid

| Layer | Tool | Scope | Runs in |
|---|---|---|---|
| Static | `tsc --noEmit`, ESLint (+ custom rules) | types, forbidden imports, `no-number-money`, no `fetch` outside `api/` | frontend CI job |
| Unit | Vitest | formatters (money/time), decimal helpers, data-state mapper, availability registry, BFF helpers (token regex, CSRF, same-origin, allow-list) | frontend job |
| Component | Vitest + Testing Library + axe | each primitive/domain component in all states and both themes | frontend job |
| Route handler | Vitest | BFF routes against a mocked upstream: cookie flags, CSRF, 401 clears, relay allow-list, header stripping | frontend job |
| Contract | Vitest | catalogue vs live Fastify route table; Zod schemas vs backend responses; constants parity; forbidden-import scan | **backend `unit` job** (needs backend source only) |
| End-to-end | Playwright | journeys against a stub backend generated from contracts | frontend job |
| Accessibility | @axe-core/playwright | every screen × state × theme × {1440, 820, 390} | frontend job |
| Visual regression | Playwright screenshots | key screens, dark+light, masked timestamps | frontend job (optional gate, see §8) |
| Bundle | script | no fixtures, no service-key strings, no World B paths in TRADER chunks | frontend job |

## 2. Security tests (BFF)

Ported from the reviewed old suites and extended: session cookie is `HttpOnly; Secure; SameSite=Strict; Path=/` with `__Host-` prefix; malformed token treated as no session; CSRF required on every non-GET and compared safely; missing `Origin` on a write is **refused** (hardening); relay refuses non-allow-listed method/path/query keys without contacting upstream; 401 from upstream clears cookies; responses are `no-store`; per-user cache purge on logout and user switch; shared service key absent from every browser-reachable response and bundle; TRADER receives 403 from every World B BFF path; unknown request-body fields rejected.

## 3. Contract tests (no behaviour change)

0. **Seeds:** the catalogue is seeded from `docs/api/openapi-session.json` and `ANALYTICS_ENDPOINTS`; the existing `tests/unit/api/openapiSession.test.ts` keeps guarding the former.
1. **Import guard:** `frontend/` and `packages/api-contracts/` import nothing from database/planning/execution/decision/auth/outcomes-runtime or Node built-ins.
2. **Catalogue vs server:** build the Fastify app with fakes, list routes, diff against the catalogue (method, path, permission). Unlisted session routes must appear on an explicit exclusion list with a reason.
3. **Response drift:** parse existing backend integration/unit-test responses with contract schemas; unknown or missing keys fail.
4. **Constants parity:** permission lists, `ROLE_PERMS` (TRADER = shared + private; ADMIN = shared + admin), the platform error-code→HTTP map **and the approval-error map (`APPROVAL_HTTP`: NOT_FOUND, NOT_PENDING, NOT_QUALIFIED, EXPIRED, REVALIDATION_FAILED→INVALIDATED, ALREADY_ACTIONED, NOT_PERMITTED)**, request-rule constants (idempotency-key pattern, reason lengths), and decision/order/position enums equal backend sources.
5. **Money and numbers:** schemas encode the verified wire types — decimal-string fields accept only `^-?\d+(\.\d+)?$`; number-typed fields (candidate prices, `lots`, `quantity`, `sizeMultiplier`, `openPositions`) accept numbers; a lint/test forbids arithmetic on both in frontend code.

These tests only read code and fixtures; they cannot alter risk, ownership, approval or execution behaviour, and they add no runtime dependency to the backend.

**Implemented in Stage 09.1** (backend `unit` job, 9 files, 70 tests): import/browser-safety guard, role parity, error parity (platform + approval + login), route-table/OpenAPI/analytics catalogue parity, request-rule behaviour, response-key parity, analytics envelope, vocabulary parity, ADMIN restrictions. Registered in [contracts-verification](contracts-verification.md).

**Implemented in Stage 09.2** (frontend, local evidence; hosted CI not run): 123 Vitest tests (BFF security, configuration, CSP, middleware, throttle, allow-list, navigation registry, formatting, data states, components with axe, shell by role, session expiry and cache isolation) and 70 Playwright tests (auth/session, roles and relay, headers/CSP, responsive + accessibility matrix with 0 axe violations including contrast, keyboard, dialog, theme). See [foundation](foundation.md) §6.

## 4. Unit/component acceptance examples

- `formatMoney("1100920.00") === "₹ 11,00,920.00"`; `formatMoney("-310.5")` → `−₹ 310.50`; input never passes through `Number`.
- `DataRegion` renders exactly the markup for each of the eight states and exposes `aria-busy` while LOADING.
- `ApprovalCard` shows no Approve button when `action.available` is false, regardless of local state.
- Unknown enum value renders neutral "UNKNOWN (x)" badge.

## 5. End-to-end journeys (Playwright, stub backend)

1. Sign-in: failure and lockout both give one neutral message; success redirects to the intended path; sign-out clears state; BFF per-IP throttle returns a neutral response after N attempts.
2. Approve with confirmation; double-click sends one request (same body `idempotencyKey`); stub returns each approval error (NOT_PENDING 409, NOT_QUALIFIED 422, EXPIRED 409, REVALIDATION_FAILED 409 with failed-check `reasons`, ALREADY_ACTIONED 409, NOT_PERMITTED 403) and the matching panel appears; expired decision has no actions.
3. Reject with and without a reason (optional); cancel requires 5–300 characters and sends no key; watch/unwatch need `decisions:watch`.
4. Each screen with stub states LOADING (delayed), EMPTY, STALE (freshness flag), ERROR (500), DENIED (403), UNAVAILABLE (503), PARTIAL (mixed).
5. TRADER hitting `/admin/system` → DENIED; ADMIN sees health; **ADMIN session (stub with ADMIN role and 404 on private routes) never renders any private screen or nav item, and a direct private URL shows "Not available to administrators"**; TRADER bundle contains no World B strings. Account selection: one account auto-selected; several shows the switcher; `accountId` is sent on `/capital/profile`, `/risk/policy`, `/portfolio`.
6. Session expiry mid-use → 401 → sign-in, caches cleared.
7. Offline/slow network: retry affordances; no duplicate mutation.
8. Analytics: dataset toggle (overview only), STALE banner, table view of every chart.

## 6. Accessibility

Target WCAG 2.2 AA.

Automated: axe on every route/state/theme/width, failing on any violation (no allow-list without a written reason). Includes `color-contrast`, `scrollable-region-focusable`, `aria-*`, `landmark-*`.
Manual checklist per release: keyboard-only run of every journey; visible focus; focus order after dialogs open/close (returns to trigger); screen-reader pass (VoiceOver + one other) on Approval Center, Paper Trading and a chart; 200% zoom and 320 px reflow; `prefers-reduced-motion`; forced-colors sanity; touch target sizes.
Specific rules: status never by colour alone; P&L has sign+arrow; dialogs trap focus and close on Esc; toasts in `role="status"`, errors in `role="alert"` sparingly; tables have header associations and captions; charts have text/table alternatives and no tooltip-only data; live-updating regions announce politely and do not steal focus; language attribute set; page titles per route.

## 7. Test data

Fixtures are synthetic, labelled `FIXTURE`, dated in a fixed fictional year, generated from contracts so the stub cannot drift. Production builds exclude them (bundle test). No real tickers' prices or user data. Financial values in fixtures are internally consistent (sums verified by a fixture self-test).

## 8. CI wiring and gates

Frontend job (see architecture §10): typecheck → lint → unit/component → route handler → `next build` → bundle checks → Playwright (functional + axe) → artifacts (traces, screenshots on failure). Visual-regression is introduced as non-blocking first and promoted after two weeks of stability. The job caches `~/.npm` keyed by `frontend/package-lock.json`. Browsers are installed with `npx playwright install --with-deps chromium`.

Release rule: a phase is "complete" only with CI evidence (run id) for the commit, mirroring Stages 07–08. Local-only passes are reported as local.

## 9. Known verification gaps (honest list)

- Real-browser behaviour of `__Host-` cookies over the final deployment domain/TLS is untested until a deployment target exists.
- Screen-reader testing is manual and not automatable in CI.
- Contract drift tests cover backend fixtures, not a running production backend.
- Performance budgets (LCP, bundle size) are proposed in the plan but unmeasured.
- The wrong-credentials error code, the placement of `snapshot`/`freshness` in analytics responses, the inner shapes of capital/risk responses and the System Health fields are **not yet verified**; the 09.1 response-drift test is where they get confirmed.
- Mockup axe evidence after the review corrections: 32 page/theme/width runs, 0 violations; no page-level horizontal overflow at 390 or 820 px (the only wider element is the intentionally scrollable, focusable table region on Paper Trading at 390 px).
