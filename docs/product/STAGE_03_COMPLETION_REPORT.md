# Stage 03 completion report: Telegram intelligence, evidence and strategy learning

Status: **G-19 and the new Stage 03 code are VERIFIED in CI; Stage 03 as a whole is NOT COMPLETE.** Run https://github.com/theja-36/twins/actions/runs/42522586920 on commit 3c4d22c: all 7 jobs succeeded; migration 0042 applied on PostgreSQL 16 (Node 20 and 22); `tests/integration/telegram/stage03.test.ts` executed 19 tests and passed in both integration jobs (confirmed in the job logs); integration 80 files / 1,073 tests; unit 236 files / 3,927 tests; the Stage 01 and Stage 02 suites stayed green. The text below is kept as written before that run.

Original status: **PARTLY IMPLEMENTED, NOT VERIFIED, NOT COMPLETE.** The G-19 pipeline and the missing channel health / timeliness pieces are built and unit-tested (236 files, 3,927 tests pass locally). The PostgreSQL integration test has not run (CI only), and some Stage 03 requirements cannot be completed without data or approvals I do not have. Stage 03 is **not** claimed complete.

## Phase A audit (from the repository, not from earlier reports)
Existing and reused unchanged: capture contracts and revision classification (`telegramRevisions`), the options-claim parser and assessor, `signal-classifier-v1` (signal type, horizon, setup, structure, context), the shared `opportunity_candidates` table (already allowed source TELEGRAM, unique per claim, with a lifecycle guard and audit trigger), the source-agnostic research dispatch, historical import / scorecards / patterns / playbook versioning / drift (Stage 03 code), Stage 01 sessions and Stage 02 ownership. Findings:
- G-19 confirmed open: **nothing converted a stored claim into a candidate** (the table and the dispatcher were ready; the converter was missing).
- The candidate table had no place for timeframe, thesis, missing information, validation status, provenance or version.
- No channel health, no capture-delay measurement, no claim validity window (only decision windows existed).
- No API for channels, claims, classification, candidacy or candidates beyond the legacy service-key lists.
- Real-message classifier accuracy is unmeasured (M02-15) and needs owner-approved data; channel reliability needs resolved real outcomes (G-30).

## What was built
- **G-19 pipeline.** `evaluateTelegramClaim` (pure policy, `telegram-candidacy-v1`) and `runTelegramCandidateCycle` (bounded, idempotent, scoped, kill-switch aware, per-claim isolated). Rules and reason codes are in ADR-019; every refusal is recorded in `telegram_claim_candidacy` (append-only). New candidates are NEW rows in the shared table; the existing dispatch claims them like any other (a test drives the real dispatcher and proves nothing downstream is created).
- **Migration 0042.** Candidate columns (`timeframe`, `thesis`, `missing_information`, `validation_status`, `provenance`, `candidate_version`), the audit table, a trigger that refuses a Telegram candidate without a stored parsed claim, a trigger that freezes thesis / provenance / version, and checks.
- **Channel health and timeliness** (`assessChannelHealth`, capture delay share and median) for M01-10..12.
- **Read API (session-protected, read-only, shared permissions):** `/intelligence/channels`, `/channels/:id`, `/claims`, `/claims/:id`, `/candidates`, `/pipeline`; parsed fields only, channel identifiers masked.
- **Worker:** a timer behind `TWINS_TELEGRAM_CANDIDATES_ENABLED` (default off).
- **Docs:** `TELEGRAM_INTELLIGENCE_ARCHITECTURE.md` (flow and candidate pipeline diagram), ADR-019, change log, gap register (G-19 updated, G-37, G-38), tracker.

## Tests
Unit (run, pass): `tests/unit/telegramCandidates/policy.test.ts` (26: every rule and reason code, determinism, no invention, edits and versions, duplicates, contradictions, validity, delay flags, channel health), `cycle.test.ts` (9: disabled / safety stopped, batching, recording refusals, one failing claim isolated, concurrent worker, in-batch duplicates and contradictions, malformed claim, config), `api.test.ts` (10: sessions required, shared permissions, masking, no raw text, validation, static independence and safety guarantees, migration shape).
Integration (not yet run): `tests/integration/telegram/stage03.test.ts`: real messages, revisions and claims; a good claim becomes one NEW unverified candidate with provenance and an audit row and a rerun changes nothing; noise is never read and the database refuses a forced insert; unstated entry, missing strike and SELL are recorded refusals; expired claims; missing stop / targets stay null; an edit supersedes version 1 with version 2 and audited lifecycle events; both revisions pending yields only the current one; duplicates; contradictions; other channels never interfere; thesis / provenance / version immutability and append-only candidacy; unique per claim and policy version; provenance check; three concurrent cycles; safety stop; batch bound; the real dispatcher claims a TELEGRAM candidate and creates no decision, approval, order or request; an expired candidate is expired and never researched; read model.

## CI history
- Run 42521736607 (c236abd): migration 0042 applied; 5 failures. (1) My candidate-origin trigger fired before the CHECK constraint and changed the error an existing Stage 02 test expects (`origin_check`): the trigger now only judges a claim that exists and leaves a missing claim to the existing check; no existing test was changed. (2) The real classifier reports absences (`level_basis_unclear`, `option_contract_incomplete`) as structure issues; my policy wrongly treated every issue as a contradiction. It now refuses only the four self-contradictions (stop or targets not beyond the entry, targets not ordered, inverted range) and lists absences as missing information; a unit test was added. (3) Provenance now names its claim. (4) Three raw inserts in my test omitted the id (no database default). 
- Run 42522193619 (c2555ac): one failure, a test line still expecting an undefined claim id in the provenance.
- Run 42522586920 (3c4d22c): green. No constraint, trigger, provenance check or idempotency rule was weakened.

## Acceptance criteria (honest status)
1. Ingestion architecture: existing capture, revision and idempotency code reused; hosted Telegram connection remains Stage 10. **Met within internal scope.**
2. Classification and claim extraction: exist; accuracy on real messages **not measured** (M02-15, needs approval and data). **Not fully met.**
3. Evidence provenance: preserved on every candidate and audit row. **VERIFIED in CI** (immutability and the provenance check are exercised).
4. Future-data leakage in historical matching: existing chronological-safe code is reused; no new historical code was written and its real-data behaviour is unproven. **Not re-verified in this pass.**
5. Channel learning minimum-sample safeguards: existing (30 resolved out-of-sample, drift) and unchanged; reliability reported NOT_AVAILABLE until real outcomes exist. **Existing, not extended.**
6. Strategy intelligence versioned and auditable: existing playbook and learning versioning, unchanged; candidate versions added. **Existing plus candidate versioning.**
7. G-19 works: **VERIFIED in CI** (end to end on PostgreSQL: claim, candidate, audit row, supersession, duplicate and contradiction handling, concurrency, shared dispatch claims it, nothing downstream created).
8. Candidates enter shared research dispatch: **VERIFIED in CI** with the real dispatcher.
9. Multi-user isolation: Telegram intelligence is shared platform data by design (ADR-003); the pipeline touches no user table (static tests), the API uses shared permissions and exposes no private data. Per-user isolation of decisions was proved in Stages 01-02.
10. Database integration tests pass: **yes, 19 Stage 03 tests on Node 20 and 22.**
11. Full CI green: **yes (run 42522586920).**
12. Documentation and tracker: updated.

## Remaining gaps
M01-03 (channel enable / disable stays a host allow-list), M01-14 (reliability needs outcomes), M02-01/03..08 and M06-xx / M07-xx items that are IN_PROGRESS because they need real data or measured accuracy; G-37 (entry vocabulary), G-38 (no contract verification); historical matches, channel performance and playbook routes were not added (the code exists, a read API for them is not part of this pass); UI wiring (Stage 09). Hosted AI, live data and production Telegram are Stage 10.

**Decision: Stage 03 is NOT COMPLETE.** G-19 is closed and verified. Still open and not implied by the green CI: G-37, G-38, real-message classifier accuracy (M02-15), real channel reliability and outcome validation, historical future-data-leakage verification, historical / channel-performance / playbook read APIs, Stage 09 UI integration.

## Closure pass (CI-verified for the backend and frontend items listed below)
Status vocabulary: IMPLEMENTED = code and local tests exist; VERIFIED = proven in CI or on real data.
- **Read APIs (IMPLEMENTED):** `GET /intelligence/claims/:id/historical-matches`, `/intelligence/channels/:id/performance`, `/intelligence/playbooks`, `/intelligence/playbooks/:id`, `/intelligence/archive/channels`. Session-authenticated with shared permissions, read-only, bounded limit/offset, masked channel ids, fixed error codes, honest UNAVAILABLE / NOT_AVAILABLE / EMPTY states. Unit tests pass locally; the PostgreSQL integration test `strategyReads.test.ts` is CI-only (no local Postgres) and not yet run.
- **Historical temporal integrity (IMPLEMENTED, unit-tested):** matcher excludes future cases, own-message revisions and duplicates, and demotes outcomes not yet known at decision time to UNRESOLVED (16 deterministic tests). **Limitation:** archive cases are assumed available at message time plus resolution time (import time ignored); archived cases carry no setup/regime, so the default coverage floor yields mostly NO_COMPARABLE_CASES. No real-data leakage guarantee is claimed; the requirement stays open.
- **Playbook integrity (IMPLEMENTED, migration 0043):** immutable content and legal lifecycle enforced in the database; pending CI proof.
- **Adversarial classifier tests (IMPLEMENTED):** absence is not contradiction, real contradictions are refused, nothing invented, no unverified claim becomes a qualified decision. Synthetic only: **real-message accuracy (M02-15) and channel reliability remain NOT VERIFIED.**
- **G-37 / G-38:** documented in the gap register with consumers, tests and required decision/data source; no entry kind changed, no contract data invented.
- **Frontend (IMPLEMENTED, local):** twins-frontend branch `feat/stage03-frontend` (d8bc20b): typed contracts, NEEDS_SESSION registry entries (LIVE shows sign-in required, no login BFF exists), DEMO fixtures, pipeline card, historical-matches card, playbooks and channel-strategy pages. Typecheck, 70 tests, build and bundle check pass. Desktop/mobile visual verification was not performed.

**Decision: Stage 03 remains NOT COMPLETE.**

### Closure CI evidence
- Backend `6951c0a`: run 42527794649 FAILED on two `strategyReads` assertions: a test-helper default parameter turned `undefined` into the session token, so the unauthenticated checks ran authenticated (an application defect was ruled out: unit tests prove 401 without a token, with the shared service key, and with a malformed token). Fix `67dee94` changes only the helper and two call sites; no assertion was weakened.
- Backend `67dee94`: https://github.com/theja-36/twins/actions/runs/42528709453: static, unit Node 20 and 22 (239 files / 3,962 tests each), integration Node 20 and 22 on PostgreSQL 16 + Redis 7 (81 files passed, 2 skipped; 1,086 tests passed, 4 skipped), crash recovery, ci-gate all success. Migration 0043 applied; `strategyReads.test.ts` 13 of 13 passed on both Node versions. The Vitest worker timeout seen once locally under load did not occur in any CI job.
- Frontend: run 42530425464 (`d67ef74`): build job and the new dedicated e2e job green; 21 of 21 Playwright tests passed in 37 s on Chromium 158 (installed in CI), report artifact uploaded. Run 42531055911 (`9abf640`) adds the live-build suite (37 tests).
- Browser verification is of a DEMO build plus a non-demo build with no backend; it does not exercise a real authenticated session (the web app has none) and is not an accessibility certification.

### Requirement states changed in this pass
M07-06 and M06-39 -> VERIFIED (evidence in tracker). M03-03 and M03-06 stay IMPLEMENTED: leakage is unit-tested and the as-of read is integration-tested on synthetic data only. M02-15 stays IN_PROGRESS (needs real labelled messages). M01-14 (channel reliability) stays open (G-30: no resolved real outcomes).

### Open blockers (exact)
| Item | Needs |
|---|---|
| M02-15 classifier accuracy | approved real channel messages with human labels (data + approval) |
| M01-14 / channel reliability | resolved real outcomes linked to live channels (data; Stage 10 integrations) |
| G-37 entry semantics | product decision, see `STAGE_03_G37_DECISION_BRIEF.md` |
| G-38 contract master | approved authoritative instrument master source (data + approval) |
| Historical leakage on real data | real archive import with ingestion timestamps (approval) |
| Frontend LIVE reads | a user login / session BFF in the web app (not in Stage 03 scope) |

## Final acceptance audit (2026-11-09)
Verified state: backend `feat/master-build` 842e21a (CI run 42531280629 green, same totals as 42528709453: 239 unit files / 3,962 tests on Node 20 and 22; 81 integration files passed, 2 skipped, 1,086 tests passed, 4 skipped); frontend `feat/stage09-frontend` 9abf640 (run 42531055911: 70 unit, 37 Playwright). Later local, unpushed work is listed in the handoff.

### Classification of every remaining gap
| ID | Class | Exact reason | Evidence available | Acceptance criteria to close |
|---|---|---|---|---|
| G-37 | OWNER DECISION | "near"/unstated entry semantics | `STAGE_03_G37_DECISION_BRIEF.md`; policy and adversarial tests | owner picks option 1, 2 or 3; then policy version bump, tests |
| G-38 (contract master) | REAL DATA REQUIRED / STAGE 10 | no authoritative instrument master | boundary and tests exist (`options/master.ts`) | approved master imported; contract id, lot, tick, expiry verified by tests |
| G-38 (HTTP contract, as named in this audit) | FIXED | session routes were undocumented | `docs/api/openapi-session.json` + `tests/unit/api/openapiSession.test.ts` (route parity, read-only, errors, freshness) | done; Stage 01 user routes remain undocumented in OpenAPI (see below) |
| M02-15 | REAL DATA REQUIRED | no real labelled messages | protocol in `STAGE_03_VALIDATION_PROTOCOLS.md` | report per protocol |
| M01-14 | REAL DATA REQUIRED / STAGE 10 | no real-price resolved outcomes linked to live channels | protocol doc; funnel API | per protocol |
| G-39 | FIX NOW (done) + OWNER DECISION | scorecard/tier leakage after as-of | `scorecardPointInTime.test.ts`; opt-in `pointInTimeOutcomes` | flip default, update the one integration assertion, CI green |
| G-40 | FIX NOW (not done) | embargo vs horizon | audit only | reproduce in a test first |
| G-41 | needs consumer trace | latest research version | audit only | trace consumers |
| G-42 | OWNER DECISION / STAGE 09 | no web login | backend auth verified in Stage 01 | login BFF decision, then tests |
| Real-data leakage proof | STAGE 11 VALIDATION | needs a real archive | synthetic tests | point-in-time run on an approved real archive |

### Changes in the closure audit (local, unpushed)
Session OpenAPI document and test; point-in-time option for scorecards with 8 unit tests; frontend partial-answer state (commit 7144db8, 72 unit tests, 38 Playwright tests); header title tooltip. Audit by two read-only agents: leakage across learning paths (G-39..G-41) and Stage 04-08 status (`STAGE_ROADMAP_STATUS.md`).

### FINAL STATUS: NOT COMPLETE: EXTERNAL DATA/PROVIDER DEPENDENCY
Primary blockers are real data (M02-15, M01-14, G-38 contract master, real-archive leakage proof). Owner decisions are also required (G-37, G-39 default, G-42). Implementation of everything that can be honestly built without them is done, except G-40 (needs a reproducing test) and G-41 (needs a consumer trace).

