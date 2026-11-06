# Outcome attribution (P0 #5, first slice)

**Status: built, read-only, not wired.** Nothing reads this report to change a weight, tier, limit or decision. No migration, no provider call, no order.

## What it does
Stratified tables over the already-evaluated historical outcome labels (`packages/historical/src/attribution`). One dimension at a time: source (aliases folded into the canonical source), market, side, IST session (PRE_OPEN, OPENING 09:15-10:30, MIDDAY, CLOSING 14:00-15:30, AFTER_HOURS), IST weekday, data quality.

Each stratum shows evaluable count, entered, wins, losses, unscored (UNVERIFIABLE/INVALID), entered win rate with a 95% Wilson interval, expectancy in R (the same fixed R model as the source scorecards) and its difference from the overall expectancy.

## Honesty rules
* **THIN**: a stratum with fewer than `minSample` evaluable outcomes (default 30, the same threshold the scorecards use) is listed but marked THIN and never called different.
* **DIFFERS** is set only for a READABLE stratum whose win-rate interval excludes the overall win rate. It is a screening aid: many strata are compared, so some flags will be chance.
* Descriptive, not causal. No model-based attribution (it overfits at these sample sizes).
* **Not attributable yet** (shown in every report, never silently dropped): agent verdicts at decision time (shadow runs are log-only, HB-25), confidence tier, expiry proximity, execution effects (P1 #18).

## Use
`npx tsx scripts/ops/outcome-attribution.ts [--min-sample N] [--dimension source,market,...] [--json]` (needs `DATABASE_URL`; read-only, bounded connection, live-trading guard applied). The loader reads timestamps, market, side, outcome and data quality only, never message text.

## Tests
`tests/unit/historical/attribution.test.ts` (buckets, Wilson, R maths, THIN/DIFFERS logic, determinism, empty input) and an integration test against real PostgreSQL that seeds labels with the real importer and evaluator and asserts the report writes nothing.

## Open
* Whether staging holds any imported historical set to run it on (not checked; it would be a read-only run on the host).
* Calibration check of agent verdicts against outcomes (HB-19) needs durable shadow storage first.
