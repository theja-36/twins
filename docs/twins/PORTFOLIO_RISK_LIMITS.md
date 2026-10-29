# Portfolio open-risk and correlation limits - Stage 3 / Task 3

> Decision [D-057](DECISION_LOG.md); requirement [SZ-14](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [POSITION_SIZING.md](POSITION_SIZING.md) and [RISK_DECISIONS.md](RISK_DECISIONS.md). Code: `packages/risk/src/portfolio/` (`engine.ts` pure, `config.ts`, `record.ts`), migration `0016_risk_decision_portfolio_review`.

## 1. What this is - and is not
A **pure portfolio-risk engine** plus a recorder. It evaluates a *sized* risk decision (the candidate) against everything that is already active and appends the outcome as a **new risk-decision version**. It places no order, calls no broker, sends no approval card and creates no executable state.
Not in this task: daily/weekly loss circuit breakers, market/liquidity/event gates, margin, expiry of stale decisions, a position store. `APPROVED_FOR_REVIEW` therefore means *"passed sizing and the portfolio limits"* - the later gates still have to be added before anything is reviewable in earnest (§9).

## 2. Exposure model
Active exposure = the **latest, un-superseded** risk decisions whose stored status is `PENDING` or `APPROVED_FOR_REVIEW` **and that carry a planned maximum loss > 0**, plus open-position exposure from a future `OpenPositionSource`. Rejected, expired and superseded decisions, and decisions without a size, are **not** active. The candidate's own subject (signal / options claim) is excluded, so a re-evaluation never counts itself.
Each exposure (`Exposure`): planned max loss amount, max loss % of capital, market, instrument type, **underlying** (the decision's symbol), direction (`BUY`/`LONG` → LONG, `SELL`/`SHORT` → SHORT), **correlation group**, expiry (and the `underlying|expiry` key). Exposure is **gross**: a long and a short on one underlying both add risk (no netting). Equity, futures and options on the same underlying are the same underlying, hence related exposure.
Interface for later stages: `OpenPositionSource.listOpenExposures(): Promise<ExposureInput[]>` (default: none; no position store exists).

## 3. Correlation groups (configuration, not scattered logic)
`TWINS_PORTFOLIO_CORRELATION_GROUPS="NAME=SYM,SYM;NAME2=SYM"` (default `INDIA_INDEX=NIFTY,BANKNIFTY`; `NONE` = no groups). A symbol may be in one group only; malformed → the loader throws. An underlying in no group is its own group (`UNDERLYING:<SYM>`). Tighter concentration group: same underlying **and** same expiry. All of this lives in `portfolio/config.ts` + `correlationGroupOf()`.

## 4. Limits and defaults (portfolio limits, separate from the 1% per-trade sizing cap and its 5% ceiling)
| Limit | Default | Environment variable |
|---|---|---|
| Total planned risk | 3% of capital | `TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT` (+ optional absolute `..._MAX_TOTAL_RISK_AMOUNT`) |
| Per correlation group | 2% | `..._MAX_GROUP_RISK_PCT` |
| Per underlying | 1.5% | `..._MAX_UNDERLYING_RISK_PCT` |
| Per market | 3% *(implementer default = total)* | `..._MAX_MARKET_RISK_PCT` |
| Per underlying + expiry | 1% *(implementer default)* | `..._MAX_EXPIRY_RISK_PCT` |
| Active decisions | 5 | `..._MAX_ACTIVE` |
| Per correlation group | 3 | `..._MAX_ACTIVE_PER_GROUP` |
| Per underlying | 2 | `..._MAX_ACTIVE_PER_UNDERLYING` |
| Per underlying + expiry | 2 *(implementer default)* | `..._MAX_ACTIVE_PER_EXPIRY` |
Percentages are of the capital the candidate was sized with (override: `opts.capital`). A malformed value throws (no fallback). Sitting exactly on a limit passes; above it fails. The stored evaluation records the limits used.

## 5. Outcomes
`APPROVED_FOR_REVIEW` only if **every** limit passes (reason `portfolio_within_limits`). Otherwise `REJECTED` with the first failing reason by fixed precedence, all failures listed:
`PORTFOLIO_RISK_LIMIT_EXCEEDED` (total risk / absolute cap) › `MARKET_RISK_LIMIT_EXCEEDED` › `CORRELATION_GROUP_LIMIT_EXCEEDED` (group risk or count) › `UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED` (underlying risk or count) › `CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED` (underlying+expiry risk or count) › `MAX_ACTIVE_DECISIONS_EXCEEDED`. The stored reason code is `portfolio_<reason lowercase>`.
Invalid input is **not evaluated**: no/zero planned loss (`portfolio_sizing_missing`), bad capital, missing market/underlying, unknown direction, malformed active exposure.

## 6. Risk-decision integration (append-only)
`evaluatePortfolioRisk(db, decisionId)` runs after a successful sizing (the worker calls it right after a `SIZED` version is recorded). The current version must be a **sizing-PENDING** decision (or an earlier portfolio-evaluated version, for recalculation); the latest stop-loss validation must be `VALID`. It appends version N+1 by `service:portfolio-risk` (`supersedeRiskDecision`, hash-chained), copying the sizing and citing the previous version and the evidence:
* `output_snapshot.portfolio` = outcome, reason, failures, candidate exposure, **limits evaluated, current exposure, proposed exposure, resulting exposure** (total, market, group, underlying, expiry buckets), active-decision count, the active exposures considered, capital, engine/config versions, input hash. `input_snapshot` keeps the full evaluation and the original decision inputs.
* **Idempotent / versioned:** identical inputs return the existing version (also against the version it superseded); changed exposure appends the next version; a portfolio-rejected decision is re-evaluated once headroom exists (REJECTED → APPROVED_FOR_REVIEW as a new version, nothing mutated).
* **Serialized:** evaluations run in one transaction under a transaction-scoped advisory lock, so two candidates cannot both pass against the same headroom.
* **Database rule (migration 0016):** `risk_decisions_sized_review_check` (Task 2) **and** `risk_decisions_portfolio_review_check` - an `APPROVED_FOR_REVIEW` row needs `output_snapshot.portfolio.outcome = 'APPROVED_FOR_REVIEW'` (NULL = not evaluated). `NOT VALID`: enforced for every new row; historical rows are not rewritten.

## 7. Safety behaviour
* Intake runtime controls (kill switch, intake enabled, readable state) are evaluated **first**, before any database access; an unreadable state refuses (`safety_refused`; the worker's intake gate pauses the job without consuming an attempt).
* Refusals that write nothing: `sizing_missing`, `not_evaluable` (e.g. already approved elsewhere, sizing-rejected), `stop_loss_not_valid`, `stop_loss_evidence_missing`, `not_found`, `not_latest_version`. A failing open-position source aborts the evaluation (no partial result).
* Nothing writes orders, fills, positions, legacy decisions or approval cards, and no broker is called (tested, plus source-level architecture tests).

## 8. Examples (capital 1,000,000; defaults: total 30,000, group 20,000, underlying 15,000, expiry 10,000)
| Candidate | Existing active | Result |
|---|---|---|
| RELIANCE 5,000 | none | APPROVED_FOR_REVIEW (0.5% of capital, 1 decision) |
| BANKNIFTY 9,000 | NIFTY 12,000 | REJECTED `CORRELATION_GROUP_LIMIT_EXCEEDED` (21,000 > 20,000, `INDIA_INDEX`) |
| RELIANCE 6,000 | RELIANCE 10,000 | REJECTED `UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED` (16,000 > 15,000) |
| NIFTY option 5,000, exp 30-Dec | NIFTY option 6,000, same expiry | REJECTED `CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED` (11,000 > 10,000); a different expiry passes |
| any 5,000 | three of 9,000 | REJECTED `PORTFOLIO_RISK_LIMIT_EXCEEDED` (32,000 > 30,000) |
| sixth decision | five active | REJECTED `MAX_ACTIVE_DECISIONS_EXCEEDED` |

## 9. Limits and remaining risks
* **No expiry job exists:** a PENDING / APPROVED_FOR_REVIEW decision stays active until something supersedes it, so stale decisions will eventually consume the limits (and 5 active decisions block everything). An expiry/cleanup task is needed before real use.
* A **sized PENDING decision counts as active** immediately (it is the exposure being asked for). If its portfolio evaluation fails to run, it keeps holding headroom; the worker evaluates right after sizing and retries on resume.
* **Approval is not yet meaningful:** circuit breakers, market/liquidity/event gates, margin and source intelligence are later tasks; in practice nothing is sized yet (unknown trust/confidence = 0%), so no decision reaches this stage on real data.
* Underlying = the decision's symbol; derivative symbols are not mapped to their underlying (no instrument-master mapping yet). Gross exposure only; no netting or beta/correlation coefficients - groups are explicit lists.
* The worker's portfolio hook is a thin call after sizing; it is covered by the unit/integration tests of the recorder, not by an end-to-end worker test with a configured capital.
