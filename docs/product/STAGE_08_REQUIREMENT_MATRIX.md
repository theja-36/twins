# Stage 08 — requirement matrix (Module 15, Outcome Learning & Performance Analytics)

Method: the 21 existing Module 15 rows were re-audited against the code and tests at the `a8e4ff5` baseline (hosted CI run 43073284600 green); six rows were added for the audited gaps. "Baseline audit" is the classification from the Stage 08 baseline audit; "Status" is the tracker status now. A row is never marked VERIFIED without test evidence, and rows that depend on data that does not exist yet stay IN_PROGRESS or NOT_STARTED with the dependency stated.

| ID | Requirement | Baseline audit | Status | Packages | This stage |
|---|---|---|---|---|---|
| M15-01 | Actual versus predicted results. | PARTIAL | IN_PROGRESS | attribution.ts, metrics.ts, 0039_outcome_learning.sql | R-multiple now stored and averaged unrounded; a predicted-versus-actual summary view is still missing; real-price outcomes absent (G-30) |
| M15-02 | Outcome reasons. | REUSED | IMPLEMENTED | attribution.ts, metrics.ts | unchanged |
| M15-03 | Channel performance. | PARTIAL (external) | IN_PROGRESS | funnel.ts, insights.ts | stale blocker text corrected (G-19 is closed); channel outcomes need executed Telegram candidates |
| M15-04 | Pattern performance. | PARTIAL (external) | IN_PROGRESS | metrics.ts, agents.ts | the signal-pattern view is now an explicit NOT_AVAILABLE (needs the G-23 provider); setup class remains |
| M15-05 | Strategy performance. | REUSED | IMPLEMENTED | metrics.ts, analytics.ts | extended: loss rate, exact-decimal ratios, unrounded R, t interval, new segmentation (M15-25, M15-26) |
| M15-06 | Confidence calibration. | REUSED | IMPLEMENTED | calibration.ts, cycle.ts | unchanged: the Stage 06 procedure, 200 out-of-sample floor and 30-outcome floor are preserved (tests/unit/outcomes/integrity.test.ts, 12) |
| M15-07 | Agent contribution. | REUSED | IMPLEMENTED | agents.ts | unchanged |
| M15-08 | Entry timing quality. | MISSING (external) | NOT_STARTED | insights.ts | unchanged: needs MAE/MFE (G-31); recorded as a gap, never guessed |
| M15-09 | Stop-loss quality. | PARTIAL (external) | IN_PROGRESS | metrics.ts, attribution.ts | unchanged (G-31) |
| M15-10 | Target quality. | PARTIAL (external) | IN_PROGRESS | metrics.ts, attribution.ts | unchanged (G-31) |
| M15-11 | Exit quality. | REUSED | IMPLEMENTED | metrics.ts, insights.ts | unchanged |
| M15-12 | Verdict accuracy. | PARTIAL (external) | IN_PROGRESS | decisionQuality.ts | unchanged (G-32); the unreachable OHLC hook was removed from the learning cycle |
| M15-13 | Strategy attribution. | REUSED | IMPLEMENTED | attribution.ts, 0039_outcome_learning.sql | stale blocker text corrected |
| M15-14 | Source-confidence adjustment. | PARTIAL (by design) | IN_PROGRESS | insights.ts, drift.ts | unchanged: REVIEW recommendations only; no automatic adjustment exists or may exist |
| M15-15 | Historical performance trends. | REUSED | IMPLEMENTED | drift.ts | unchanged (drift monitoring, Stage 03 detector) |
| M15-16 | Outcome data foundation: outcome_attributions (owner-tied, append-only, RLS, paper-only, PARTIAL / FINAL, versions with… | REUSED | IMPLEMENTED | attribution.ts, 0039_outcome_learning.sql | hardened by A1: unique trade outcome per position, attribution writers serialised, R at 8 places |
| M15-17 | Statistical integrity: minimum sample floors that cannot be lowered, reliability grading, fixture exclusion from valida… | REUSED | IMPLEMENTED | metrics.ts, calibration.ts, config.ts | floors unchanged; metric integrity extended (M15-25) |
| M15-18 | Learning insights: reproducible, evidence-linked, versioned, append-only; recommendations limited to REVIEW; no path to… | REUSED | IMPLEMENTED | insights.ts, 0039_outcome_learning.sql | unchanged; insights now derive from the same consistent read as the stored snapshot |
| M15-19 | Learning cycle: one bounded, leased, restartable job (ingest, attribute, analyse, drift, insights, reconcile, calibrati… | REUSED | IMPLEMENTED | cycle.ts, index.ts | extended: one consistent read per user, stores a snapshot, reports closedWithoutFinal |
| M15-20 | Analytics API contracts: typed envelope, 11 owner-scoped endpoints requiring a session and analytics:read; no route reg… | REUSED | IMPLEMENTED | contracts.ts | extended: served from stored snapshots with freshness, dimension and dataset applied; stale text corrected |
| M15-21 | Funnels: Telegram-originated and independent pipelines reported separately with explicit numerators and denominators | REUSED | IMPLEMENTED | funnel.ts | stale note corrected (G-19 is closed) |
| M15-22 | Durable close-to-outcome (A1, G-49): a paper position is never CLOSED without its trade outcome (written in the SAME tr… | NEW (audit A1) | IMPLEMENTED | execute.ts, monitor.ts, executionStore.ts, outcomeStore.ts, 0046_outc… | closed positions always have exactly one outcome and one FINAL attribution |
| M15-23 | Reproducible analytics snapshots (A2): every input read in one REPEATABLE READ read-only transaction; deterministic rep… | NEW (audit A2) | IMPLEMENTED | snapshot.ts, cycle.ts, userOps.ts, userApi.ts, outcomeStore.ts | reproducible, immutable, owner-scoped analytics snapshots |
| M15-24 | One authoritative learning configuration (A3): the API and the worker both load loadOutcomeLearningConfig (strict, floo… | NEW (audit A3) | IMPLEMENTED | config.ts, userOps.ts | one authoritative configuration for the API and the worker |
| M15-25 | Metric integrity: explicit win rate and loss rate with Wilson intervals; exact-decimal payoff ratio and profit factor; … | NEW (audit B) | IMPLEMENTED | metrics.ts, attribution.ts, execute.ts | metric completeness and numerical integrity |
| M15-26 | Segmentation additions: confidence band (look-ahead excluded), risk verdict, planned reward-to-risk, decision outcome; … | NEW (audit B) | IMPLEMENTED | metrics.ts, analytics.ts, userApi.ts | segmentation additions and explicit NOT_AVAILABLE views |
| M15-27 | Audited correction command (A4): outcome-correction is dry-run by default, needs explicit owner and attribution ids, a … | NEW (audit A4) | IMPLEMENTED | outcome-correction.ts, outcomeStore.ts | audited correction command |

Totals: 27 rows: 19 IMPLEMENTED, 7 IN_PROGRESS, 1 NOT_STARTED, 0 VERIFIED. The 8 rows that are not IMPLEMENTED (M15-01, 03, 04, 08, 09, 10, 12, 14) wait on data or providers that belong to Stage 10/11 (real-price outcomes G-30, MAE/MFE G-31, OHLC G-32, pattern provider G-23) or are intentionally limited (M15-14: no automatic adjustment).

## Phase B capability coverage

| Required capability | Where |
|---|---|
| Closed paper-trade outcome collection | M15-22 (atomic close + outcome, recovery sweep), M15-16, M15-19 |
| Append-only, owner-scoped attribution; PARTIAL/FINAL integrity | M15-16 (0039 guards), M15-22, M15-27 (corrections) |
| Exact-decimal financial calculations | M15-25 (8-place fixed point; floats only for ratios of counts) |
| Win rate, loss rate, expectancy, P&L, drawdown, intervals | M15-05, M15-25 (percent drawdown NOT_AVAILABLE: no equity curve) |
| Segmentation: strategy, channel, pattern, source, regime, agents, decision outcome/quality | M15-05, M15-07, M15-21, M15-26 (signal pattern NOT_AVAILABLE: G-23) |
| Historical pattern and strategy evaluation | M15-04, M15-15 (reuses the Stage 03 detector); pattern-level view waits on G-23 |
| Data sufficiency and sample-size controls | M15-17 (30-outcome floor), M15-06 (200 out-of-sample) |
| Drift and degradation detection | M15-15 |
| Reproducible, versioned insights | M15-18, M15-23 |
| REVIEW-only recommendations | M15-18, M15-14 (type, generator and database CHECK) |
| Owner-isolated APIs and auditability | M15-20, M15-23, M15-27 |
