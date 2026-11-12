# Stage 09.3B.3 — Research Workspace

Status: **IMPLEMENTED LOCALLY. NOT COMMITTED. HOSTED CI NOT RUN.** Baseline `085caf9dd6700c537efbc46c8003b04041ebbb65`. Frontend, relay schemas, contract constants and test-only parity coverage: no backend production code, migration, auth, permission or trading logic changed.

## 1. Screens and routes (all read-only, TRADER and ADMIN)
| Route | What it is |
|---|---|
| `/research` | **Candidate Explorer**: candidates of both origins (Telegram-originated, independently discovered) with lifecycle state, research attempts, data source and found-at; origin and state filters and offset paging are backend parameters kept in the URL; a text box narrows loaded rows only. **No assessment is shown** (the list API does not return one) and **no package is requested per row**. Below it, the **Agent Registry**. |
| `/research/<candidateId>` | **Research Package Workspace**: candidate identity and origin, research status, assessment, halt and reason, synthesis score, package version, stored time, `asOf` only when present, package and input hashes, per-agent reports (table; stacked cards on phones), contradictions, role coverage, missing required agents, evidence index, and a "Not shown here" list. |
| Agent Registry (on `/research`) | 13 agents and 12 roles: name and id, role, required, can block, advisory only, weight, timeout (ms), dependencies, required and optional inputs. Read-only. |

Opportunity Detail now links to the workspace (the link replaces the placeholder that said agent findings were unverified).

## 2. Endpoints (GET, session, shared, `research:read`, ADMIN allowed)
`/opportunities/candidates` (`source`, `state`, `limit`, `offset`), `/opportunities/candidates/:id`, `/research/candidates/:id/package`, `/research/agents`. `/research/packages/:id` has a strict relay schema and tests but no screen (no route needs it).

## 3. Verified fields and how
Verified against REAL orchestrator output through the real handlers (`tests/unit/api-contracts/researchParity.test.ts`, plus the PostgreSQL by-candidate test from 09.3B.1): the package envelope, the 19-key package body (optional `asOf`), the agent report keys, contradictions, role coverage, `grantsApproval: false`, the verdict vocabulary, and the registry (13 agents with 14 keys each, 12 roles, one extra specialist). `/research/packages/:id` returns the same envelope and body as the by-candidate route.

## 4. Relay schemas (`frontend/src/bff/schemas.research.ts`)
Strict: undeclared fields stripped, the whole response refused (neutral 502, no data) on any contract break, `grantsApproval` must be the literal `false`, verdicts must be in the verified set. Wired for `research.package`, `research.packageById`, `research.agents`, replacing the 09.3A schema that stripped the whole package. **`optionsRisk` is deliberately not declared, so it never reaches the browser.** Old behaviour test in `schemas.stage093a.test.ts` was updated: an unverified package body is now refused instead of stripped (the intended change).

## 5. Unknown or unavailable (shown as such, never invented)
Options-risk context (structure unverified); per-agent findings and inputs (only verdict, risk flags, a ≤400-character summary and an input hash are exposed); package history (latest only); **freshness (the API gives none; only the candidate's own state is shown, with a banner for EXPIRED, SUPERSEDED, WITHDRAWN, INVALIDATED)**; assessments in the candidate list. Confidence and score are shown as recorded (null → "Not computed"); their scale is the agent's own and is not interpreted.

**Real-world note.** With no data providers configured (the default), a real run produces `RESEARCH_INCOMPLETE`, halted with `HALT_REQUIRED_AGENT_MISSING`: most agents report UNAVAILABLE with a provider error code and `INCOMPLETE`. The workspace presents this as a normal partial state, with the error code under each agent's status.

## 6. Permissions and isolation
Research is shared intelligence (no owner): both roles hold `research:read`, a session is required (the service key is refused), and nothing private is requested by these pages (a Playwright test asserts an ADMIN session makes no decisions, approvals, execution, account, portfolio, capital, risk or analytics request). Unauthenticated visitors are redirected to sign-in with no request.

## 7. Safety boundaries
Research is evidence, never approval: a permanent banner says so, the overview says "GRANTS NO APPROVAL", an assessment is labelled "evidence, not a decision", verdicts use neutral badges (no colour implies approval), and no approve, reject, order, execute, strategy, risk, capital or sizing control exists (tests assert none). Report text is rendered as inert text (a hostile `<img … onerror>` summary is shown as characters). No browser-side secret; the relay adds the session token server-side.

## 8. Data states
LOADING (skeleton), READY, EMPTY (explorer), ERROR (code and a working Try again; 404 gets its own sentence), DENIED (401/403), UNAVAILABLE (no package yet, with the backend's note; unavailable agents), PARTIAL (incomplete package, with the data shown). STALE is not derivable for research (no freshness field): the inactive-candidate banner is the only age signal and does not claim freshness.

## 9. Tests (local, exact)
- Backend unit: 275 files, 4,293 tests pass (new `researchParity.test.ts`, 4 tests).
- Frontend unit: 23 files, 228 tests pass (new: `schemas.research.test.ts` 9, `research.relay.test.ts` 8, `research.test.tsx` 20).
- Playwright against the built standalone server: 252 passed (new `research.spec.ts` 39 incl. a 24-case table matrix; 24 new accessibility/overflow runs for three research pages × 4 widths × 2 themes; the Insights and 09.3A suites unchanged and passing).
- Typecheck (root and frontend), lint (0 errors; root 854 warnings as before), secret scan, `npm audit --omit=dev` (0 vulnerabilities), production build and standalone preparation pass.
- Not run locally: the full PostgreSQL integration suite (no database in this session), Node 20 locally, hosted CI, screen-reader and full WCAG audit.

## 10. Screenshots (`docs/frontend/stage09-3b3/screenshots/`, 24 PNGs)
Three pages (`trader-research`, `trader-research-workspace` = the REAL incomplete package, `trader-research-rich` = a TEST-ONLY synthetic variant with verdicts, a contradiction and a hostile summary) × 1440/820/390/320 px × dark/light. Review notes are in the stage report; defects found by inspection and fixed: columns pushed off-screen (explorer Open, registry Timeout, reasoning/error code), error code invisible without scrolling at tablet/phone widths, unreadable nine-column table at 320 px (now cards), role lists breaking mid-word (stacked key-value lists), long error codes spilling out of cells.

## 11. Known limitations
Phone pages are long (13 cards); some columns at tablet width still need sideways scrolling; the registry needs scrolling for its last columns at 1440 px; summaries repeat the error code; the explorer cannot sort or show total counts (no such API support); the real-output fixture is synthetic FIXTURE candidates (`e2e/fixtures/research.sample.json`); richer variants in the stub are test-only mutations of it.
