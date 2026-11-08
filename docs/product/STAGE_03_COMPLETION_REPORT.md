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
