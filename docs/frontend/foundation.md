# TWINS Frontend — Stage 09.2 Implementation Record (Foundation and Design System)

Status: **IMPLEMENTED LOCALLY. Hosted CI NOT run** (nothing committed or pushed; the new `frontend` workflow has therefore never executed on GitHub). Scope: the standalone app, the secure BFF, the sign-in foundation, the design system and the application shell. **No product screen is built**: every screen route renders an honest placeholder (PLANNED, with backend gaps shown as NOT AVAILABLE). Companion: [architecture](architecture.md), [permissions-and-navigation](permissions-and-navigation.md), [contracts-verification](contracts-verification.md).

## 1. What exists

```
frontend/                         standalone app, own package.json + package-lock.json, OUTSIDE the backend workspace globs
  next.config.mjs                 output: standalone, outputFileTracingRoot = repo root, externalDir (for packages/api-contracts), static security headers
  src/middleware.ts               nonce CSP on every response, HSTS (host mode only, read at request time), session-cookie presence redirect (a convenience, not authorization)
  src/bff/                        config, security (tokens, cookies, same-origin, CSRF), csp, throttle, allowlist, upstream, schemas (Zod), respond, handlers
  src/app/api/auth/{login,logout,me}   thin route files over the handlers
  src/app/api/session/[...path]   the allow-listed read relay (GET only)
  src/app/login, (shell)/layout, (shell)/[[...slug]], design-system, not-found
  src/components/                 Shell, AccountSelector, ThemeProvider, Providers (+UserCacheGuard), ScreenFoundation, AccountPanel, AccountsPanel, DesignGallery
  src/ui/                         primitives, badges, state (DataRegion), table, dialog, toast, icons
  src/nav/registry.ts             the role/screen registry (single source for navigation)
  src/state/dataState.ts          deriveState(): the eight data states in one place
  src/lib/format.ts               display formatting by string handling only
  src/styles/desk.css + globals.css   tokens and base components, derived from the approved (axe-verified) mockup stylesheet
  e2e/                            Playwright specs + a stub of the TWINS API (synthetic users, records what it receives)
  scripts/prepare-standalone.mjs  copies static assets next to the standalone server
.github/workflows/frontend.yml    independent frontend CI (not wired into the backend ci-gate)
```
Consumes `packages/api-contracts` by path alias (`@twins/api-contracts` → `../packages/api-contracts/src`). No backend package is imported. Decision 5 stack: Next.js 15.5, React 19, Tailwind CSS 3.4, TypeScript strict, Zod 4, TanStack Query 5, Vitest, Playwright, axe-core. **Not added:** Zustand (URL and React state sufficed), React Hook Form, TanStack Table and Recharts (no screen needs them yet; they arrive with the screens that do).

Root-repository edits (minimal): `eslint.config.js` ignores `frontend/**` (the frontend has its own config and CI job); `tests/unit/api-contracts/contractsBoundary.test.ts` now scans the real frontend (no backend-internal import anywhere; no Node built-in or BFF import in any `"use client"` file). Nothing else outside `frontend/`, `docs/frontend/` and the new workflow.

## 2. BFF security implementation

| Control | Implementation | Test evidence |
|---|---|---|
| Server-side API communication only | `callUpstream` talks to `TWINS_API_BASE_URL` (private network); `connect-src 'self'` stops the browser calling anything else; no `NEXT_PUBLIC_` variable carries the API address | `csp.test`, e2e "loads nothing from another origin" |
| Session cookie | HttpOnly, SameSite=Strict, Path=/, no Domain, Secure + `__Host-` prefix in host mode; expires with the backend's `expiresAt` | `security.test`, `handlers.test`, e2e cookie flags |
| Safe local development | `TWINS_COOKIE_MODE=dev` (plain names, no Secure). **Refused in a production build** unless `TWINS_ALLOW_INSECURE_COOKIES=true` (used only by the e2e run); host mode **requires** an https `TWINS_PUBLIC_ORIGIN` | `config.test` |
| CSRF | double submit: `x-csrf-token` header must equal the readable CSRF cookie (exact 43-char format, constant-time compare), rotated at every sign-in, issued by `/me` if missing | `security.test`, `handlers.test`, e2e "fail closed" |
| Fail-closed same-origin | writes need an `Origin` equal to the public origin (missing, `null`, other scheme/port/look-alike all refused); `Sec-Fetch-Site` other than same-origin refused; dev fallback uses the `Host` header (the framework URL can name a different host) | `security.test`, `handlers.test` |
| Per-route Zod validation | strict request body (`LoginBody`); upstream login/me/accounts responses validated and **stripped** of undeclared fields; a schema failure is a neutral 502, never a partial render. Relay routes without a verified schema pass as "JSON object" only (listed in contracts-verification §4) | `handlers.test` |
| Content-Security-Policy | per-request nonce, `strict-dynamic`, no inline/eval script in production, `frame-ancestors 'none'`, `form-action 'self'`, self-hosted fonts; Zod runs `jitless` in the browser so no CSP violation is produced | `csp.test`, `middleware.test`, e2e "no CSP violation" on 4 pages |
| Security headers | nosniff, X-Frame-Options DENY, Referrer-Policy same-origin, Permissions-Policy, COOP/CORP, HSTS (host mode only, runtime), `no-store` on `/api`, `X-Powered-By` removed | e2e headers test |
| Session expiry and logout | `/me` 401 clears both cookies; the relay clears them on a backend 401; client polls `/me` every 60 s and on 401 drops all cached data and returns to `/login?expired=1`; logout needs CSRF + same-origin, ends the backend session and clears cookies **even when the backend is unreachable** | `handlers.test`, `session.test`, e2e auth |
| Per-user cache isolation | `UserCacheGuard` clears the whole query cache when the user id changes or the session ends | `session.test` |
| Per-IP login throttling | 30 attempts per source per 10 min and 5 failures per source+email; neutral 429 text; bounded memory (10 000 keys); client address taken only from a configured **trusted proxy header** (rightmost entry), otherwise one shared bucket | `throttle.test`, `handlers.test`, e2e lockout |
| No service key, no token in the browser | the BFF never reads the service key; the upstream request carries only `accept`, `content-type`, and `Authorization: Bearer <session token>`; the browser never receives the token; nothing in localStorage/sessionStorage except the theme choice (an ESLint rule forbids browser storage elsewhere) | `handlers.test` (service key set in env, never sent), e2e (stub records every header: no cookie, no key) |
| No unrestricted proxy | the relay accepts only GET and only routes in the catalogue-generated allow-list (method, path shape with UUID ids, exact query keys and safe values); platform routes, auth, admin and **write actions are not relayed in this stage** (`WRITES_ENABLED = false`) | `allowlist.test`, e2e "not a proxy" |
| Login anti-enumeration | wrong credentials and the backend's lockout (403) look identical to the browser | `handlers.test`, e2e |

**Not a security boundary.** The BFF holds the token and filters requests; it does **not** authorise private data. The backend authorises every request (permission, role, ownership, RLS). An ADMIN calling a private route is answered 404 by the backend; the e2e run proves the relay passes that through. No platform (shared service key) route and no administrator-only server module exists in this stage, so the accepted residual risk about BFF-enforced "ADMIN-only" access (docs/frontend/architecture.md §7) is **unchanged and not yet exercised**; it applies when System Health is built in Stage 09.5, and a BFF role check will still not be equivalent to backend authorization.

## 3. Authentication foundation

Sign-in (`/login`), session establishment, logout, expiry handling, protected routes (middleware cookie gate + server-layout verification **with the backend**), and role-separated navigation. The page offers **no** registration, password reset or email verification (the backend has none; registration is closed by default). Change password exists in the backend but its browser screen is not built (PLANNED panel on Account). If the backend is unreachable the signed-in layout says so rather than guessing the user.

## 4. Design system and shell

Components (all from the approved mockup vocabulary): Button (primary/default/ghost/danger), IconButton, Field (real label, linked hint and error), Panel, Banner, PageHead, badges (DecisionStatus, OrderStatus, PositionStatus, Provenance, Availability, Freshness; unknown backend values render "UNKNOWN (x)"), PnlValue (sign **and** arrow, never colour alone), MoneyValue, DataTable (focusable labelled scroll region), Dialog (native `<dialog>`: focus trap, Escape, focus return), Toast (polite/assertive live regions), DataRegion + PlannedPanel for the eight states (LOADING, READY, EMPTY, STALE, ERROR, DENIED, UNAVAILABLE, PARTIAL) derived by one `deriveState()` (404 on a private route means "not available to you"). **LIVE is never rendered as LIVE** (dashed "LIVE · NOT VERIFIED"); FIXTURE is hatched. All money display is string handling; ESLint forbids `parseFloat`/`parseInt`/`Math.*`; no screen computes anything.

Shell: desktop rail (collapses to icon-only at ≤1100 px with **visually hidden labels so links keep their names**), mobile bottom navigation (Desk, Decide, Understand, Control, Review for a TRADER; Platform, Understand, Operate for an ADMIN), topbar (breadcrumbs, account selector for TRADER only, role chip, notifications dialog showing the inbox as NOT AVAILABLE, theme toggle, account link), skip link, safety strip on every page, admin accent and "Administration console" label. The theme is dark-first with a designed light variant; the choice persists in localStorage inside try/catch.

Gallery: `/design-system` renders every component and all eight states; it exists only when `TWINS_ENABLE_DESIGN_GALLERY=true` (development and CI).

## 5. Role navigation (verified by unit and e2e tests)

TRADER sees all private and shared screens and no administration. ADMIN sees only Platform overview, Opportunities, Research, Market Intelligence, Users & Access (planned) and Account; the Overview redirects to Platform overview; every private URL shows "Not available to administrators"; a TRADER opening `/admin/*` sees "Not available to you". Account selection appears for TRADER only (the relay `GET /accounts` through the BFF is the one real data call in this stage).

## 6. Test evidence (local; hosted CI not run)

| Check | Result |
|---|---|
| `npm run typecheck` (frontend) | passes |
| `npm run lint` (frontend; includes no-browser-storage, no-numeric-parsing, no-`any`, no non-null assertions) | passes, 0 warnings |
| Unit and BFF security tests (Vitest 5; 13 files) | **123 passed** |
| Playwright (real Chrome against the production standalone server and the stub API) | **70 passed**: auth/session 9, roles and relay 8, security headers/CSP 4, responsive + accessibility **42** (7 pages × 3 viewports × 2 themes, each asserting no horizontal page scroll and **0 axe violations** under WCAG 2.0/2.1/2.2 A+AA tags **including colour contrast**), layout/keyboard/dialog/theme/gallery 7 |
| `npm run build` (standalone) | passes (fonts fetched from Google Fonts at build time and self-hosted) |
| Production dependency audit | 0 vulnerabilities (Zod and Vitest were upgraded and PostCSS overridden to clear findings) |
| Dev-dependency audit | 7 moderate (typescript-eslint → minimatch ReDoS, tooling only; no fix available) |
| Drift-detection check | three BFF guards deliberately broken (writes relay on, CSRF dropped, origin check weakened): 3 test failures; one mutation (missing-Origin) was an equivalent mutant (equality still refuses it); all restored |
| Backend side after the root edits | root `tsc -b` passes; root lint 0 errors (831 pre-existing warnings, none new); secret scan clean; `tests/unit/api-contracts` + `tests/unit/safety` 304 passed |

Screenshots: `docs/frontend/foundation/screenshots/` (sign-in, trader overview/paper/account/gallery, admin platform, desktop 1440 and phone 390 in dark and light, plus a tablet 820 overview).

## 7. Frontend CI

`.github/workflows/frontend.yml`: a separate workflow (path-filtered to `frontend/**`, `packages/api-contracts/**` and itself), Node 20 and 22, `npm ci` against the frontend lockfile, production audit (fails on high), typecheck, lint, unit tests, build, standalone preparation, Playwright chromium install, e2e. It starts no database or Redis and needs no secret. It is **not** part of `ci-gate`; connecting it is a planned, separately approved step. **Result: not run** (no push).

## 8. Security findings and residual risks

1. **BFF role enforcement (accepted, unchanged):** see §2 — not exercised yet; documented for 09.5.
2. **Login throttle is in memory:** it is per process, resets on restart and is bypassed by a second instance; without a trusted proxy header every client shares one bucket (safe, but one source can throttle everyone). Run one instance or move it to the proxy; the backend's own per-email lockout (verified: anyone can lock a known user out) is unchanged and a distributed attacker can still trigger it.
3. **Cookie lifetime follows the login `expiresAt`:** the backend session slides, but the cookie is not extended, so a user may be asked to sign in earlier than the backend requires (the safe direction).
4. **`__Host-` / HTTPS is untested end to end:** cookie flags and host-mode configuration are unit-tested, but no HTTPS deployment exists. The e2e run uses dev cookie mode over http. Verify on the real domain before release.
5. **CSRF token is not bound to the session** (double submit); acceptable with SameSite=Strict and a fail-closed Origin check; login itself is protected by the Origin check only.
6. **`style-src-attr 'unsafe-inline'`** is allowed for React style attributes; scripts and style elements need the nonce. Removing it means eliminating inline style attributes (a later hardening).
7. **Dynamic rendering:** the nonce CSP makes every page server-rendered on demand (acceptable at ~10 users).
8. **Relay response schemas:** only `/accounts` has a verified schema in this stage; other relayed reads pass as "JSON object" until their screens add schemas (contracts-verification §4).
9. **Dev-tooling advisories** (7 moderate) remain until a patched typescript-eslint is released.
10. **Expiry notice race (low):** if the page's own session probe sees the 401 while the user is navigating, the BFF has already cleared the cookie and the middleware sends them to a plain `/login` without the "Session ended" notice. They are still safely signed out. (A first e2e run exposed this; the test now waits for the probe to settle.)
11. **Not verified:** Node 20 compatibility of the frontend toolchain (CI matrix will show), `next dev`, and behaviour behind a real reverse proxy.

## 9. Backend capabilities missing (shown NOT AVAILABLE, none implemented)

HTTP route to request paper execution after approval; capital and risk-policy writes; per-user notification inbox (the bell opens an UNAVAILABLE panel); market regime/live quotes; unrealised P&L / mark prices / live balance; admin user list and audit viewer; platform-status routes behind session authorization.

## 10. How to run

Install: `cd frontend && npm ci`. Development: copy `.env.example`, set `TWINS_API_BASE_URL`, `npm run dev`. Production-like: `npm run build && npm run prepare:standalone && node .next/standalone/frontend/server.js` with `TWINS_COOKIE_MODE=host`, an https `TWINS_PUBLIC_ORIGIN` and the API on a private address. Tests: `npm run check` (typecheck, lint, unit) and `npm run e2e` (build, standalone, Playwright; set `PW_CHANNEL=chrome` to use an installed Chrome). Hosting provider: undecided; nothing is deployed.
