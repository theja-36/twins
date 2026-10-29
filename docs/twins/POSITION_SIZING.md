# Position sizing - Stage 3 / Task 2

> Decision [D-056](DECISION_LOG.md); requirement [SZ-13](REQUIREMENTS_TRACEABILITY.md) (new), part of SZ-01…SZ-03. Builds on [RISK_DECISIONS.md](RISK_DECISIONS.md), [MANDATORY_STOP_LOSS.md](MANDATORY_STOP_LOSS.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md). Code: `packages/risk/src/sizing/` (`engine.ts` pure, `config.ts`, `record.ts`), migration `0015_risk_decision_sizing`.

## 1. What this is - and is not
A **pure sizing engine** plus the recorder that appends its result to the risk-decision chain. The size is derived from the **planned maximum loss** (capital x risk %), never from the profit target or the strength of the signal, and it is **rounded down** to whole units/lots. It never rounds up into a larger risk. It places no order, calls no broker and creates no executable state; the output is a *plan* stored on an immutable risk-decision version.
Not in this task: portfolio / open-risk limits, daily and weekly circuit breakers, market/liquidity/event gates, margin modelling, approval cards, execution. A SIZED decision therefore stays **PENDING** ("awaiting the remaining risk gates").

## 2. Inputs (`SizingInput`)
`capital` · `instrumentType` (equity | future | option; anything else is refused) · `market` · `side` (BUY = long, stop below entry; SELL = short, stop above) · `entryPrice` (the premium for options) · `stopLoss` · `stopLossBasis` · `stopLossResult` (the stop-loss validation evidence result; only `VALID` is sized) · `targets` · `lotSize` (equity default 1; **required** for futures/options, a positive whole number, from `instruments.lot_size` or a *verified* options contract - never invented) · `confidenceScore` (0-100) · `sourceTrustTier` · `context` (the existing risk decision, echoed into the snapshot).
Where the recorder gets them: capital from `TWINS_SIZING_AVAILABLE_CAPITAL`; confidence from the signal validation's `decisionConfidence` (0-1, x100; 0 or absent = unknown); trust from the validation's `sourceReliability`; stop/entry from the **latest** stop-loss validation; lot size as above.

## 3. Formulas
```
perTradeCap  = min( capital x maxRiskPct / 100 , maxRiskAmount if configured )
appliedTier  = lower( confidenceTier , trustTier )          (UNKNOWN < LOW < MEDIUM < HIGH)
tierBudget   = perTradeCap x tierPct[appliedTier] / 100
riskPerUnit  = | entry - stop | x lotSize                    (equity: lotSize 1 -> per share; futures: price distance x multiplier per lot; options: premium distance x lot size per lot)
quantity     = floor( tierBudget / riskPerUnit )             (then reduced while the ROUNDED-UP loss would exceed the budget)
quantity     = min( quantity , floor( capital / (entry x lotSize) ) )    (affordability; the position never exceeds available capital)
maxLoss      = ceil4( quantity x riskPerUnit )     maxLoss% = ceil6( quantity x riskPerUnit / capital x 100 )
notional     = ceil4( quantity x entry x lotSize )
riskReward   = | target1 - entry | / | entry - stop |        (null without a target on the profit side)
```
Reported losses are rounded **up** so they are never below the true loss. Quantity is in **units** for equity and **lots** for futures/options.

## 4. Tiers and defaults (conservative sizing defaults, not final portfolio limits)
| Setting | Default | Environment variable |
|---|---|---|
| Per-trade maximum risk | 1% of capital | `TWINS_SIZING_MAX_RISK_PCT` (hard ceiling 5%, not tunable) |
| Absolute per-trade cap (optional) | none | `TWINS_SIZING_MAX_RISK_AMOUNT` |
| HIGH / MEDIUM / LOW share of the cap | 100% / 50% / 25% | `TWINS_SIZING_TIER_PCT_HIGH` / `_MEDIUM` / `_LOW` (HIGH ≥ MEDIUM ≥ LOW) |
| Confidence HIGH if ≥ / MEDIUM if ≥ | 75 / 50 (above 0 = LOW; 0 or absent = UNKNOWN) | `TWINS_SIZING_CONFIDENCE_HIGH_MIN` / `_MEDIUM_MIN` |
| Available capital | **not configured** → nothing is sized | `TWINS_SIZING_AVAILABLE_CAPITAL` |
Trust: `HIGH`→HIGH, `MODERATE`/`MEDIUM`→MEDIUM, `LOW`→LOW, anything else (`UNKNOWN`, absent)→UNKNOWN. **Unknown confidence or unknown trust = 0%: not sized.** The loader follows the stop-loss configuration pattern: a malformed or unsafe override **throws** (the process does not start; no silent fallback), and every sizing record stores the configuration used.

## 5. Outputs and statuses
`SIZED` · `REJECTED` (unknown confidence/trust, zero tier allocation) · `INSUFFICIENT_CAPITAL` (capital ≤ 0, or cannot pay for one unit/lot) · `INVALID_INPUT` (missing/invalid/unevaluated stop-loss, missing/invalid entry or premium, wrong-side stop, missing lot size, unsupported instrument, non-finite capital, confidence outside 0-100) · `RISK_LIMIT_EXCEEDED` (one unit/lot already exceeds the per-trade cap - `min_lot_exceeds_risk_cap` - or the tier budget - `min_lot_exceeds_tier_budget`).
Result: status, `reasonCode`, `explanation`, quantity, notional, max loss amount, max loss % of capital, risk per unit, risk-reward, confidence/trust/applied tier, cap, tier budget, input hash and the complete snapshot (engine version, configuration, inputs, context, outputs). The engine is pure and deterministic.
Reason codes: `sized_within_risk_budget`, `sized_capital_limited`, `capital_invalid`, `capital_not_positive`, `capital_below_one_unit`, `instrument_type_unsupported`, `stop_loss_unevaluated`, `stop_loss_not_valid`, `stop_loss_missing`, `stop_loss_wrong_side`, `entry_invalid`, `side_invalid`, `lot_size_invalid`, `confidence_out_of_range`, `confidence_unknown`, `source_trust_unknown`, `tier_allocation_zero`, `risk_distance_zero`, `min_lot_exceeds_risk_cap`, `min_lot_exceeds_tier_budget`.

## 6. Risk-decision integration (append-only)
`sizeRiskDecision(db, decisionId)` appends a **new version** that supersedes the current one (never an UPDATE): `SIZED` → status `PENDING`, reason `sized_awaiting_limits`, with `planned_quantity / planned_notional / planned_max_loss_amount / planned_max_loss_percent / planned_risk_reward_ratio` filled; any other status → `REJECTED`, reason `sizing_<reason>`, planned values NULL. The version cites the previous version and the **latest** stop-loss validation (`evidence_references`), stores the complete sizing input/output in `input_snapshot` and a `sizing` summary (status, engine version, input hash) in `output_snapshot`, and is written by `service:position-sizing` through the existing audited writer (`supersedeRiskDecision`, hash-chained).
* **Idempotent / versioned:** the same inputs return the existing version (also when retried against the version it superseded, also in parallel); changed inputs (capital, configuration, evidence) append the next version; a sizing-`REJECTED` decision can be re-sized once the inputs are fixed.
* **Only the latest version** of a `PENDING` (or sizing-`REJECTED`) decision is sized; an approved/other decision is `not_sizable`, a superseded one `not_latest_version`.
* **No approval without a size (migration 0015):** check constraint `risk_decisions_sized_review_check` - an `APPROVED_FOR_REVIEW` row needs positive planned quantity, notional, max loss amount and percent **and** `output_snapshot.sizing.status = 'SIZED'` (a NULL counts as not sized). `NOT VALID`: enforced for every new row; rows from before the migration (none in staging) are preserved unrewritten. Together with the Task 1 orders guard, an order needs a currently approved, SIZED, un-superseded decision.

## 7. Safety behaviour
* The intake runtime controls (kill switch, intake enabled, readable state) are evaluated **first**, before any database read; an unreadable state refuses (`safety_refused`). In the worker a refusal keeps its identity, so the intake gate pauses the job without consuming an attempt.
* No configured capital → `capital_not_configured` (the worker logs `worker.risk_sizing.skipped` and writes nothing). Sizing a decision with no stop-loss evidence cannot happen: such a signal has no risk decision at all (Task 1).
* **Interpretation to confirm (D-056):** `TRADING_ENABLED=false` does **not** block sizing - sizing is planning that creates no executable state, and it must keep running while trading is off so the plan exists for review. The intake kill switch does block it. If you want sizing blocked while trading is disabled, it is a one-line requirement change (`evaluateSafety("trading", …)`).
* Worker: after the pending decision is recorded (and on the resume path) the sizing version is appended; it logs `worker.risk_sizing.recorded`/`skipped`. Nothing else is written (no order, fill, position, legacy decision or approval card - tested).

## 8. Examples (defaults, capital 1,000,000)
| Case | Inputs | Result |
|---|---|---|
| Equity, HIGH/HIGH | 100 → stop 95, cap 10,000 | 2,000 shares, loss 10,000 (1%), notional 200,000, R:R 2 at target 110 |
| Equity, MEDIUM | same, confidence 60 | 1,000 shares, loss 5,000 |
| Equity, rounding | 100 → stop 97 | 3,333 shares, loss 9,999 (never 10,000.x) |
| Future, multiplier 10 | 1,000 → 950 | 500/lot → 20 lots, loss 10,000 |
| Future, capital limited | cap 100,000 at capital 10,000,000, 24,000 → 23,900, lot 50 | 20 lots by risk, 8 by capital → 8 lots, `sized_capital_limited` |
| Option, lot 25 (capital 500,000) | premium 120 → 90 | 750/lot, cap 5,000 → 6 lots, loss 4,500, notional 18,000 |
| Option, lot 75 | premium 200 → 100 | 7,500/lot > 5,000 → `RISK_LIMIT_EXCEEDED` (not rounded up) |
| Unknown trust | any | `REJECTED` `source_trust_unknown`, no size |

## 9. Limits and remaining risks
* **Update (Stage 4 / Task 5):** sizing now takes the confidence and trust tiers from recorded source intelligence ([SOURCE_INTELLIGENCE_INTEGRATION.md](SOURCE_INTELLIGENCE_INTEGRATION.md)); the statement below describes the pre-Task-5 inputs.
* **In practice nothing is sized yet:** the signal validation's source reliability is always `UNKNOWN` (no source intelligence yet) and the confidence is a self-reported, uncalibrated value (often the placeholder 0), so with the specified "unknown = 0%" rule every current signal ends `REJECTED` (`confidence_unknown`/`source_trust_unknown`) until those inputs exist. This is the specified fail-closed behaviour, not a defect; it needs source intelligence and calibrated confidence (later stages).
* Capital is a configured number, not read from a broker (no broker integration). Affordability uses full notional (cash basis); futures margin is not modelled.
* The recorder treats a verified options contract from a *test fixture* like any verified contract (the fixture flag is not inspected); production has no such master.
* Existing historical decisions are not retroactively sized.
