# Mandatory stop-loss invariant (Stage 1 / Task 4)

> Implemented 2026-10-29 at base commit `4646ee7` + uncommitted Stage 1 changes. Migration `0011_stop_loss_validations`. Closes audit finding S6 ("the equity validator can APPROVE without a stop-loss"). Requirement entry: [XC-13](REQUIREMENTS_TRACEABILITY.md); decision [D-048](DECISION_LOG.md); evidence in [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md). Builds on [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md).

**Rule: a signal or claim without a valid, explicit, actionable stop-loss is never eligible for approval or execution.** One shared rule (`packages/stop-loss`, pure, no dependencies, no I/O) is used by every path; three layers enforce it; the result is stored as immutable, hash-chained evidence.

## Audit of the paths that can produce an approval-class state
| State | Where it can come from | Status |
|---|---|---|
| `APPROVE` (signal verdict) | **only** the last branch of `decide()` (`packages/decision-intelligence/src/decide.ts`); stored by `persistDecisionIntelligence` into `signal_validations` | enforced at 3 layers (below) |
| `QUALIFIED`, `CONDITIONAL`, `NO_TRADE`, `WAIT`, `ALTERNATIVE_CANDIDATE` | **do not exist** in code, enums or schema | listed in `@twins/stop-loss` (`EXECUTION_ELIGIBLE_STATES`, `NEVER_ELIGIBLE_STATES`) so a future state cannot be added without the rule; a static test fails if one is added to the schema |
| human "approve" of an options claim | the approval bot (`services/approval-bot`), record-only, `approval_possible` is a database CHECK `false` | blocked for claims without a VALID stop-loss (button removed, forged callback refused) |
| options claim assessment | `assessOptionsClaim` returns only `INSUFFICIENT_EVIDENCE` or `REJECT` | the rule decides REJECT vs flag; never approvable |
| `decisions`, `risk_decisions`, `orders`, `fills`, `positions` | tables exist; **no code writes them** | a static test fails if production code ever inserts into them, forcing the new path through the rule |

## The shared rule (`validateStopLoss`, version `stop-loss-v1`)
Checks run in a fixed order; the first failure decides the result and the reason:
1. supported instrument type: `equity`, `future`, `option` (else AMBIGUOUS `UNSUPPORTED_INSTRUMENT_TYPE`)
2. explicit side `buy` / `sell` (else AMBIGUOUS `UNSUPPORTED_TRADE_SIDE`)
3. present: not absent / null / empty / blank (else MISSING `MISSING_STOP_LOSS`)
4. numeric, finite, strictly greater than zero. Strings must be plain decimals (no sign, exponent, hex, separators, units). Zero, negative, `NaN`, `Infinity`, text, objects -> INVALID `INVALID_STOP_LOSS` (detail `zero`, `negative`, `not_finite`, `non_numeric`)
5. options only: the levels must be stated on the **premium** (else AMBIGUOUS `STOP_LOSS_BASIS_UNSPECIFIED`)
6. a usable entry/reference price (> 0; for a range both bounds) (else AMBIGUOUS `STOP_LOSS_REFERENCE_MISSING`)
7. not equal to the entry, and not inside an entry range (INVALID `STOP_LOSS_EQUALS_ENTRY`)
8. on the correct side (INVALID `STOP_LOSS_DIRECTION_INVALID`)
9. within the maximum risk distance (INVALID `STOP_LOSS_TOO_FAR`)
**Result:** `VALID` (reason code null) | `INVALID` | `MISSING` | `AMBIGUOUS` (cannot be shown valid; never treated as valid).

### Direction
Long exposure needs the stop **below** the reference, short exposure **above** it. A range entry is judged conservatively: the stop must clear the whole range and risk is measured from the farthest bound.
- **equity / future:** buy = long, sell = short.
- **option, premium basis (the only valid basis):** the stop is on the option's own price. BUY = long premium (stop below the entry premium), SELL = short premium (stop above), for **CE and PE alike**.
- **option, underlying basis:** CE-buy / PE-sell are bullish (stop below the underlying entry), PE-buy / CE-sell bearish (above). A stop on the wrong side is INVALID `STOP_LOSS_DIRECTION_INVALID`; on the right side it is still **not placeable on the option** without a pricing model, so AMBIGUOUS `STOP_LOSS_NOT_PREMIUM_BASIS`. An option stop is therefore validated against the premium, never the underlying alone.

### Maximum risk distance (configurable)
`|entry - stop| / entry` as a percentage, per instrument kind. Defaults: **equity 10, future 10, option premium 70** (inclusive bound). They are **sanity bounds, not risk budgets** (the owner's budgets, D-007, are a separate later control). Override with `TWINS_STOPLOSS_MAX_RISK_PCT_EQUITY|FUTURE|OPTION` (decimal > 0 and <= 100); a malformed value makes the worker and the signal validation throw (no silent fallback). Every evidence row records the bound used and whether it came from `default` or `env`.

## Reason codes (machine-readable)
`MISSING_STOP_LOSS`, `INVALID_STOP_LOSS`, `STOP_LOSS_EQUALS_ENTRY`, `STOP_LOSS_DIRECTION_INVALID`, `STOP_LOSS_TOO_FAR`, `STOP_LOSS_REFERENCE_MISSING`, `STOP_LOSS_BASIS_UNSPECIFIED`, `STOP_LOSS_NOT_PREMIUM_BASIS`, `UNSUPPORTED_INSTRUMENT_TYPE`, `UNSUPPORTED_TRADE_SIDE`. In evidence rows and verdict results (`stopLossReasonCode`) they appear as above; in the options-claim `reasons` list (and on review cards) as `stop_loss.<lower_snake>` (e.g. `stop_loss.missing_stop_loss`), next to the older `levels.stop_missing` / `levels.stop_wrong_side` codes, which are kept.

## Enforcement: three layers for APPROVE
1. **Decision** (`decide`): a MISSING or INVALID stop-loss is a blocking structural issue -> `REJECT` (`structural.stop_loss.<code>`); an AMBIGUOUS one -> `INSUFFICIENT_EVIDENCE` with the reason in the rationale; and the final `assertStopLossAllowsEligibility(outcome, stopLoss)` makes it impossible to return `APPROVE` otherwise, whatever branch ran. The bare-signal case that used to be non-blocking is now a REJECT.
2. **Persistence** (`persistDecisionIntelligence`): refuses an approval-class outcome without a VALID stop-loss (`StopLossInvariantError`) before any write, and appends the evidence **before** the verdict row.
3. **Database** (trigger `signal_validations_stop_loss_invariant`, ENABLE ALWAYS, checked by the audit verifier): a `signal_validations` row with `outcome = 'APPROVE'` is refused (check_violation 23514) unless the **latest** `stop_loss_validations` row of that signal is VALID. Later non-valid evidence takes eligibility away again. Raw SQL and `session_replication_role = replica` do not bypass it. Adding a state to the verdict enum fails a static test until the trigger and the rule cover it.
Options claims: `assessOptionsClaim` adds the shared rule (MISSING/AMBIGUOUS -> flagged `INSUFFICIENT_EVIDENCE`; INVALID -> `REJECT`), and the approval bot **recomputes the rule from the stored claim**: a claim whose stop-loss is not VALID shows `Stop-loss: NOT VALID (<code>) - approval is DISABLED`, gets no Approve button, and a forged approve callback is refused (`approval_refused:stop_loss_not_valid` event). This also covers claims stored before the rule existed. Rejecting stays possible.

## Evidence (table `stop_loss_validations`, append-only and hash-chained like the five audit tables)
One row per validation of a signal or an options claim: `subject_kind`, `signal_id` | `options_claim_id`, `idempotency_key`, `rule_version`, `result`, `reason_code` (null exactly when VALID), `detail`, `instrument_type`, `instrument_kind`, `side`, `option_type`, `level_basis`, **`original_stop_loss`** (as parsed, text), **`normalized_stop_loss`**, **`entry_price`** (the reference used), `risk_distance`, `risk_pct`, `max_risk_pct`, `max_risk_source`, `expected_stop_side`, `created_at` + the chain columns. CHECKs: result set, reason iff not VALID, exactly one subject, VALID needs a positive stop, entry and distance. `recordStopLossEvidence` (`packages/signals`) writes it from both flows; a retried validation reuses its row through the idempotency key. It is the sixth chain verified by `npm run audit:verify`, and the runtime role may append to it but never modify it.

## Historical rows
Migration 0011 **rewrites nothing**. Existing `signal_validations` rows (including any APPROVE recorded before the rule) stay exactly as they are (they are immutable anyway). They are reported by the view `signal_validation_eligibility` and `getValidationEligibility()` as **not eligible** with `eligibility_note`: `legacy_no_stop_loss_evidence` (an APPROVE with no evidence), `stop_loss_not_valid`, `not_an_approval`, or `stop_loss_valid` (eligible). The API `GET /signals/:id/validation` returns `approvalEligible` and `stopLoss` next to the outcome, so a consumer never has to infer eligibility from `outcome` alone. **Any future approval/execution consumer must use eligibility, not the outcome.**

## Not done / limits
- No QUALIFIED / CONDITIONAL / NO_TRADE states exist yet; when they are introduced they must call `assertStopLossAllowsEligibility` and extend the database trigger (a static test enforces the review).
- The rule validates the stop against the signal's own entry/reference price. It does not use live market prices (no feed), tick sizes or lot-based risk (risk core, a later stage), and cannot place a stop on an option from an underlying level.
- The default maximum-distance bounds are sanity values pending the owner's risk decisions.
- A claim that was assessed before this change has no evidence row (the bot judges it by recomputation).
