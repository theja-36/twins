# Stage 03 engineering boundary and acceptance (owner decision: Option A, 2026-11-10)

## Status model (use these exact terms)
- **Stage 03 Engineering:** see the audit below. It is declared **ENGINEERING COMPLETE** only for the scope listed here, with every carry-over row named; nothing is hidden.
- **Stage 03 External Validation: DEFERRED to Stage 10/11.** Deferred is not waived: each item stays open until its evidence exists. No claim is made that Stage 03 has been validated on real data, real prices or a real backend.
- Other words keep their meaning: IMPLEMENTED = code and local tests; TESTED = automated tests pass in CI; VERIFIED = proven against the stated acceptance criterion with linked evidence; BLOCKED / DEFERRED / NOT STARTED as in the roadmap.

## Baseline (verified, not reopened)
Backend `feat/master-build` `1aa2e85`, CI run 42894318636: 7 of 7 jobs; unit 245 files / 4,011 tests (Node 20 and 22); integration 81 files passed, 2 skipped; 1,089 tests passed, 4 skipped (PostgreSQL 16, Redis 7). Frontend `feat/stage09-frontend` `3dcbb6c`, run 42892773857: build, 79 unit, 50 Playwright, bundle check. These are historical results; newer local work is not claimed to have passed CI.

## Engineering acceptance checklist (internal criteria, with evidence)
| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Ingestion architecture reused; hosted Telegram connection is Stage 10 | MET | existing capture/revision code; `STAGE_03_COMPLETION_REPORT.md` |
| 2 | Classification and claim extraction exist, refuse contradictions, never invent values | MET (accuracy deferred, see D1) | `tests/unit/telegramCandidates/{policy,adversarial}.test.ts`; runs 42522586920, 42894318636 |
| 3 | Evidence provenance on every candidate and audit row, immutable | VERIFIED | migration 0042 triggers; `tests/integration/telegram/stage03.test.ts` (19 tests) |
| 4 | Point-in-time safeguards across matcher, scorecards, patterns, research packages | VERIFIED on synthetic data | G-39 run 42686591238; G-40/G-41 run 42894318636; `HISTORICAL_LEAKAGE_VALIDATION_REPORT.md` |
| 5 | Minimum-sample and drift safeguards; reliability reported NOT_AVAILABLE without real outcomes | MET | playbook floor 30; `/intelligence/channels/:id/performance` |
| 6 | Strategy intelligence versioned and auditable | VERIFIED | migration 0043; `strategyReads.test.ts` (13) |
| 7 | G-19 claim-to-candidate pipeline | VERIFIED | run 42522586920 |
| 8 | Candidates enter shared research dispatch | VERIFIED | real dispatcher in `stage03.test.ts` |
| 9 | Isolation: Telegram intelligence is shared platform data; no private data on these routes | VERIFIED | shared permissions; session tests in CI; web login isolation tests (stand-in backend) |
| 10 | Read APIs documented and tested | VERIFIED | `docs/api/openapi-session.json` + `openapiSession.test.ts` |
| 11 | Entry semantics decided (G-37) | DECIDED | option 1; no code change; tests pin it |
| 12 | Frontend screens and login | TESTED | frontend runs 42892773857, 42689637294 |

## Rows still IN_PROGRESS or NOT_STARTED in the tracker (24), classified
| Rows | Why open | Class |
|---|---|---|
| M02-15, M01-14 | need real labelled messages; real-priced outcomes and an approved mapping | EXTERNAL VALIDATION DEFERRED (D1, D5) |
| M02-04..08 (structure-based breakout/reversal/momentum/gap/scalp) | today cue-based only; structure needs real market data | EXTERNAL VALIDATION DEFERRED (D3), feature depth |
| M06-03, M06-05, M06-07..11, M06-19, M06-20, M06-23, M06-25, M07-12 | channel profile and conditional performance exist and are tested; regime-conditioned results need real regimes and real outcomes | EXTERNAL VALIDATION DEFERRED (D3, D5); the regime source is Stage 04 |
| M02-01, M02-03 | futures/equity types are in the vocabulary but the parser is options-only; channel-level strategy identification | feature depth beyond the approved options scope; carried to Stage 10/11 with real channels |
| M07-05, M07-07 | evidence-chain links from playbook to outcome; persistent performance snapshots belong to Stage 08 | carried to Stage 08 |
| M01-03 | channel enable/disable stays a host allow-list by design (intake control is a safety control) | OWNER DECISION: a write route would change a safety control; not built |
These are my classification; the owner confirms it. If any row should instead be built before Stage 03 is called complete, it is engineering work to schedule, not hidden.

## External validation deferred register (open until evidence exists; owner decisions in `STAGE_03_DECISION_PACKAGE.md`, `STAGE_03_OWNER_DECISION_REVIEW_DRAFT.md` (still DRAFT))
| ID | Requirement | Deferred evidence | Stage |
|---|---|---|---|
| M02-15 | classifier accuracy | authorised labelled real messages (D1) | 10/11 |
| M01-14 | channel reliability and attribution | approved mapping, verified real outcomes (D5) | 10/11 |
| G-38 | canonical contract master | authoritative source, licence (D0, D2) | 10 |
| G-30 | real-paper outcome validation | approved real price data (D3) | 10/11 |
| G-32 | historical price evidence for unexecuted decisions | approved historical provider (D3) | 10/11 |
| G-42 | real-backend login verification | HTTPS staging and test accounts (D6) | 11 |
| Leakage proof | real-archive temporal validation | authorised archive and protocol (D7) | 11 |
Not assumed: any licence; that an exchange file is free for automated-trading use; that a broker API is exchange-authoritative; any provider's stated history; that a 300-message pilot proves production accuracy.
