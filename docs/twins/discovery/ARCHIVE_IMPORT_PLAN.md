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
