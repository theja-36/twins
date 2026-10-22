# R0B — Concurrency / Idempotency Design and Migration 0004 (PREPARED, NOT APPLIED)

Status: awaiting owner approval. No migration has been applied to any database. LIVE_TRADING=false.

## 1. Domain invariants (from planning pack + schema + parser)
Verified:
- **Raw message identity:** `(telegram_source_id [channel], external_message_id)` is unique (`telegram_messages_source_external_id_unique`). Source uniqueness: `telegram_sources_channel_unique`. Cross-channel collisions of the same message id are therefore legitimate and kept separate.
- **Edits:** an edit is a separate, append-only raw row with `externalMessageId = "<id>_edit"` (botApi.ts). Originals are never modified. **Finding:** every edit of the same message maps to the same `<id>_edit`, so a *second* edit is dropped as a duplicate (data loss for edit history). Not changed here; needs a decision (e.g. include `edit_date` in the id).
- **Parser:** `parseTelegramSignal` returns at most ONE signal per message text (first BUY/SELL match).
- **Planning pack:** `SignalVersion` = (signal_id, version, raw_event_id, parser_version, ...); owner must be able to inspect original, edits and *parser version* (01_PRODUCT_SCOPE, 04_DATA_CONTRACTS, 03_ARCHITECTURE "Versioning"). Validation/analysis snapshots are immutable history; "never rewrite old history" (04_DATA_CONTRACTS).
- **Current schema:** no version/parser_version columns; `signal_validations` documents "multiple rows per signal over time"; an existing test asserts re-validation appends.

Conclusion: `UNIQUE(signals.telegram_message_id)` alone is **not** justified: it would forbid a legitimate re-parse under a new parser version. The justified key is `(telegram_message_id, parser_version)`.

**Decisions needed from the owner (not silently assumed):**
1. Confirm that one raw message yields at most one signal *per parser version* (matches the current parser). If multi-leg messages must yield several signals per parse, add an ordinal to the key (`UNIQUE(telegram_message_id, parser_version, ordinal)`) before approving.
2. Confirm that an edit (`_edit` raw row) is a *new raw event with its own signal*, not a new version of the original signal. (Today's model; the planning-pack `signal_id + version` linkage between original and edit is not implemented.)
3. Edit-history loss on repeated edits (above): fix now or later?
4. Existing duplicate rows (section 4): approve remediation.

## 2. Idempotency chain audit
| Step | Mechanism | Race status |
|---|---|---|
| telegram_sources resolve | insert ON CONFLICT DO NOTHING + re-select | safe |
| telegram_messages insert | unique (source, external id) + ON CONFLICT DO NOTHING | safe |
| instruments resolve | unique (exchange, symbol) + conflict re-select | safe |
| market_observations | unique dedupe key + conflict handling | safe |
| **signal creation** | was: no unique key; worker select-then-insert | **RACE: N concurrent workers -> N signals (demonstrated: 4 callers -> 4 signals)** |
| **ingest-triggered validation** | was: worker check + unconditional insert | **RACE: N validations (demonstrated: 4 -> 4 rows)** |
| partial-failure resume | duplicate message used to skip signal creation | fixed earlier (resume); still raced on the two rows above |
| jobs / provider_health rows | one row per attempt, append-only by design | not a business duplicate |
| queue jobId dedupe | only while job retained | not a DB correctness boundary |
Also: signal + validation are separate statements (no transaction spanning them). That is acceptable because each step is independently idempotent, so any retry resumes from what is missing.

## 3. Proposed design (implemented in the working tree, migration unapplied)
Schema (migration `packages/database/drizzle/0004_r0b_idempotency_keys.sql`, journal + snapshot updated):
```sql
ALTER TABLE "signals" ADD COLUMN "parser_version" text DEFAULT 'telegram-regex-v1' NOT NULL;
ALTER TABLE "signal_validations" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX "signals_telegram_message_parser_unique" ON "signals" ("telegram_message_id","parser_version");
CREATE UNIQUE INDEX "signal_validations_idempotency_key_unique" ON "signal_validations" ("idempotency_key");
```
- NULLs are distinct in PostgreSQL unique indexes, so non-Telegram signals (NULL message id) and ordinary keyless validations remain unlimited.
- **Signals:** `createSignalFromTelegramMessage` inserts with `ON CONFLICT (telegram_message_id, parser_version) DO NOTHING`; the loser selects the canonical row and returns `{created:false, reused:true, signalId}`. A new parser version (option `parserVersion`) is a legitimate additional row.
- **Validations:** the worker passes `idempotencyKey = "telegram-ingest:<signalId>"`; `validateSignal` fast-paths an existing keyed row, else computes and inserts with `ON CONFLICT (idempotency_key) DO NOTHING`, loser re-selects (`reused:true`). Calls without a key append history exactly as before. Note: a conflict loser's `result` is its own computation, not necessarily what was stored — `validationId` is the canonical reference (documented in the type).
- **Partial retry:** each stage returns the canonical record, so a retry after "signal exists, no validation" creates only the validation; after "both exist" it is a no-op.
- Not claimed: exactly-once delivery. The guarantee is "no duplicate business records for the same (message, parser version) / ingestion key".
- Worker code: `services/worker/src/index.ts`; signals: `packages/signals/src/{ingestSignal,extract}.ts`; decisions: `packages/decision-intelligence/src/{engine,persist}.ts`; schema: `packages/database/src/schema/{signals,signalValidations}.ts`.

## 4. Read-only preflight (disposable DB 127.0.0.1:15432/twins_dev, `BEGIN READ ONLY` ... `ROLLBACK`)
Queries: `docs/implementation/R0B_0004_preflight.sql`. Results:
- `signals` per `telegram_message_id` > 1: **2 messages, 4 signals each** — both are in channels `@r0b_conc_same_991755144` and `@r0b_conc_ver_550680818`, created within milliseconds by the concurrency tests I ran *before* the fix to demonstrate the race. They would make `CREATE UNIQUE INDEX` fail. They are test artifacts, not production data (the only @r0b_conc_* data: 12 signals).
- duplicate raw messages `(source, external_id)`: 0.
- table sizes: signals 198, signal_validations 82 (index builds are instantaneous; brief ACCESS EXCLUSIVE/SHARE lock).
**Proposed remediation (needs approval, not performed):** delete only rows in channels `@r0b_conc_*` (signals cascade to validations; messages/sources may be left). Exact statements to be shown for review before running.

## 5. Tests prepared (`tests/integration/runtime/concurrency.test.ts`)
Queue dedupe bypassed (direct worker executions with distinct job ids). A barrier gate holds all N callers just before their INSERT into a chosen table until all arrive (deterministic overlap, not sleeps). Cases: (1) N=4 same message -> 1 message/1 signal/1 validation with correct canonical references; (2) N=4 concurrent keyed validations -> 1 row, keyless re-validation still appends 2; (3) same external id in two channels -> 2 separate chains, distinct ids; (4) injected failure before validation insert, then N=3 concurrent retries -> 1 signal/1 validation; (5) same message under two parser versions -> 2 signals, N=3 concurrent same-version -> 1.

## 6. Checks actually executed
- BEFORE the fix (current unmigrated schema, original code): concurrency tests 4 failed / 1 passed — signals 4 (expected 1), validations 4 (expected 1), partial-retry validations 3 (expected 1); cross-channel case passed. This demonstrates the races.
- AFTER code + schema edits, **against the unmigrated dev DB**: `npm run test:integration` = **32 failed / 78 passed (110)**. 27 of the 32 fail directly with `column "parser_version" ... does not exist` / failed-query errors; the remaining 5 (concurrency x2, e2e, 2 failureHandling) are timeouts/rejected processors consistent with the same cause but not individually proven. **The new code is therefore NOT verified green; this is expected until the migration is applied.**
- `npx vitest run tests/unit`: 22 files / 189 tests passed. `npx tsc -b`: exit 0. `git diff --check`: clean.
- Migration SQL itself was generated by drizzle-kit but **not executed anywhere** (no local Postgres binary available; no scratch DB created).

## 7. Lint warnings (exact)
Measured with `eslint -f json`, comparing `git archive HEAD` vs working tree:
- HEAD: **32** warnings. Working tree now: **31**, 0 errors.
- Previously reported counts (34, 39) are not reproducible from a clean baseline; per-file comparison shows the only changes vs HEAD were: `services/worker/src/index.ts` 1 -> 0, and new test files under `tests/integration/runtime/` which at one point carried 22 non-null-assertion warnings (concurrency 15, failureHandling 4, e2ePipeline 3). Those were introduced by this R0B work and have been removed (replaced with a `must()` helper). No other file's warning count changed vs HEAD. (Other pre-existing warnings are those present at HEAD.)

## 8. Proposed approval-time commands (do not run until approved)
Target: disposable test DB `postgresql://twins:twins_dev_password@127.0.0.1:15432/twins_dev` (side effects: adds 2 columns/indexes to `signals` and `signal_validations`; brief table locks; existing rows backfilled with parser_version `telegram-regex-v1`).
1. (Optional, recommended) rehearse on a throwaway scratch database first: `CREATE DATABASE twins_scratch` on the same server, then migrate it.
2. Preflight again (read-only): `node` script / psql running `docs/implementation/R0B_0004_preflight.sql` — expect 0 duplicate rows after approved remediation.
3. Apply: `DATABASE_URL=... npm run db:migrate -w @twins/database`
4. Verify: `DATABASE_URL=... REDIS_URL=redis://127.0.0.1:16379 LIVE_TRADING=false npx vitest run --config vitest.integration.config.ts tests/integration/runtime` then `npm run test:integration`, unit, `tsc -b`, eslint.
**Rollback limitations:** the SQL is additive; manual rollback = `DROP INDEX ...; ALTER TABLE ... DROP COLUMN ...` (drops `idempotency_key` values and `parser_version` values; no data is otherwise lost). Drizzle has no automatic down migration and the repo policy is "no destructive down migration in production without review". After rollback, the worker/signals code in this tree would need reverting too (it writes the new columns).

---

# Revision 2 (staged review; supersedes conflicting statements above)

**Status honesty:** the working tree depends on the unapplied migration `0004_r0b_idempotency_and_revisions` (regenerated; replaces the earlier `0004_r0b_idempotency_keys`, which was never applied anywhere). It is **not integration-green** against `twins_dev`. Previous result (32 failed / 78 passed, 27 attributable to the missing column, 5 not individually examined) stands as historical; the 5 will be examined individually in the migrated rehearsal DB. Nothing has been applied, deleted, committed or pushed.

## 1. Product boundaries
- One signal per parse is a **parser capability limit** (parser version `telegram-regex-v1`), not a product invariant.
- Implemented: `analyzeTelegramText` returns `ambiguous` when a message holds more than one distinct (direction, symbol) directive; `createSignalFromTelegramMessage` then creates **no signal** and returns `{created:false, ambiguous:true, reason}` (raw message is still stored). The same directive repeated is one signal. Caveat: previously a message such as "BUY X ... SELL AT 2900" produced a signal from the first directive; it is now ambiguous (conservative by design).
- **Future multi-signal path (not implemented):** add `signal_ordinal int NOT NULL DEFAULT 0` (position of the directive within the parse, deterministic per parser version because the parser version pins the algorithm), create `UNIQUE(telegram_message_id, parser_version, signal_ordinal)` and drop the 2-column index in one migration. Existing rows keep ordinal 0, so no data rewrite. Distinct signals stay distinct because ordinal is derived from text position, never from processing order or randomness. **Owner decision:** keep the 2-column key now (recommended; avoids a speculative column) or add the ordinal column now.

## 2. Edit identity (implemented in adapter + schema; migration unapplied)
Inspected: Telegram update has `update_id` (per-bot delivery), message has `message_id` (per chat), `date` (ORIGINAL send time, also on edits) and, on edits, `edit_date` (seconds). `edit_date` was missing from our TypeScript type but is present in stored `rawPayload` for real edits.
| Layer | Identity |
|---|---|
| Original message | `(channel, message_id)` -> `externalMessageId = "<message_id>"` |
| Content revision | `(channel, message_id, edit_date, sha256(text)[:12])` -> `"<message_id>_edit_<edit_date>_<hash12>"` |
| Delivery | `update_id`, kept in `rawPayload` only; **not** the dedupe key, so a redelivered edit (new update_id, same content) collapses while a later or different edit is preserved |
No processing time or random ids. An edit without numeric `edit_date` is rejected with `ProviderDataError` (400) instead of inventing an identity. The text hash disambiguates two different edits within the same second.
Minimum linkage (columns on `telegram_messages`, set at insert only): `origin_message_id` (Telegram id of the original, shared by all revisions) and `edit_date`; index `(telegram_source_id, origin_message_id)`. No FK, because the original may never have been received.
- **Approval invalidation:** approval/execution are not implemented. The available structural boundary: each revision is its own raw row -> its own `signals.id` -> its own validations (key `telegram-ingest:<signalId>`); nothing links a revision's signal to the original's validation, so anything keyed on signal/validation id cannot silently carry over. Tested (revisions.test.ts, pending migrated DB). **Not implemented / owner decisions:** (a) whether an earlier signal should be marked superseded when a revision arrives (needs a `signal_status` value or link, plus approval service semantics), (b) revision `signalTimestamp`: edits currently inherit the ORIGINAL `date`; using `edit_date` for the edited content's knowledge time is arguably more correct for no-look-ahead; unchanged pending your decision.
- **Related identity risk (reported, not changed):** `channelIdentifier` prefers `@username`; if a channel is renamed the same chat would split into two sources and message identity scoping would split. Stable key is `chat.id`. Needs a decision/migration (e.g. store chat id on `telegram_sources`).
- Legacy `<id>_edit` rows: `origin_message_id`/`edit_date` stay NULL (raw rows are immutable; no rewrite). Queries can derive the origin by stripping the suffix. Their payloads keep `edit_date` if Telegram sent it.

## 3. Legacy data
- **parser_version default `telegram-regex-v1`:** basis is repository evidence only — `packages/signals/src/extract.ts` has a single commit (Phase 6, `338227a`) so exactly one extractor version has ever existed in history. This is an inference, not recorded provenance; no historical per-row parser provenance exists. Alternative: backfill a sentinel like `legacy-unversioned`, which is more honest but means a retried legacy message would create a second signal under `telegram-regex-v1`. **Owner decision:** accept the inference (recommended, documented here and in the migration notes) or use the sentinel and accept the duplicate-on-retry behaviour.
- **Validation after migration:** legacy validations have NULL `idempotency_key`. A retry of an old signal would, with the key alone, create one extra ingestion validation. **Mitigation implemented (no UPDATE of immutable rows):** the ingestion path stands down if the signal already has ANY validation (keyed, keyless or legacy); the key only guards the concurrent first-validation race. Keyless re-validation by explicit callers still appends history. A key backfill (`UPDATE ... SET idempotency_key`) is deliberately **not** proposed; it would touch immutable audit rows and could mislabel a manual validation as ingestion-triggered. Tested in `revisions.test.ts` (legacy case) and observable in the upgrade rehearsal.
- Existing duplicate signals (demonstration artifacts, `@r0b_conc_*`) will block the unique index in `twins_dev`; remediation stays separately approved. The upgrade rehearsal proves the failure and the fix on scratch fixtures only.

## 4. Changed files this revision
Adapter/types: `adapters/telegram/src/botApi.ts`, `packages/types/src/providers/telegram.ts`. Ingestion/schema: `packages/ingestion/src/telegram.ts`, `packages/database/src/schema/telegram.ts`, migration `packages/database/drizzle/0004_r0b_idempotency_and_revisions.sql` (+ snapshot, journal). Signals: `packages/signals/src/{extract,ingestSignal}.ts`. Worker: `services/worker/src/index.ts`. Tests: `tests/unit/adapters/telegram/botApi.test.ts`, `tests/unit/signals/extract.test.ts`, `tests/integration/runtime/revisions.test.ts` (new), `concurrency.test.ts` unchanged logic. Docs: `R0B_REHEARSAL_PLAN.md`, `rehearsal/*`.
Migration SQL:
```sql
ALTER TABLE "telegram_messages" ADD COLUMN "origin_message_id" text;
ALTER TABLE "telegram_messages" ADD COLUMN "edit_date" timestamp with time zone;
ALTER TABLE "signals" ADD COLUMN "parser_version" text DEFAULT 'telegram-regex-v1' NOT NULL;
ALTER TABLE "signal_validations" ADD COLUMN "idempotency_key" text;
CREATE INDEX "telegram_messages_origin_idx" ON "telegram_messages" ("telegram_source_id","origin_message_id");
CREATE UNIQUE INDEX "signals_telegram_message_parser_unique" ON "signals" ("telegram_message_id","parser_version");
CREATE UNIQUE INDEX "signal_validations_idempotency_key_unique" ON "signal_validations" ("idempotency_key");
```

---

# Revision 3 (owner decisions applied; supersedes Revision 2 where they conflict)

**Status honesty:** still not integration-green against `twins_dev` (migration unapplied). Integration tests added/changed in this revision (`revisions.test.ts`, updated `concurrency.test.ts`, `e2ePipeline`, `failureHandling`) have never been run against a migrated schema. Unit tests, typecheck and lint were run (see report). Nothing applied, created, dropped, deleted, committed or pushed.

## 1. Signal key
`UNIQUE(telegram_message_id, parser_version)` is kept. **This is a one-signal-per-parse capability limit of parser `telegram-regex-v1`, not a permanent product restriction.** No `signal_ordinal` now; a future multi-signal parser version can add it (see Revision 2 section 1). Messages with several distinct directives are rejected as ambiguous (no signal, raw message kept). Tests document that ordinary exit phrasing ("... SELL AT 2900") is *also* rejected as ambiguous because "AT" is read as a symbol: conservative behaviour, explicitly not an understanding of entry/exit pairs (`tests/unit/signals/extract.test.ts`).

## 2. Legacy parser provenance and retry vs reparse
- Migration backfills existing rows with the explicit label **`legacy-unversioned`** (provenance unknown, not inferred), then drops the column default so every new insert must state its version. (The earlier inference "telegram-regex-v1" is withdrawn.)
- **Resume/retry** (`createSignalFromTelegramMessage`): reuses the signal under the current parser version if present; else the single existing signal (e.g. a legacy one); else, with several existing signals and none under the current version, returns `reconciliationRequired` - nothing is created, chosen or deleted; the worker raises `ReconciliationRequiredError`, mapped at the queue boundary to BullMQ `UnrecoverableError` (permanent failed-set entry with reason). A new current-parser signal is created only when NO signal exists.
- **Explicit reparse** (`reparseTelegramMessage`, new): requires a named, implemented parser version (unknown version throws), creates or idempotently reuses exactly that (message, version) signal, touches nothing else.
- Legacy duplicates (several signals, same message, all `legacy-unversioned`) violate the new unique index, so they BLOCK the migration until remediated separately; the code never picks one arbitrarily.

## 3. Validation provenance
"Any validation exists" is no longer treated as proof. Only a row with this signal's key `telegram-ingest:<signalId>` is demonstrably the ingestion validation. Keyless (legacy/manual) validations are preserved untouched and are of *unknown provenance*; the worker logs this and appends exactly ONE keyed ingestion validation (the key makes later retries and races no-ops). Cost: a retried legacy signal gets one extra validation snapshot, auditable by its key. No UPDATE of audit rows, no invented history. Keyless explicit re-validation still appends.

## 4. Edit timing and currentness
- Stored separately: `message_timestamp` = ORIGINAL date (preserved), `edit_date` = revision effective time, `received_at` = ingestion time, `raw_payload` incl. `update_id`.
- Availability timestamp: `signals.signal_timestamp` = `edit_date` for revisions, message date for originals (legacy `_edit` rows have no edit_date and fall back to the original date).
- Currentness (`packages/ingestion/src/telegramRevisions.ts`, `classifyRevisions`/`getRevisionStates`): derived from stored `edit_date` only, never arrival order. Original < any edit even if it arrives late; highest `edit_date` is `current`; older edits `superseded`; edit-before-original is `current` until the original arrives (then the original is `superseded`); several distinct revisions sharing the highest `edit_date` (same second) are all `ambiguous` (non-actionable); any legacy `_edit` row (unknown time) makes the group's edits `ambiguous`. A repeat delivery of an identical edit maps to the same row. Tested: pure unit tests over every arrival-order permutation; DB tests in `revisions.test.ts`.
- **Approval/execution are not built; approval invalidation is NOT implemented.** Required future invariant: an approval binds to (signal id, validation id, raw message id) and is valid only while that raw message is `current` when checked at approval time AND again at execution time; a newer revision arriving later, or an `ambiguous` group, makes it non-actionable. Edited/new-version signals are distinct rows and cannot inherit an approval keyed on the old ids (structural boundary, tested).

## 5. Channel identity and update_id
- New events use Telegram `chat.id` as canonical identity: `channelIdentifier = tg_chat_<id>`, `telegram_sources.chat_id` (unique), `@username`/title only in `display_name` (updated on change). Renames keep one source (tested). A legacy `@username` source is never merged by guess (tested).
- Legacy recovery (read-only inspection of `twins_dev`, 332 sources): payloads carry a recoverable chat id for 34 sources, 0 conflicting, 298 with none (empty fixture payloads). **All 34 recoverable sources carry the same chat id (-1001999999999)** - an artifact of my earlier tests reusing one chat id under different usernames - so a unique-chat-id backfill would be ambiguous for all of them. Policy (`rehearsal/backfill_source_chat_ids_*.sql`): set `chat_id` only if all of a source's payloads agree, the id is not shared with another source and not already assigned (or the legacy `tg_chat_<id>` name encodes it consistently); otherwise report `conflicting` / `ambiguous_shared_chat_id` / `unrecoverable` and leave NULL. On `twins_dev` today that would yield 0 recoverable (34 ambiguous, 298 unrecoverable). Note this means such legacy sources and new chat-id sources of the same channel remain separate until reconciled by a human.
- Terminology corrected: `update_id` identifies an *update*; a repeat delivery of the same update carries the same `update_id`. It is retained in `raw_payload` and as `NormalizedTelegramMessage.updateId`, but deduplication is on the content-revision identity `(chat, message_id, edit_date, text hash)`, a different concern from delivery.

## 6. Changed files (this revision)
Schema/migration: `packages/database/src/schema/{telegram,signals,signalValidations}.ts`, `drizzle/0004_r0b_idempotency_revisions_identity.sql` (hand-edited parser_version backfill), snapshot, journal. Code: `adapters/telegram/src/botApi.ts`, `packages/types/src/providers/telegram.ts`, `packages/ingestion/src/{telegram,telegramRevisions,index}.ts`, `packages/signals/src/{extract,ingestSignal}.ts`, `packages/decision-intelligence/src/{engine,persist}.ts`, `services/worker/src/{index,jobErrors,jobTimestamp}.ts`. Tests: unit (`botApi`, `extract`, `telegramRevisions`, `webhookAuth`, `jobTimestamp`), integration (`revisions`, `concurrency`, `e2ePipeline`, `failureHandling`, `harness`, two direct-insert fixtures given `parserVersion`). Rehearsal: `R0B_REHEARSAL_PLAN.md`, `rehearsal/*`.

Migration SQL (as it would be applied):
```sql
ALTER TABLE "telegram_messages" ADD COLUMN "origin_message_id" text;
ALTER TABLE "telegram_messages" ADD COLUMN "edit_date" timestamp with time zone;
ALTER TABLE "telegram_sources" ADD COLUMN "chat_id" text;
ALTER TABLE "signals" ADD COLUMN "parser_version" text DEFAULT 'legacy-unversioned' NOT NULL;
ALTER TABLE "signals" ALTER COLUMN "parser_version" DROP DEFAULT;
ALTER TABLE "signal_validations" ADD COLUMN "idempotency_key" text;
CREATE INDEX "telegram_messages_origin_idx" ON "telegram_messages" ("telegram_source_id","origin_message_id");
CREATE UNIQUE INDEX "telegram_sources_chat_id_unique" ON "telegram_sources" ("chat_id");
CREATE UNIQUE INDEX "signals_telegram_message_parser_unique" ON "signals" ("telegram_message_id","parser_version");
CREATE UNIQUE INDEX "signal_validations_idempotency_key_unique" ON "signal_validations" ("idempotency_key");
```

---

# Revision 4 (owner decisions on legacy snapshots and unresolved identity)

1. **Legacy retry snapshot.** When a retried signal has keyless validations, the worker appends exactly one newly computed snapshot under the distinct key `telegram-ingest-recompute:<signalId>` (not `telegram-ingest:`), so it is identifiable as a recomputation made at retry time. Its `validated_at` is the computation time (always later than the signal's availability time); it is not historical evidence from the original signal time. Existing keyless rows are never updated (tested: id, key NULL, `validated_at` and rationale unchanged). Either key stops further snapshots. Fresh signals still use `telegram-ingest:<signalId>`.
2. **Unresolved identity.** Legacy username-only sources and new chat-id sources stay separate until explicit reconciliation; nothing is merged by guess. Source reliability is currently always `UNKNOWN` (no source-performance tracking exists), so no legacy reliability/history is inherited; any future provider-history feature must key on the resolved source and treat unresolved identity as UNKNOWN.
3. **Rehearsal execution plan:** `docs/implementation/rehearsal/run_rehearsal.sh` (stop-on-first-failure, logs in `$R/logs`, no automatic cleanup) and manual `cleanup_rehearsal.sh`. `tests/integration/runtime/envGuard.test.ts` (active only with `TWINS_REHEARSAL=1`) fails unless `DATABASE_URL` is `127.0.0.1:15432/twins_rehearsal_{fresh,upgrade}`, `REDIS_URL` is `127.0.0.1:16379` and `LIVE_TRADING=false`. Verified: passes for the rehearsal URLs; fails for `twins_dev`, for a default Redis port, and for a missing `REDIS_URL`.
