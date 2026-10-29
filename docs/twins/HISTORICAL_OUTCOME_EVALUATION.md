# Historical outcome labeling and evaluation (Stage 4 / Task 2)

> Decision [D-062](DECISION_LOG.md); requirement [HI-02](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [HISTORICAL_ARCHIVE_IMPORT.md](HISTORICAL_ARCHIVE_IMPORT.md) and [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/historical/src/outcomes/`, `scripts/ops/historical-evaluate.ts`, migration `0021_historical_outcomes`.

For each imported historical signal with enough parsed fields, the engine decides **objectively what the market did afterwards** (entry reached? stop-loss hit? which targets, in what order?) using **pre-exported market data only**. It is research storage: no provider, broker or Telegram is contacted, and no signal, risk decision, approval card, order, fill or position is created. Nothing here scores sources, assigns trust, or calibrates confidence (all later tasks).

## Data contract (`twins-historical-bars-v1`, JSON)

```json
{ "format": "twins-historical-bars-v1", "provider": "<exporter id>", "dataset_id": "<id>", "dataset_version": "<version>",
  "series": [ { "kind": "equity_price | option_premium | underlying_price", "symbol": "RELIANCE", "market": "NSE",
                "strike": 24500, "option_type": "CE", "expiry": "2031-10-29",
                "interval_seconds": 60, "allowed_gap_seconds": 64800,
                "bars": [ { "t": "2031-01-02T09:15:00+05:30", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100, "oi": 500, "iv": 0.18 } ] } ] }
```

* A bar covers `[t, t + interval)`. `v`, `oi`, `iv` are optional. `strike`, `option_type`, `expiry` are required for `option_premium` and forbidden elsewhere.
* `allowed_gap_seconds` is the largest spacing between consecutive bar starts (and between the signal and the first bar) that is **not** a gap - the exporter declares overnight / weekend / holiday breaks here (default 1.5 × interval).
* Malformed data is **rejected at load** (the whole dataset): non-finite or negative numbers, `high < low`, open / close outside the range, timestamps without an offset, unsorted or duplicate timestamps, an option series without its contract. Nothing is repaired or interpolated. An option premium may be `0`; an equity price may not.
* Providers: `memoryProvider` (deterministic, tests) and `fileProvider` (`.json` files, hashed; credential-like names, symlinks, binary and oversized files refused). The seam is `HistoricalDataProvider { id, datasets(), findSeries(query) }`; **no live provider exists**.
* Each dataset is registered (append-only) with provider id, dataset id, version and content SHA-256, series descriptors (never bar content), and coverage.

## Evaluation rules (algorithm `outcome-eval-v1`)

**Window.** Only bars that *start strictly after* the signal time (the message time, or the edit time of a revision) **and** are *complete* by the run's as-of instant and by the validity end are used. Future-dated bars are dropped and counted. Validity ends at the earliest of: the option contract expiry (end of the expiry day in the market's timezone; NSE / BSE / NFO / BFO = +05:30, other markets need `--tz-offset-minutes`), an `intraday` timeframe (end of the signal's local day), a stated duration (`2h`, `3d`, `1w`), and the horizon cap (default 30 days). The window, kind of validity end, interval, bar count, first / last bar scanned, gap count, largest gap and dropped bars are stored with every label.

**Touches** are inclusive (`low ≤ level ≤ high`); the first-touch time is the bar **start**, and the resolution is recorded.

| Step | Statuses |
| --- | --- |
| A Entry | `ENTRY_REACHED`, `ENTRY_NOT_REACHED`, `ENTRY_INVALID`, `UNVERIFIABLE` (with first touch and whether it was reachable before the validity end). `at`: the bar's range contains the price; `above`: high ≥ price; `below`: low ≤ price; `range`: the bar overlaps the range; `market`: the first bar's open (it must still be consistent with the stop-loss and targets); `near`: needs `--near-tolerance-pct`, otherwise `UNVERIFIABLE (ENTRY_TRIGGER_VAGUE)`. |
| B Stop-loss | `SL_HIT` (first touch after entry), `SL_NOT_HIT`, `SL_INVALID`, `UNVERIFIABLE`. A BUY stop is hit when `low ≤ stop`; a SELL stop when `high ≥ stop`. |
| C Targets T1-T3 | `TARGET_HIT` (first touch, `hitBeforeSl`), `TARGET_NOT_HIT`, `TARGET_INVALID`, `UNVERIFIABLE`. Targets beyond the third are noted, not evaluated. |

**Final outcome - deterministic priority:**

1. `INVALID_SIGNAL` / `UNVERIFIABLE` - bad signal geometry or insufficient evidence (always with a machine-readable `primary_reason`)
2. `NO_ENTRY` (horizon only) / `EXPIRED_NO_ENTRY` (an explicit validity end passed) - entry never reached
3. `LOSS_SL` - the stop-loss was hit before any target
4. `WIN_T1` / `WIN_T2` / `WIN_T3` - the **highest** target hit before the stop-loss
5. `EXPIRED_AFTER_ENTRY` - entered, neither stop nor target before the validity end

**Never guessed - these are `UNVERIFIABLE`:** no series (`NO_MARKET_DATA`); no bars in the window or only future-dated bars (`NO_MARKET_DATA_IN_WINDOW`, `ONLY_FUTURE_DATA`); a gap before the decisive bar or behind a "not hit" conclusion (`DATA_GAP`); a series that ends before the validity end where the label needs it (`INSUFFICIENT_COVERAGE`); a stop and a target (or entry and stop) inside **one bar** (`INTRABAR_ORDER_AMBIGUOUS`; `--intrabar conservative` is an explicit opt-in that assumes the stop first); an unknown market timezone; an option SELL whose intent (open vs. close) the text does not state (`SELL_INTENT_UNRESOLVED`).

**Invalid signals** (no data is examined, `data_quality = NOT_APPLICABLE`): missing side / entry / stop-loss / targets, stop-loss or targets on the wrong side of the entry, unordered targets, a reversed range, an unsupported instrument, an option without strike / type / full expiry date or whose levels are not stated as premium, a contract that expired before the signal.

## Options

Option signals are evaluated on **option premium bars** for the exact contract (underlying, strike, CE/PE, expiry); the underlying price is never used and a premium is never inferred. If only an underlying series exists the label is `UNVERIFIABLE (OPTION_PREMIUM_DATA_MISSING)`. CE and PE are different series; because the signal buys the *premium*, entry / stop / target sides are the same as for any long position for both CE and PE (a PE premium rises when the underlying falls - that is already inside the premium series). Option `SELL` signals are not evaluated (above).

## Evidence and database

Four append-only, **hash-chained** tables (chains 13-16, migration `0021`): `historical_datasets` (dataset references), `historical_evaluation_runs` (scope, algorithm version, configuration incl. the as-of instant, dataset references; identified by a run key), `historical_outcome_labels` (one per run and record: signal / source record reference, run, dataset reference, algorithm version, entry / SL / target evaluations, final outcome, data-quality status, data window, input snapshot - parsed fields only, **never message text** - and evidence: series hash, resolution, the entry / stop-loss / target bars) and `historical_evaluation_events` (RUN_STARTED / CHECKPOINT / RUN_COMPLETED). A trigger refuses a label whose source record is not the source of its normalized record. Labels are never edited: a different dataset, configuration, as-of or algorithm version is a **different run**. The imported records and every live-pipeline table are never written (asserted by tests).

## Commands

```
npm run historical:evaluate -- record --id <normalized-record-uuid> --data bars.json --created-by operator:<name> [--dry-run]
npm run historical:evaluate -- batch  --batch <import-batch-uuid>  --data a.json,b.json --created-by operator:<name> [--dry-run] [--chunk-size N]
npm run historical:evaluate -- report --run <run-uuid> [--json]
  options: --as-of <ISO instant with offset> (default now) --horizon-days N (default 30) --intrabar unverifiable|conservative
           --tz-offset-minutes N --near-tolerance-pct P --json
```

`--as-of` is part of the run identity: repeating a command with the same data, options and `--as-of` resolves to the same run (a completed run is a no-op; an interrupted one resumes after the last committed chunk). Output is counts, codes and ids only. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused / invalid input. There is no compose service and nothing runs automatically.

## Limits

Evaluation quality is bounded by the data resolution: with daily bars, same-day stop / target ordering is `UNVERIFIABLE`. Corporate actions, splits and rolled contracts are the exporter's responsibility. Real datasets must be reviewed before first use. Source scorecards, trust tiers, pattern libraries and calibration are out of scope.
