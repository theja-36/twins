# Historical pattern library and calibrated confidence (Stage 4 / Task 4)

> Decision [D-064](DECISION_LOG.md); requirement [HI-04](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [HISTORICAL_OUTCOME_EVALUATION.md](HISTORICAL_OUTCOME_EVALUATION.md), [SOURCE_SCORECARDS.md](SOURCE_SCORECARDS.md) and [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/historical/src/patterns/`, `scripts/ops/historical-patterns.ts`, migration `0023_historical_patterns`.

Learns repeatable patterns from **evaluated historical outcomes** and produces a **deterministic, local confidence estimate** (no LLM) for a signal. Everything is **historical association only**: no causal claim, no prediction, no advice. It is **not** wired into the live risk flow, the API or any service; it reads imported records, outcome labels and scorecard tiers (never modifies them), writes only its own five tables, and creates no risk decision, approval card, order, fill or position.

## Features (`pattern-features-v1`)

Derived from the **parsed** fields and the message time only - never free text, never hidden intent. Anything not stated is `UNKNOWN` (or `NA` where the feature does not apply).

| Feature | Values |
| --- | --- |
| market, instrumentType, underlying, side | upper-cased parsed values |
| optionType | `CE` / `PE` for options, `NA` otherwise |
| timeOfDay (market local time; NSE / BSE +05:30 built in) | `PRE_MARKET` (<09:15), `OPENING` (<10:30), `MIDDAY` (<14:00), `CLOSING` (<15:30), `AFTER_HOURS`; `UNKNOWN_TZ` for other markets |
| dayOfWeek | `MON`..`SUN` in local time, `UNKNOWN_TZ` |
| expiryProximity | options: `SAME_DAY`, `D1_2`, `D3_7`, `D8_30`, `GT_30`, `EXPIRED`, `UNSTATED` (no full date); `NA` for equities |
| entryType | `breakout` (buy above / sell below), `pullback` (buy below / sell above), `level` (at / range / near), `unspecified` (market, unstated, unreadable) |
| stopDistance (\|entry − stop\| / entry; range entries use the midpoint) | `LT_1PCT`, `1_2PCT`, `2_5PCT`, `5_10PCT`, `GTE_10PCT`, `INVALID` (stop on the wrong side), `UNKNOWN` |
| rewardRisk (T1 distance / stop distance) | `LT_1`, `1_2`, `2_3`, `GTE_3`, `INVALID`, `UNKNOWN` |
| targetStructure | `NONE`, `T1`, `T1_T2`, `T1_T2_T3` |
| source trust tier, data-quality tier | inputs to the **confidence model** (and descriptive mixes in each pattern snapshot), not part of a pattern key |

## Pattern levels (exact key match only)

L1 market + instrumentType + side · L2 = L1 + underlying · L3 = L2 + timeOfDay + expiryProximity · L4 = L3 + stopDistance + rewardRisk. A key is a readable deterministic string, e.g. `L2|market=NSE|instrumentType=EQUITY|side=BUY|underlying=ACME`; its identity is `sha256(feature version | key text)`. **No generated names.** A signal only ever uses patterns whose key equals its own at that level - it never borrows from a "similar" pattern.

*Known limitation:* the specified levels do not include `optionType`, so CE and PE signals with the same other features share a pattern (the feature is stored and available for a later level definition).

## Pattern metrics

Per pattern, over its **training signals** (original messages sent at or before `as-of − embargo`, default **30 days**, so outcomes that had not resolved yet cannot leak in): evaluable sample size; win / loss / no-entry / expired / unverifiable rates; T1/T2/T3 hit rates; gross and net expectancy (the scorecard R model, cost 0.05R per entered trade); profit factor (null without losses); average winner / loser R; maximum consecutive losses; maximum drawdown in R; data-quality score; first and last observed dates; source-trust-tier and data-quality mixes. Definitions are those of [SOURCE_SCORECARDS.md](SOURCE_SCORECARDS.md) (the same code computes them).

## Statistical honesty

* **Evidence status:** fewer than **30** evaluable outcomes → `INSUFFICIENT_EVIDENCE`; more than **40%** unverifiable → `LOW_QUALITY_EVIDENCE`; otherwise `SUFFICIENT` (insufficient wins when both apply; both flags are stored). Every snapshot carries `HISTORICAL_ASSOCIATION_ONLY`.
* **Uncertainty:** the **Wilson score interval** for the win proportion (wins ÷ entered trades) at z = 1.96 (~95%), chosen for its behaviour at small n and near 0 / 1; and a conservative **expectancy lower bound** = mean net R − z · sd / √n (null for n < 2).
* No extrapolation beyond the observed feature combination; no causal claim.

## Confidence model (`pattern-confidence-v1`)

Inputs: signal features, matching pattern snapshots, source trust tier, data-quality assessment (`GOOD / DEGRADED / INSUFFICIENT / UNKNOWN`), stop-loss validity, market-context availability. Output: score 0-100, tier `HIGH` / `MEDIUM` / `LOW` / `UNKNOWN`, matching pattern references, sample size, evidence quality (`SUFFICIENT`, `LOW_QUALITY_EVIDENCE`, `INSUFFICIENT_EVIDENCE`, `NO_MATCH`, `NO_LIBRARY`), an ordered explanation and limitations.

1. **Primary pattern** = the deepest matching level that is not `INSUFFICIENT_EVIDENCE`. None → `UNKNOWN`, score 0 (`NO_MATCHING_PATTERN` / `INSUFFICIENT_SAMPLE`).
2. **Score** = 100 × (Wilson lower bound of the primary pattern's win rate) × quality factors: (1 − unverifiable share) · pattern data-quality score · signal data quality (GOOD 1, DEGRADED 0.85, INSUFFICIENT 0.6, UNKNOWN 0.8) · market context unavailable 0.9 · invalid stop-loss 0.5 · 0.8 per conflicting matched level (shallower level with opposite expectancy sign or a non-overlapping win-rate interval). Evidence exists ⇒ at least 1.
3. **Bands (configurable):** LOW 1-39, MEDIUM 40-64, HIGH 65-100, UNKNOWN 0.
4. **Caps (configurable; a cap lowers the score to the top of the capped band):** source trust `UNKNOWN` or `D` → LOW; `C` → MEDIUM; unverifiable share > 40% → LOW; `LOW_QUALITY_EVIDENCE` → LOW; non-positive net expectancy → LOW; invalid stop-loss → LOW; an insufficient-sample pattern (only with `insufficientSample = CAP_LOW`) → LOW.

> **Open point (D-064):** the task text says both "insufficient sample → UNKNOWN" (rules) and "sample below 30 caps confidence at LOW" (mapping). The default is **UNKNOWN** (`insufficientSample: "UNKNOWN"`); `"CAP_LOW"` implements the cap instead.

**Point in time.** Estimating a *historical* signal is refused unless the pattern run's as-of is not later than the signal (otherwise `pattern_run_not_point_in_time`); `--allow-in-sample` records the estimate as in-sample (`LOOKAHEAD_IN_SAMPLE`, run flag `lookahead`). Source trust is the latest scorecard tier **at or before the signal time** (`--trust-mode latest` is the lookahead alternative and is flagged the same way). Historical signals have no market context, so `MARKET_CONTEXT_UNAVAILABLE` applies to them.

## Database

Five append-only, **hash-chained** tables (chains 22-26, migration `0023`): `historical_pattern_definitions` (key, level, features), `historical_pattern_runs` (as-of, embargo cutoff, configuration + hash, label-set hash, evaluation / dataset / scorecard references), `historical_pattern_snapshots` (status, flags, sample, full metrics with Wilson interval, mixes, observed dates), `historical_confidence_runs` (pattern run, scope, configuration + hash, trust mode, lookahead flag) and `historical_confidence_estimates` (score, tier, evidence quality, sample size, pattern references, inputs, explanation, limitations, evidence references). Runs are identified by an input hash: rebuilding unchanged input is a no-op; a new as-of, configuration or any new label / import is a new run.

## Service function

`estimateSignalConfidence(db, normalizedSignal, sourceTrustTier, marketContext, { patternRunId?, config? })` → deterministic estimate, or `UNKNOWN` (`NO_LIBRARY`, `NO_MATCH`, `INSUFFICIENT_EVIDENCE`). Read-only; by default it uses the latest pattern run at or before the signal time. **Not integrated into the live risk flow.**

## Commands

```
npm run historical:patterns -- rebuild-library --created-by operator:<name>
npm run historical:patterns -- rebuild-metrics --created-by operator:<name> [--as-of <ISO>] [--embargo-days N] [--min-sample N]
npm run historical:patterns -- estimate-record --id <normalized-record-uuid> --created-by operator:<name> [--pattern-run <uuid>] [--trust-mode point_in_time|latest] [--allow-in-sample] [--config cfg.json] [--dry-run]
npm run historical:patterns -- estimate-batch  --batch <import-batch-uuid>   --created-by operator:<name> [same options]
npm run historical:patterns -- show   --pattern "<key text | hash>" [--run <uuid>] [--json]
npm run historical:patterns -- export --format json|csv [--run <uuid>] [--out file]
```

Output is counts, identifiers, feature keys and numbers only; the export contains no message content or authors and guards CSV cells against spreadsheet formulas. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused. No compose service; nothing runs automatically.

## Limits

Thin or unverifiable data yields UNKNOWN/LOW by design. Win-rate bounds treat trades as independent (clustered or regime-dependent outcomes make them optimistic). Source tiers in training mixes are the latest ones (descriptive). The score is a conservative ranking of historical evidence, not a calibrated probability of profit; "calibrated" here means conservative lower bounds, explicit caps and sample thresholds. Real datasets, thresholds and the cost assumption need owner review before any use in sizing.
