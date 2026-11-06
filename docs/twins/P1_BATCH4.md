# P1 batch 4: pre-trade validation, drawdown breaker, agent debate, regime detector, liquidity guard

**Status: built as PURE functions, tested, NOT wired.** No order, broker call, migration, flag, provider call or decision changes. Every result carries `grantsApproval: false`. Owner order 2026-11-07 (weekend plan, batch 4).

| # | Feature | Where | Scope built |
|---|---|---|---|
| 9 | Pre-trade order validation | `packages/risk/src/preTrade/validate.ts` | Full: quantity (whole, lot multiple, max, freeze), tradable, session, tick alignment, market-order policy, reference price, price deviation and exchange band, stop required / right side / on tick, quote age, notional vs limit and capital. Unknown facts warn; a missing reference price blocks. |
| 11 | Drawdown circuit breaker | `packages/risk/src/drawdown/governor.ts` | Full (advisory): peak-to-current drawdown from an equity curve to NORMAL / CAUTION / REDUCE_ONLY / HALT_NEW_ENTRIES with hysteresis; multipliers only ever <= 1; never forces an exit; bad data fails to CAUTION. Complements the existing loss-event breakers (daily/weekly). Its `drawdownPct` is the missing input of the reduce-only sizing shadow. |
| 13 | Multi-agent debate | `packages/agents/src/debate.ts` | Full (deterministic, no model): FOR / AGAINST / NEUTRAL / ABSENT sides, weighted strength, challenges and rebuttals by finding CODE, contested flag, agreement index, and pivotal agents found by re-running the real `synthesize`. Three rounds as structured points. |
| 7 | Market-regime detector | `packages/risk/src/regime/detect.ts` | Partial, synthetic fixtures: TRENDING_UP/DOWN, RANGE_BOUND, HIGH/LOW_VOLATILITY, UNKNOWN from efficiency ratio, slope vs ATR and short/long realised volatility. Emits `volatilityRatio`. Thresholds are untuned defaults. |
| 8 | Liquidity + slippage guard | `packages/risk/src/liquidity/guard.ts` | Partial, synthetic fixtures: spread, participation vs average daily volume, square-root-law impact estimate, depth share; verdict OK / CAUTION / TOO_LARGE / UNKNOWN; suggested max quantity never above the request. Impact constant is an assumption, not calibrated. |

## What is NOT done (honest limits)
* Nothing is connected to the pipeline, the worker, the API or the decision card. Wiring each is a separate step with its own design (shadow first, reduce-only).
* #7 and #8 thresholds and the impact constant are defaults chosen for plausibility, not fitted to NSE data; calibration needs real bars/depth (Kite after the Monday refresh).
* #9 needs per-instrument rules (lot, tick, freeze, bands). Kite's instrument catalog has lot and tick; freeze quantity and bands are not in it, so they would have to be supplied (null = not checked, which the function reports as unchecked only for session and quote age; a null band or freeze simply skips that check).
* #11 consumes an equity curve; none exists while paper trading is off.
* #13 is deterministic structure over existing agent results, not an LLM debate. A model-driven debate would be a separate, much riskier feature and was not built.

## Tests
`tests/unit/p1/preTradeAndLiquidity.test.ts`, `drawdownAndRegime.test.ts`, `debate.test.ts` (33 tests, including a 3000-case property test that the liquidity suggestion never exceeds the request and respects the participation cap, and property tests that no bad number yields `ok`).
