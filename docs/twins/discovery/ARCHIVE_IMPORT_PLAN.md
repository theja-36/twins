# Telegram archive import plan for staging (plan only, nothing run)

**Docs only. Nothing is imported until the owner supplies the archive file and says go.** Purpose: give outcome attribution (P0 #5) and the source scorecards real data. Staging currently holds 0 source records, 0 outcome labels and 0 evaluation runs (checked read-only 2026-11-06).

## Two inputs are needed, not one
1. **The message archive** (a local JSONL/JSON/CSV export in the importer's contract, `packages/historical/src/contract.ts`; see [HISTORICAL_ARCHIVE_IMPORT.md](../HISTORICAL_ARCHIVE_IMPORT.md)). The importer never contacts Telegram.
2. **Historical price bars** for the symbols in those messages, as pre-exported dataset files. The outcome evaluator has no live provider by design (only an in-memory provider for tests and a file provider). **Without bars every signal is labelled UNVERIFIABLE and attribution would show nothing useful.** This is the real gap: I do not know where bars would come from (Kite historical needs the deferred token refresh; Dhan historical is part of the paid Data plan; an NSE bhavcopy-style file would give daily bars only). Needs an owner decision and a terms check, like any new source.

## Steps once both inputs exist
1. Owner places the archive on the staging host under a private path (not in the repo, never committed; staging-data files stay out of the public repos).
2. `historical-import validate <path>` (no database).
3. `historical-import dry-run <path> --label <label> --default-market NSE` (read-only database access) and the owner reads the counts.
4. Backup first (`twins-backup`), then `historical-import import` with the dry run's manifest hash. Writes only to the append-only historical tables; no live table, no order, no signal (the importer's contract). Resumable.
5. `historical-evaluate` with the bar dataset files, then `historical-scorecard register` / `rebuild`, then `outcome-attribution`.
6. Review output with the owner. Nothing reads these results for any decision.

## Risks and checks
* Redaction runs before storage (secret-shaped strings, emails, phone numbers, invite links). The owner should still check the archive has no private chats mixed in.
* Appended rows are hash-chained and cannot be deleted: a wrong import cannot be rolled back except by restoring a backup, so use the dry run and a fresh backup.
* Running the CLIs on the host: not yet confirmed how (the app image is read-only; likely a one-off container from the same image with the database URL from the environment, not printed). I will verify that read-only before the real run.
* Sample sizes: attribution marks strata under 30 evaluable outcomes as THIN; a small archive will mostly show THIN.

## Needs from the owner
The archive file (and its channel names for source labels), a decision on where price bars come from, and a go for the import itself.

## Refinement 2026-11-06: price bars from Kite (free with the Connect plan already bought)
The bars gap has a source: Kite Connect historical candles (the Connect plan is paid for, D-090). Built: `buildBarsDataset` (pure, `packages/kite/src/barsDataset.ts`) turns fetched and mapped candles into `twins-historical-bars-v1` files, re-validated by the evaluator's own parser. Not built: the fetch driver (needs the token, so after the refresh).

**Coverage limits found in the existing Kite code (these decide how much of the archive can be evaluated):**
1. The instrument catalog is scoped to NIFTY, BANKNIFTY and SENSEX only. Stock (cash equity) signals in the archive have no bar source yet; adding stocks means extending the catalog scope (a code change, then a fetch per symbol).
2. Only currently listed contracts can be fetched: the historical client refuses expired contracts and continuous data. **Kite will not supply history for options that have already expired**, so older option signals (the bulk of any archive) stay UNVERIFIABLE. Option attribution therefore needs premium bars captured going forward, or another source for expired contracts.
3. Intraday history is capped per request (minute 60 days, 15-minute 200 days, daily 2000 days) and rate limited; fetching must be chunked.
4. Candles carry only bar start times; a still-forming last bar is dropped by the builder.

**Practical consequence:** after a Kite refresh, the first attributable data will be index-level (NIFTY/BANKNIFTY/SENSEX) signals. Stock and expired-option signals need further decisions. I should first read the archive's symbol mix (counts by instrument kind from the dry run) before choosing what to build next.

**Updated order:** Kite refresh (KITE_REFRESH_PREP.md) -> archive file from the owner -> dry run to learn the symbol mix -> fetch bars for what Kite can supply -> import -> evaluate -> scorecards -> attribution.

## Batch 6 (2026-11-07): archive prep tooling built (no import)
**New: `scripts/ops/archive-profile.ts`** (`packages/historical/src/archiveProfile.ts`), a dry-run profiler that needs no database. Usage:

`npx tsx scripts/ops/archive-profile.ts <path> --label <label> [--default-market NSE] [--as-of <ISO with offset>] [--json]`

It reads the local export, runs the same preparation and normalization the importer uses (so counts match the importer's own dry run), and prints: records, invalid, unique messages, revisions, duplicates, parseable signals; date range and per-month counts; per-channel messages and signals; instrument / market / side mix; top underlyings; stop-loss quality (missing, invalid, ambiguous, incomplete); **bar coverage estimate**; and a **bar plan** (how many historical-candle calls per underlying and how long at the 3 requests/second limit).

**Bar coverage categories (estimate from the existing market-data client rules, not a live check):** `INDEX_UNDERLYING` (NIFTY, BANKNIFTY, SENSEX), `OPTION_LISTED` (index option whose expiry is today or later), `OPTION_EXPIRED` (cannot be verified), `STOCK_NOT_IN_CATALOG`, `NOT_ASSESSABLE` (parser could not name the underlying or expiry). `plausiblyVerifiableShare` = index underlying + listed option, as a share of parseable signals. This is the number that decides whether importing is worth doing before extending the catalog.

**Safety:** writes nothing, contacts nothing, no database, prints no message text (verified by test, including a message containing a secret-shaped string and an email). Channel labels ARE printed: keep the output out of public repositories.

**Where to run it:** locally on the owner's machine against the export (nothing needs to leave the machine), or on the host after the next functional deploy puts the script in the image (not verified yet; the image is read-only, so the file must be placed where the container can read it).

**What the existing importer dry run adds:** `historical-import dry-run` additionally counts messages already imported (read-only database access) and prints the manifest hash that `import` requires. Use `archive-profile` first, then `dry-run`, then decide scope.

**Tests:** `tests/unit/historical/archiveProfile.test.ts` (9): classification of every category, counts and dates, coverage and bar plan, invalid / duplicate / revision handling, no text leakage, empty-signal archive (null shares, not NaN), determinism, CLI usage and exit codes.

**Still needed from the owner:** the archive file, and a go for the real import after reading the profile.
