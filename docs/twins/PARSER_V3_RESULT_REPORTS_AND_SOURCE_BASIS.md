# Parser v3: result reports are not signals; per-source default level basis

Owner approval 2026-11-07 (fixes 1 and 2 of the stop-loss investigation). **Built and unit-tested; takes effect on the worker only when deployed (planned for Monday's functional deploy).**

## Fix 1: `telegram-regex-v3`
* **Rule:** an options claim with **no BUY/SELL action AND no entry level AND result / performance wording** (whole-word match on hit, achieved, booked, gain(s)/gaining, profit, done, reached, win/won, success) is classified `{ kind: "none", reason: "result_report" }` instead of an empty claim. No claim row and no risk decision is created for it.
* **Guards (never dropped):** any message with a BUY/SELL action; any message that carries an entry level (at, above, below, near, range, market), whatever else it says; any claim without result wording; equity signals and ordinary noise (unchanged).
* **Known trade-off:** a message with no BUY/SELL and no entry that says something like "profit booked" is also dropped. It is an exit/update message, not an entry signal, so no entry signal is lost.
* **Versioning:** the current version becomes `telegram-regex-v3`; `telegram-regex-v2` stays shipped (`analyzeTelegramTextV2`) for explicit reparse and for claims already stored under it. Existing rows are untouched. Importer batches record v3 and are identified separately from earlier batches.
* **Historical normalizer:** such a message becomes `NO_SIGNAL` with warning `result_report`, so a report of reached targets can never be imported as a signal with its outcome baked in.
* **Capture exporter:** skips them by default (counted as `result reports`); `--include-result-reports` keeps them.

## Fix 2: per-source default level basis
* **Configuration:** `TWINS_SOURCE_DEFAULT_LEVEL_BASIS=<source>=premium[,<source>=premium]` (worker environment; the source is the channel identifier). Empty or unset means no source is configured (the default). Anything malformed fails at worker start-up. Only `premium` is accepted. Importer and profiler take the same value with `--level-basis-default "<source>=premium"`.
* **Application (pure `applySourceDefaultBasis`), all guards required:** the source is configured; the claim's basis is `unspecified` and there is no premium/underlying conflict; a stop and a strike exist; the stop is **below 10% of the strike** (exactly 10% or more stays ambiguous). A stated basis always wins.
* **Not silent:** the claim gains `levelBasisInference` (rule `source-default-premium-v1`, the source default, the measured stop-to-strike percent and the limit); the importer adds warning `level_basis_inferred_source_default`. Nothing else in the claim changes (action, entry, stop, targets, expiry).
* **Batch identity:** an import's identity includes the configured sources only when any are set, so existing identities are unchanged.
* **What it does not do:** it does not make a claim approvable. Contract verification and premium data are still required; a stop with a premium basis still needs an entry to compute risk distance.

## Tests
`tests/unit/signals/resultReportAndSourceBasis.test.ts` (14): report classification and v2 preserved; guards for action, entry and plain claims; equity and noise unchanged; a 3000-case property test that text containing BUY or SELL is never classified as a result report; basis guard matrix (10% boundary, underlying-like, missing stop or strike, conflict, stated basis wins); config parsing and fail-closed cases; normalizer behaviour; batch identity. Plus exporter tests in `captureExport.test.ts`.

## Activation (host, Monday, owner's confirmation of the source)
Set `TWINS_SOURCE_DEFAULT_LEVEL_BASIS` in the host `staging.env` to the identifier of the channel whose stops are premium-quoted (the source that produced 109 of 126 claims), then restart the worker. Until then nothing changes.
