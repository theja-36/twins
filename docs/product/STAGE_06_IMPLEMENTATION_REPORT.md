# Stage 06 implementation report — Capital, Confidence, Risk, What-if (2026-11-10)

Status: **ENGINEERING IMPLEMENTED — CI PENDING.** Local only: nothing committed or pushed. Not declared ENGINEERING COMPLETE.
Matrix: [STAGE_06_REQUIREMENT_MATRIX.md](STAGE_06_REQUIREMENT_MATRIX.md) (85 rows, re-audited against code and tests). Acceptance: [STAGE_06_TEST_AND_ACCEPTANCE_REPORT.md](STAGE_06_TEST_AND_ACCEPTANCE_REPORT.md).

## What already existed (reused, unchanged in behaviour)
Exact-decimal sizing `position-sizing-v2`, `risk-assessment-v1`, `what-if-simulator-v1`, `cost-model-v1`, versioned specs/fees providers, `packages/confidence`, the shared `evaluateCandidateForAccount` path for Telegram and independent candidates, versioned append-only capital profiles and risk policies, append-only risk control events with database-enforced recovery policy, forced row-level security.

## Changes in this stage
| Item | Change |
|---|---|
| G-46 (new, found by the audit) | `evaluateCandidateForAccount` checked recency and then wrote in separate transactions: concurrent evaluations could store duplicates, and a crash between the risk-assessment and simulation inserts left an assessment without its simulation. New `persistEvaluation` (planningStore) takes a per-(account, candidate) advisory lock, re-checks recency, and inserts both rows in ONE transaction. `evaluate.ts` uses it. No migration. |
| M10-19 Kelly | `kellyAnalysis`: research-only, round-down, minimum 30 resolved outcomes, strict input validation. |
| M11-04 implied move | `impliedMove`: ATM-straddle estimate. Refuses on missing, invalid, stale, future-dated, strike/expiry-mismatched or implausible quotes, and on non-ATM strikes. Labelled estimate, never guaranteed. |
| M08-07 trading budget | Verified, not changed: the budget is the account's available capital; committed capital (total − available) never enlarges a limit; `maxPositionNotionalPct` is a percent of available and only narrows. Proven by new `capitalSemantics.test.ts`. |
| Tracker/gap | M08-07/09/10/19/20, M10-19, M11-04 → IMPLEMENTED with evidence; M09-12, M09-18 stay IN_PROGRESS (external data). G-46 added; G-25 text corrected. |

## Boundaries preserved
No order placement, approval or execution; PAPER remains the only mode; the analyses are not imported by any sizing/risk/eligibility source (enforced by a source-scan test); no migration, no API change.

## External dependencies (explicit, not waived)
G-16 live regime; G-20 live market data; G-22 LIVE portfolio source (PAPER half done in Stage 07); G-23 official specs/fees, quotes, strategy-performance data; G-24 calibration (needs Stage 08 outcomes); G-25 margin model and live option chain; Stage 08 outcome data (M09-18, Kelly inputs).
