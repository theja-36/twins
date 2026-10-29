# Historical archive import and signal normalization - Stage 4 / Task 1

> Decision [D-061](DECISION_LOG.md); requirement [HI-01](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md) and [MANDATORY_STOP_LOSS.md](MANDATORY_STOP_LOSS.md). Code: `packages/historical/`, `scripts/ops/historical-import.ts`, migration `0020_historical_import`.

**Purpose:** turn a local export of past Telegram messages into normalized, auditable **research records**. **It does not connect to Telegram, needs no bot or user API, scrapes nothing, and imports no credential or session file.** A historical record never becomes a live signal, an options claim, a risk decision, an approval card, an order or anything executable: the importer writes only the `historical_*` tables, which the live pipeline, the risk code and the approval bot do not read. Nothing is imported automatically anywhere (no compose service, scheduler job, worker or API route); an operator runs the command by hand. Not part of this task: outcome labeling, source scorecards, trust tiers, pattern libraries, confidence calibration.

## 1. Input contract (`historical-contract-v1`)
Local files only: **JSONL** (one object per line, preferred), **JSON** (an array, or `{ "records": [...] }`) or **CSV** (header row). A directory is read non-recursively in name order. Fields:
| Field | Rule |
|---|---|
| `channel` (required) | source channel identifier or label; 1-80 of `A-Za-z0-9 _ . : @ space -` (no `|`) |
| `message_id` (required) | string or non-negative integer; the message's id within that channel |
| `timestamp` (required) | ISO-8601 **with an explicit offset** (`Z`, `+05:30`) or Unix seconds; from 2013-08-01 to now + 1 day |
| `text` (required) | the message text (`""` for a media-only message), at most 20,000 characters, no NUL |
| `author` | handle / label (`A-Za-z0-9 _ . @ space -`); anything else is withheld with a warning |
| `market` | upper-case market code; never inferred when absent (see §4) |
| `media` | up to 20 `{type, ref}` **labels** (no file content, no `..`); invalid entries withheld |
| `edits` | up to 50 later revisions `{edited_at, text}` |
| `edited_at` | an edit marker without the edited text (kept as a warning; no revision is invented) |
CSV columns: `channel,message_id,timestamp,text[,author,market,media,edited_at,edit_text]` (`media` = `type:ref;type:ref`; `edit_text` is one edit made at `edited_at`; quoted fields and embedded newlines are supported). Unknown fields are ignored and counted (`unknown_fields_ignored`), never stored. **File-level** problems abort before any write: path missing, symlink, not a regular file, unsupported extension, empty file, file over 256 MB, binary content, malformed JSON, wrong JSON shape, bad CSV header, and any file name that looks like a credential / session / environment file (`*.session`, `*token*`, `*secret*`, `*.env`, `*.pem`, `*.key`, `*.sqlite`, `id_rsa`, ...). **Record-level** problems (`malformed_json`, `csv_row_malformed`, `invalid_channel`, `invalid_message_id`, `invalid_timestamp`, `timestamp_out_of_range`, `invalid_text`, `text_too_long`, `invalid_market`, `invalid_media`, `invalid_edits`, `too_many_edits`, `record_not_an_object`) are reported by code, file and line - never by content.

## 2. Identity, deduplication, revisions
* **Identity of one message version** = `sha256("hist-v1" | channel | message id | message timestamp (UTC) | sha256(redacted text))`. The same message delivered twice, in any file or batch, has the same identity; an edit has a different content hash and therefore a different identity.
* A repeated identity is **never a second record**: it is recorded as a `duplicate_delivery` warning (linked to the existing record), so every re-delivery stays traceable. Re-running the same import is a no-op (`ALREADY_COMPLETED`).
* The first version of a message is revision 0. Every later *new* version of the same channel + message id is a **new row** (`revision_no` 1, 2, ...) linked to revision 0 (`edit_of_id`); a database trigger enforces that a revision points at revision 0 of the same channel and message. Versions from an `edits` array carry `edited_at` and the warning `edit_revision`; a second delivery of the same id with different text or time and **no** edit marker becomes a revision with `redelivery_conflict`. An edit whose text equals an earlier version adds nothing (`edit_text_identical`). Edits arriving in a later import extend the same message's revisions.
* A **batch** is identified by `sha256(manifest, label, parser, normalizer, contract, options)`; the manifest lists each file's base name, SHA-256 and size, so the same input resolves to the same batch.

## 3. What is stored (migration 0020)
| Table | Role | Protection |
|---|---|---|
| `historical_import_batches` | label, format, manifest (base names, hashes, sizes), parser / contract versions, options, the source the operator confirmed (base name), actor, time | append-only |
| `historical_source_records` | **the evidence**: channel, original message id, message time, author, text (after redaction), content hash, `raw_text_redacted`, media refs, `edit_of_id` / `revision_no` / `edited_at`, source file + file hash + line, provenance, batch, actor, import time | **append-only and hash-chained (the twelfth chain)**; UPDATE / DELETE / TRUNCATE rejected |
| `historical_normalized_records` | one per (source record, parser version): parse status, market and its source, instrument type, underlying, expiry as stated (+ the date only if complete), strike, option type, side, entry, stop-loss, level basis, targets, time validity, conditions, **missing fields, ambiguous fields, validation result, stop-loss verdict**, the parser's own output, warnings | append-only; unique per (source, parser version) - never a second normalized claim |
| `historical_import_issues` | warnings and errors by code, file, line, source record (codes and counts only) | append-only |
| `historical_import_checkpoints` | progress per committed chunk (records consumed, counters, status) | append-only |
**Redaction:** before hashing or storing, text is scrubbed of secret-shaped strings (the repository secret scanner's own patterns, kept identical by a test), password URLs and quoted secret assignments, **e-mail addresses, international phone numbers (`+...`) and Telegram invite links** → `[REDACTED:<kind>]`; the record carries `raw_text_redacted = yes` and a `secret_redacted` warning. The original is never stored or logged.

## 4. Normalization (no duplicate parsing, no guessing)
Each message version is parsed by the **existing** deterministic `analyzeTelegramText` and checked by the **existing** shared stop-loss rule (`validateStopLoss` / `validateOptionsClaimStopLoss`); the package contains no BUY / SELL / SL / TGT pattern of its own (a test enforces it). Result: `parse_status` SIGNAL (equity directive), OPTIONS_CLAIM, AMBIGUOUS (several directives), UNSUPPORTED (unsupported options shape), NO_SIGNAL; `validation_result` **VALID** (nothing missing or ambiguous and the stop-loss VALID), **INCOMPLETE** (a field is missing), **AMBIGUOUS** (a field is unclear, or the stop-loss is present but INVALID), UNSUPPORTED, NOT_A_SIGNAL.
* **Missing** fields: `market`, `action`, `strike`, `option_type`, `expiry`, `entry`, `stop_loss`, `targets`, `level_basis`. **Ambiguous** fields: `expiry` (day/month without a year, a period word like MONTHLY, two-digit year, invalid), `strike` / `option_type` / `level_basis` when the text conflicts, `intent` (a SELL), `directives`.
* **Never fabricated:** no expiry, year, strike, entry, stop-loss or target is supplied; `expiry_date` is set only when the message stated a complete, valid date.
* **Market:** the record's `market`, else the batch's `--default-market`, else - for the three index underlyings only - the fixed mapping NIFTY / BANKNIFTY → NSE, SENSEX → BSE, labelled `underlying_mapping`; otherwise **null and listed as missing** (equity symbols are never mapped).
* **Time validity** = the parser's stated timeframe (intraday, swing, ...); **conditions** = the entry condition (`entry_above`, `entry_below`, `entry_near`, `entry_range`).

## 5. The commands (`npm run historical:import -- ...`)
```
validate <path>                                  summary only, no database
dry-run  <path> --label L [--default-market C]   summary + how many versions are already imported (read-only)
import   <path> --label L --created-by operator:NAME --confirm-source <path> --confirm-manifest <hex>
         [--default-market C] [--chunk-size N] [--allow-invalid]
report   --batch <uuid> [--json]
```
`import` requires the **exact source path** again and the **manifest hash printed by the dry run** (≥ 12 hex characters), so the operator has seen this very input; otherwise exit 3 and nothing is written. The whole input is validated first; **invalid records refuse the import unless `--allow-invalid`**, and are then recorded as ERROR issues. Work is committed in chunks (default 500, max 5,000), each chunk **in one transaction with its checkpoint**; a crash loses at most the chunk in progress, and **re-running the same command resumes** after the last checkpoint (a completed batch is a no-op). One importer per batch at a time. The importer reads no runtime control and never logs content; it prints counts, codes and ids only. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused / invalid input. It uses the owner `DATABASE_URL` like the other operations CLIs; it is not part of any service and nothing imports into staging automatically.

## 6. Report
Batch (id, label, formats, contract / parser versions, default market, manifest hash, files, confirmed source, actor, time), status (`NOT_STARTED` / `IN_PROGRESS` / `COMPLETED`), checkpoints, records consumed, source records (original messages, revisions, redacted), normalized records, duplicate deliveries, and the distributions of parse status, validation result, stop-loss result, missing fields, ambiguous fields, warnings and errors by code. Example: `parse status: NO_SIGNAL=4, OPTIONS_CLAIM=4, SIGNAL=4`.

## 7. Limitations
* The contract is this system's own; a native Telegram Desktop `result.json` must be converted to it (field mapping above). No Telegram export format is read directly.
* Parsing is the current deterministic parser (`telegram-regex-v2`): one signal per message; edited messages are normalized per revision; replies, forwards, multi-message signals and images/charts are not interpreted (media is stored as labels only).
* Time zone: only an explicit offset or Unix seconds is accepted - a local time without an offset is rejected rather than guessed. Dates before 2013-08-01 are rejected.
* Redaction is pattern-based and conservative; an unusual secret format or a name inside the text is not detected. Review exports before importing.
* Re-parsing with a newer parser version appends a new normalized record per source record (the unique key includes the parser version); no re-parse command exists yet.
* No outcome, price or performance data is attached to any record, and no source is scored or trusted on the basis of this data (later tasks).
