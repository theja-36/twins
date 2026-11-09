# Stage 03 external-dependency closure plan

Status today: **NOT COMPLETE: EXTERNAL DATA/PROVIDER DEPENDENCY.** Everything that can be built and proven without real data, a provider or a new owner decision is done and CI-verified (see `STAGE_03_COMPLETION_REPORT.md`). Nothing below starts without the approvals named. No real data is read, no production account is connected and no live trading is enabled by this plan.

## What remains, in the order I recommend

| # | Requirement | Kind | What is missing | Approval needed first | Closes when |
|---|---|---|---|---|---|
| 1 | G-40 embargo vs horizon, G-41 research-package version | CODE (no data) | a reproducing test (G-40); a consumer trace (G-41) | none | G-40: a failing test, then a fix, then green CI; G-41: consumers traced, hindsight use fixed or ruled out |
| 2 | G-38 contract master | DATA + STAGE 10 | an authoritative instrument master (contract id, expiry, lot size, tick size) | the data source and any licence/cost | master imported through the existing `options/master.ts` boundary; every candidate's `contractVerification` becomes verifiable; tests prove lookups, mismatches and unknown contracts are refused; nothing defaulted |
| 3 | M02-15 classifier accuracy | REAL DATA + HUMAN LABELS | real channel messages, labelled by at least two reviewers | permission to read specific real channels; where the text may live (outside the repo) | the report in `STAGE_03_VALIDATION_PROTOCOLS.md` exists for a named dataset and parser version: per-field precision/recall/F1, confusion matrix, 0 invented values, every labelled contradiction refused, at least 200 labelled claims |
| 4 | Real-price outcomes (G-30, G-32) | STAGE 10 | a historical or live price source for the claimed instruments | provider choice and budget | resolved outcomes carry real prices and resolution times |
| 5 | M01-14 channel reliability; real-archive leakage proof | REAL DATA + STAGE 10/11 | live-channel to archive-label mapping; at least 30 resolved out-of-sample outcomes per channel on real prices (the playbook activation floor) | owner approves the mapping and the archive import | reliability computed point-in-time (G-39 is already in force), with intervals, drift and limitations; leakage tests re-run on the real archive |
| 6 | Real-backend login check (G-42) | ENVIRONMENT | a staging backend reachable from CI or an operator run | access to a staging backend and a test account | the web login, logout, expiry and revocation pass against the real backend, not the test stand-in; HTTPS cookie flags confirmed |

## Sequencing and dependencies
- Item 1 needs nothing from you and can run immediately.
- Items 2 and 4 are provider decisions (Stage 10) and gate item 5. Item 3 is independent of them and can run first once data access is approved.
- Item 5 needs 2, 4 and the real archive. It is the last Stage 03 gate.
- Item 6 can run as soon as a staging backend exists.

## Decisions and approvals I need from you
1. **Data access for M02-15:** which channels, how many messages and date range, who labels them, and where the text is stored. I recommend starting with a small pilot (about 300 messages) to size the labelling effort before any full run.
2. **Instrument master source for G-38:** a licensed or exchange-published file, who owns the licence, and any cost.
3. **Price source for G-30/G-32:** historical first (cheaper and repeatable), live later.
4. **Mapping archive labels to live channels (M01-14):** who confirms it.
5. **Staging backend for item 6.**

## Rules that stay in force
No real Telegram, user or broker data is imported and no production credential is used without your explicit approval for that specific step; LLM output stays an untrusted input; live trading and broker execution stay disabled; no existing test, constraint or security control is weakened to close a gap; Stage 04 and Stage 10 implementation does not start under this plan.

## Not Stage 03 (tracked elsewhere)
Stage 04-08 verification against real data (Stage 11); live trading modes, approval settings table and live price feed (Stages 07/10); remaining Stage 09 screens' non-demo coverage and a manual screen-reader review.
