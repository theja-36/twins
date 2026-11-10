# Stage 06 — 85-row requirement matrix (re-audited against code and tests)

Method: each row re-checked against the source file and the named test in this working tree (not copied from earlier status). "Local" = unit tests run on this machine; "CI-only" = PostgreSQL integration tests that run only in CI and have NOT yet run for the 2026-11-10 changes.

| ID | Requirement | Status | Code evidence | Test evidence | External dependency / note |
|---|---|---|---|---|---|
| M08-01 | Total trading capital | IMPLEMENTED | packages/planning/src/sizing.ts (capital input); packages/database/src/schema/userPlatform.ts user_capital_profiles | sizing.test.ts, capitalSemantics.test.ts; integration stage06.test.ts (versions, CHECKs) |  |
| M08-02 | Available capital | IMPLEMENTED | sizing.ts uses available for budget and lot bound | capitalSemantics.test.ts (budget = % of available; total never enlarges) |  |
| M08-03 | Risk percentage | IMPLEMENTED | sizing.ts pctBudget; DB CHECK 5% ceiling | sizing.test.ts "every cap narrows the budget"; stage06 integration (ceiling) |  |
| M08-04 | Maximum risk per trade | IMPLEMENTED | sizing.ts max_risk_per_trade cap | sizing.test.ts "every cap narrows the budget and names the binding one" |  |
| M08-05 | Maximum daily loss | IMPLEMENTED | risk.ts daily loss; haltTriggers | risk.test.ts "enforces the daily loss limit", "halt expires next IST day"; stage06 integration daily-loss halt |  |
| M08-06 | Maximum concurrent positions | IMPLEMENTED | risk.ts concurrency | risk.test.ts "enforces ... concurrency" |  |
| M08-07 | Trading budget | IMPLEMENTED | available capital + maxPositionNotionalPct (sizing.ts) | capitalSemantics.test.ts (5 tests) |  |
| M08-08 | Preferred instruments | IMPLEMENTED | allowedUnderlyings in policy; risk.ts | risk.test.ts "allowed-underlying rule" |  |
| M08-09 | User permissions | IMPLEMENTED | user_execution_permissions (PAPER only; LIVE blocked by DB CHECK); decisionStore reads it | integration stage02.test.ts, masterBuildPlatform.test.ts, userRoutes.test.ts; unit safety/runtimeState | LIVE permission is disabled by design (Assisted Live / Controlled Auto off) |
| M08-10 | Broker account reference | IMPLEMENTED | accounts.broker_connection_id + composite owner FK (reference only; no live connection) | integration stage02.test.ts; unit stage02Migration.test.ts | no live broker connection (Stage 10) |
| M08-11 | Maximum permissible trade risk | IMPLEMENTED | sizing.ts effectiveBudget | sizing.test.ts "sizes from the money at risk" |  |
| M08-12 | Risk per lot | IMPLEMENTED | sizing.ts riskPerLot | sizing.test.ts "sizes from the money at risk" |  |
| M08-13 | Number of lots | IMPLEMENTED | sizing.ts whole lots, bounds | sizing.test.ts "never exceeds capital, policy lots, spec lots, freeze quantity"; property test |  |
| M08-14 | Expected profit | IMPLEMENTED | sizing.ts targets | sizing.test.ts "reports target outcomes" |  |
| M08-15 | Expected loss | IMPLEMENTED | sizing.ts maxLossAtStop incl. costs | sizing.test.ts "slippage can only enlarge the loss" |  |
| M08-16 | Risk-to-reward ratio | IMPLEMENTED | sizing.ts grossRewardToRisk | sizing.test.ts "reports target outcomes, reward-to-risk" |  |
| M08-17 | Break-even price | IMPLEMENTED | sizing.ts breakeven incl. costs | sizing.test.ts "breakeven that includes costs" |  |
| M08-18 | Capital utilisation | IMPLEMENTED | sizing.ts capitalUtilisationPct | sizing.test.ts / capitalSemantics.test.ts |  |
| M08-19 | Portfolio exposure | IMPLEMENTED | risk.ts ExposureSummary; PAPER source paperPortfolioProvider (Stage 07). LIVE source external: G-22 LIVE | risk.test.ts "total exposure"; integration trading/stage07.test.ts paperPortfolioProvider | LIVE portfolio source external |
| M08-20 | Remaining daily risk capacity | IMPLEMENTED | risk.ts RiskCaps.remainingDailyRisk; PAPER source as above. LIVE external: G-22 LIVE | risk.test.ts "shrinks the size to the remaining daily and group headroom" | LIVE portfolio source external |
| M08-21 | Fixed-point decimal arithmetic (BigInt, 8 dp) for all money, prices and rates; conservative rounding by direction | IMPLEMENTED | packages/planning/src/decimal.ts | sizing.test.ts "fixed-point decimal", "rounds in the stated direction" |  |
| M08-22 | Versioned instrument specifications and fee schedules from providers (memory, file), source kind recorded; nothing built in; unverified sources restrict risk | IMPLEMENTED | specs.ts providers; nothing built in | sizing.test.ts specs/fees tests; simulator.test.ts "fee fixture not shipped" |  |
| M08-23 | Per-user ownership: composite (account, user) keys, row-level security, writes through withUser, migration 0037 limits | IMPLEMENTED | composite (account,user) FKs, RLS, withUser | integration stage06.test.ts "invisible to another user"; G-46 isolation test |  |
| M09-01 | Agent assessments | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-02 | Historical outcomes | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-03 | Market regime | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-04 | Technical structure | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-05 | Price action | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-06 | News and sentiment | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-07 | Liquidity | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-08 | Pattern similarity | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-09 | Risk flags | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-10 | Evidence completeness | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-11 | Data freshness | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-12 | Strategy reliability | IN_PROGRESS (external data) | confidence score.ts strategy component; no provider wired | confidence.test.ts "stale regimes and thin strategy samples are not used" (reports missing). EXTERNAL: G-23 | G-23 |
| M09-13 | Overall confidence score | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-14 | Supporting evidence | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-15 | Contradicting evidence | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-16 | Missing evidence | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-17 | Risk flags | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-18 | Historical comparison | IN_PROGRESS (external data) | historicalComparison field exists, null: no resolved outcomes | EXTERNAL: Stage 08 outcome data | Stage 08 |
| M09-19 | Confidence explanation | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-20 | Calibration status | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M09-21 | Provenance and no double counting: package hash, agent versions, evidence refs per component; correlated families capped; independent rank shown but not scored | IMPLEMENTED | packages/confidence/src/score.ts | tests/unit/planning/confidence.test.ts (components, penalties, provenance, determinism, calibration) |  |
| M10-01 | Maximum risk per trade | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-02 | Stop-loss validation | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-03 | Maximum loss per trade | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-04 | Maximum daily loss | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-05 | Portfolio exposure | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-06 | Maximum concurrent positions | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-07 | Correlated index exposure | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-08 | Event-risk restrictions | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-09 | Drawdown controls | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-10 | High-volatility restrictions | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-11 | Low-liquidity restrictions | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-12 | Market closing-time restrictions | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-13 | Maximum lot limits | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-14 | Minimum risk-to-reward requirements | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-15 | Daily loss halt | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-16 | Drawdown halt | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-17 | Adaptive risk reduction | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-18 | Correlation controls | IMPLEMENTED | packages/planning/src/risk.ts | tests/unit/planning/risk.test.ts (limit boundaries, reasons, corrective actions) |  |
| M10-19 | Optional research-only Kelly analysis | IMPLEMENTED | packages/planning/src/analysis.ts kellyAnalysis (research only) | analysis.test.ts (min 30, invalid input, round down, disconnected-from-decision-path source scan) |  |
| M10-20 | Global kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-21 | Per-market kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-22 | Per-source kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-23 | Per-strategy kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-24 | Daily-loss kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-25 | Drawdown kill switch | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M10-26 | Risk decision contract PASS / RESTRICTED / BLOCKED with reasons, limits, exposure, evidence, policy version, corrective actions; confidence is not an input | IMPLEMENTED | risk.ts RiskDecision (no confidence input) | risk.test.ts "cannot be relaxed: confidence ... not inputs" |  |
| M10-27 | Append-only risk_control_events with recovery policy enforced by the database (owner-only clearing of drawdown halts and kill switches, mandatory reasons, expiry only on SET) | IMPLEMENTED | risk.ts controls/haltTriggers; planningStore risk_control_events + DB triggers | risk.test.ts "any active matching control BLOCKS", "halt expires"; simulator.test.ts recovery policy; integration stage06 "risk controls" |  |
| M11-01 | Stop-loss loss calculation | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-02 | Target profit calculation | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-03 | Break-even calculation | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-04 | Implied-move analysis | IMPLEMENTED | analysis.ts impliedMove (ATM straddle estimate; live chain source external: G-20/G-25) | analysis.test.ts (missing/stale/invalid/contradictory/not-ATM, estimate not guarantee) |  |
| M11-05 | Gap-risk analysis | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-06 | Portfolio impact | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-07 | Multiple-lot simulation | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-08 | Different entry-price comparison | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-09 | Different stop-loss comparison | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-10 | Risk-to-reward comparison | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-11 | Cost and slippage estimation | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-12 | Scenario comparison | IMPLEMENTED | packages/planning/src/simulator.ts | tests/unit/planning/simulator.test.ts (scenarios, gap, vol, portfolio impact, determinism) |  |
| M11-13 | Explainability: inputs echo, assumptions, limitations, spec/fee/model versions; persisted in simulations linked to the risk assessment | IMPLEMENTED | simulator.ts report; persistEvaluation links simulation to assessment atomically (G-46) | simulator.test.ts; integration stage06.test.ts G-46 tests |  |
| MU-S06-1 | Evaluation cycle for every READY candidate (either source) x every active account with profile and policy; behind TWINS_EVALUATION_ENABLED (off by default) | IMPLEMENTED | packages/planning/src/cycle.ts, evaluate.ts; persistEvaluation (atomic, G-46) | integration stage06.test.ts ("candidate evaluation", "disabled by default", G-46 concurrency/idempotency/isolation) — CI-only | worker flag off by default |
