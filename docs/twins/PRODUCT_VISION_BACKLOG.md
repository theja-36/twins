# Product vision and feature backlog (2026-11-06)

> Owner vision update, received 2026-11-06. **Documentation only. Nothing here is scheduled, built or authorized.** No code, schema, host, provider or safety-flag change follows from this file. Each feature needs its own discovery note, owner approval and gate before any build. Estimates are deliberately absent.

## Vision
TWINS = **personal AI trading analyst + risk manager + execution copilot.**

Build order set by the owner:
1. **P0 (6 features)** - the product becomes an *advanced analyst*.
2. **P1 (12 features)** - the product becomes an *institutional-grade personal system*.

## Boundaries that stay in force (from PRODUCT_BASELINE.md, section A)
* "Execution copilot" means **human-approved execution inside an approved mandate**. It does not mean autonomous trading. Enforcing engine, paper trading and live orders remain separate owner decisions and are not enabled by anything below.
* Adaptive management, dynamic sizing and any learning component may **tighten** risk freely but may **never relax** a limit or promote themselves silently. A relaxation is a proposal for the owner.
* No majority vote (including the multi-agent debate, #13) overrides a deterministic risk veto.
* Missing evidence stays unavailable. No fabricated probabilities, targets or fills; thin samples never count as strong evidence.
* Every feature must be explainable from stored inputs (see #6) and must work in shadow mode first.

## P0 - advanced analyst
| # | Feature | Intent | Likely existing touchpoints (verify in discovery) | Key open question |
| --- | --- | --- | --- | --- |
| 1 | Adaptive trade management | Manage an open position after entry: trail, scale, tighten, exit proposals driven by new evidence | MANDATORY_STOP_LOSS.md, PAPER_TRADING.md | Proposals only, or owner-approved amendments? Stops may only move toward safety unless the owner approves |
| 2 | Source health profile | Per-source freshness, failure rate, latency, reliability that agents and the decision card can read | SOURCE_SCORECARDS.md, SOURCE_INTELLIGENCE_INTEGRATION.md, the provider exporter's per-pass results | One profile model for providers and signal sources, or two |
| 3 | Dynamic position sizing | Size from conviction, volatility, regime, drawdown state and portfolio exposure, bounded by hard caps | POSITION_SIZING.md, PORTFOLIO_RISK_LIMITS.md | Which inputs may only reduce size, and who approves the caps |
| 4 | Options-specific risk | Greeks, expiry, IV, assignment and liquidity risk for option positions | agent volatility / expiry work (HB-16, HB-17) | Which option strategies are in scope first |
| 5 | Outcome attribution | Explain why a trade won or lost: signal, timing, sizing, execution, regime, luck | HISTORICAL_OUTCOME_EVALUATION.md, PATTERN_LIBRARY_AND_CONFIDENCE.md | Attribution method that stays honest on small samples |
| 6 | Explainable decision card | One page per decision: evidence, source health, vetoes, sizing, alternatives, what would change it | RISK_DECISIONS.md, RISK_APPROVAL_WORKFLOW.md, the agent synthesis output | Card is read-only evidence for the human, never an approval by itself |

## P1 - institutional-grade personal system
| # | Feature | Intent | Likely existing touchpoints (verify) | Depends on (proposed) |
| --- | --- | --- | --- | --- |
| 7 | Market-regime detector | Label trend / range / high-vol / event regimes with a confidence | regime logic already referenced in agents and gates | P0 #3, #5 consume it |
| 8 | Liquidity + slippage guard | Refuse or shrink entries when depth or spread makes the fill unreliable | MARKET_RISK_GATES.md | #9, #18 |
| 9 | Pre-trade order validation | Deterministic last check of an order against mandate, limits, lot size, price band, stop | MANDATORY_STOP_LOSS.md, MARKET_RISK_GATES.md | #8, #10 |
| 10 | Portfolio exposure governor | Aggregate caps by symbol, sector, index, direction and options delta | PORTFOLIO_RISK_LIMITS.md | #3 |
| 11 | Drawdown circuit breaker | Reduce, then halt, after defined loss thresholds, with a human reset | CIRCUIT_BREAKERS.md | #3, #10 |
| 12 | Real-time news impact | Fast entity-specific news effect on open positions and candidates | Marketaux adapter (D-109, blocked on permission), GDELT (failing) | News source decision (HB-30) |
| 13 | Multi-agent debate | Structured bull / bear challenge feeding the decision card; advisory only | agent engine challenger (HB-05) | #6 |
| 14 | Scenario stress test | Gap, volatility and correlation shock replays on the live portfolio | PORTFOLIO_RISK_LIMITS.md | #10, #15 |
| 15 | Cross-market correlation | Rolling correlation to indices, FX, rates, commodities, global futures | macro context provider | Data provider choices |
| 16 | Independent signal generation | TWINS's own screens / signals, not only evaluating external ones | signal pipeline | Needs P0 #5 evidence and an owner policy on own-signal approval |
| 17 | Trade-journal pattern miner | Mine the journal for recurring mistakes and edges | outcome tables | #5, enough trade history |
| 18 | Execution-quality analytics | Slippage, fill delay, rejection and cost analysis against intended price | paper / execution records | Real or paper fills to measure |

## Proposed ordering inside P0 (for owner decision, not decided)
Source health (#2) and the decision card (#6) are the least risky and make everything else inspectable, so they could come first. Outcome attribution (#5) needs trade history that does not exist yet (paper trading is off). Adaptive management (#1) and dynamic sizing (#3) touch live risk behaviour and should land last, in shadow first.

## Dependencies and external blockers (unchanged)
* Paper trading and any trade history: separate owner decision, not yet.
* News inputs (#12): Marketaux permission pending (email sent 2026-11-06); GDELT keeps failing.
* Kite feed run and token refresh: macro `as_of` stays stale until then.
* Discovery notes for the six P0 features: [discovery/P0_DISCOVERY.md](discovery/P0_DISCOVERY.md).
* Hardening items HB-05..HB-30 still apply and are not replaced by this list.

## Build status (updated 2026-11-06)
* Owner order: package 1 = #2 + #6; package 2 = #1 + #3 (shadow, strictly reduce-only: never larger size, never a wider stop); package 3 = #4 + #5 (options data: Kite first after the token refresh, Dhan as backup, terms check for any new source).
* Package 1 (#2 source health + #6 decision card): built, see [SOURCE_HEALTH_AND_DECISION_CARD.md](SOURCE_HEALTH_AND_DECISION_CARD.md). #2 uses files and logs only, no migration.

## Build status (updated 2026-11-06)
* Owner order: package 1 = #2 + #6; package 2 = #1 + #3 (shadow, strictly reduce-only: never a larger size, never a wider stop); package 3 = #4 + #5 (options data: Kite first after the token refresh, Dhan as backup, terms check for any new source).
* Package 1 (#2 source health + #6 decision card): built, see [SOURCE_HEALTH_AND_DECISION_CARD.md](SOURCE_HEALTH_AND_DECISION_CARD.md). #2 uses files and logs only, no migration.

## Next step (when the owner says go)
One short discovery note per P0 feature: what already exists in the repository, the smallest first slice, tests and the shadow-mode plan. Then the owner picks the first feature.
