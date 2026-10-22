# T2a-1 - exact implementation scope and diff plan (FOR REVIEW; NOTHING IMPLEMENTED)

Status 2026-10-22. Refines `T2a_SCHEMA_AND_INGEST_PLAN.md` after inspecting the migration ledger and the current ingestion, worker and API code. Not started: no code, migration, database, Telegram or VPS action. Channel and approver ids stay out of the repository (placeholders only).
T2a-1 = write the code, the migration FILES and the tests; run only unit tests, typecheck, lint and packaging tests. T2a-2 (separate approval) = apply the migration to the named local databases and run the integration tests.

## 1. Migration ledger facts (checked, to avoid collisions)
- `packages/database/drizzle/` holds `0000`-`0006` (`0000_late_the_leader`, `0001_cheerful_lady_mastermind`, `0002_curly_rage`, `0003_colorful_sheva_callister`, `0004_r0b_idempotency_revisions_identity`, `0005_r0b_signal_evidence_unique_links`, `0006_options_claims_unverified`) and `meta/0000..0006_snapshot.json` + `_journal.json`.
- `_journal.json`: dialect postgresql, 7 entries, idx 0-6, `when` strictly increasing; last `when` = `1792493154072` (0006).
- **Next index = 7 -> `0007_telegram_user_capture_provenance`.** No file or journal entry with idx/tag 7 exists. The new `when` must exceed `1792493154072` (drizzle only applies migrations newer than the last recorded `created_at`; `drizzle-kit generate` stamps the current time, which satisfies this).
- Immutability: a migration's identity is `sha256(SQL text)` plus its journal `when` (`tests/integration/migrationState.ts`). **After any database records 0007, its SQL can never change** - fixes become `0008`. Therefore the generated SQL is reviewed as text **before** T2a-2 applies it (review gate, section 8).
- Generation: `drizzle-kit generate --name telegram_user_capture_provenance` from `packages/database` (needs `DATABASE_URL` only to satisfy the config file; as far as I know the generate step diffs the schema against the previous snapshot offline and opens no connection; I have not run it, so I would pass a non-routable placeholder URL, and a connection attempt would fail harmlessly - to be confirmed when it is run). Earlier migrations were drizzle-generated (checks come from `check()` in the schema, as in 0006); **none contains a trigger or a hand-written statement**, so 0007 would be the first.

## 2. Decisions that changed after reading the code (each needs your review)
| # | Earlier plan | Proposed now | Why |
|---|---|---|---|
| D1 | `observed_at NOT NULL`, backfilled with `received_at` | `observed_at timestamptz NULL` plus CHECK `capture_method = 'bot_webhook' OR observed_at IS NOT NULL` | The backfill needs an `UPDATE` of every existing row of the immutable raw table and hand-edited SQL. NULL = "not recorded" for legacy rows is honest and keeps the migration generate-only. (`received_at` already exists; it is the worker's insert time. `observed_at` is the API acceptance time carried in the job, so it excludes queue delay.) |
| D2 | trigger on the events table only | same, but it is the **only hand-written SQL** in 0007, appended after the generated statements with `--> statement-breakpoint` separators; the drizzle snapshot cannot represent triggers | database-enforced append-only |
| D3 | worker handles one job type | worker handler dispatches on `job.data.jobType`: `telegram_messages` (existing) and new `telegram_events` (deletes) | the current `Worker("signal_queue")` handler calls `processTelegramQueueJob` for everything |
| D4 | API computes `first_seen_edited` | the **worker** computes it (needs the database: is the original row stored?); the API stays write-free and read-free | API has no DB access in this path |
| D5 | events for all captures | events written only for `api_live`/`api_history` jobs; the existing `bot_webhook` path is unchanged except for the new column values | minimises regression risk in the deployed path |
| D6 | shared helper not specified | extract the revision id formula (`<id>_edit_<edit_date>_<sha256-12>`) from `botApi.ts` into a pure shared function used by both adapters, with a test proving identical output | one identity rule for both capture paths |
| D7 | caps unspecified | in-memory counters in the API process (single instance): `api_live` messages per hour (default 600), `api_history` messages per day (default 2000); reset on restart | simple and bounded; the capture service enforces its own, stricter caps too |

## 3. File-by-file diff plan
(Line counts are estimates of added lines; "T" = test file.)
| File | Change | ~Lines |
|---|---|---|
| `packages/database/src/schema/telegram.ts` | add to `telegramMessages`: `captureMethod` (text, default `bot_webhook`, CHECK in `bot_webhook,api_live,api_history`), `observedAt` (timestamptz null), `importedAt` (timestamptz null), `firstSeenEdited` (boolean not null default false); CHECKs: `(capture_method='api_history') = (imported_at IS NOT NULL)` and the D1 check; new table `telegramMessageEvents` (id, telegram_source_id FK restrict, telegram_message_id FK restrict NULL, external_message_id, event_type CHECK `seen,edited_observed,deleted_observed`, capture_method, observed_at, source_edit_date, content_sha256, raw_meta jsonb default `{}`, idempotency_key UNIQUE) + index `(telegram_source_id, external_message_id, observed_at)` | +75 |
| `packages/database/src/schema/index.ts` | export the new table if barrel-exported there | +1 |
| `packages/database/drizzle/0007_telegram_user_capture_provenance.sql` | generated DDL + hand-appended trigger function/trigger raising on UPDATE/DELETE of the events table | ~55 |
| `packages/database/drizzle/meta/0007_snapshot.json`, `_journal.json` | generated; journal gains idx 7 with `when` > `1792493154072` | generated |
| `packages/types/src/providers/telegram.ts` | optional `provenance?: { captureMethod; observedAt; importedAt?: Date }` on `NormalizedTelegramMessage` (optional, so existing code and tests are unaffected) | +14 |
| `adapters/telegram/src/revisionId.ts` (new) + `botApi.ts` | pure `revisionExternalId(origin, editDate, text)`; `botApi.ts` calls it (behaviour-preserving) | +20 / -6 |
| `adapters/telegram/src/userCapture.ts` (new) | `USER_CAPTURE_PROVIDER_NAME = "telegram-user-capture"`; payload types; `normalizeUserCaptureMessage(chat, message, ctx)` -> `NormalizedTelegramMessage` (same channel identity `tg_chat_<id>`, same revision key, `rawPayload` = the validated message object, media metadata only) | +150 |
| `adapters/telegram/src/index.ts` | exports | +6 |
| `packages/ingestion/src/telegram.ts` | `ingestTelegramMessages` accepts provenance; writes `captureMethod`, `observedAt`, `importedAt`; computes `firstSeenEdited` for revision rows when no original row exists (select before insert, same transaction semantics as today); unchanged conflict target | +45 |
| `packages/ingestion/src/captureEvents.ts` (new) | `buildEventKey(...)`, `recordEvent(db, ...)` with `ON CONFLICT (idempotency_key) DO NOTHING`, `recordDeletion(db, source, ids, observedAt, method)` | +110 |
| `services/worker/src/telegramEvents.ts` (new) | `processTelegramEventsJob` (delete events; no raw-table writes); the `seen`/`edited_observed` event writes used by the message path | +120 |
| `services/worker/src/index.ts` | `TelegramJobPayload` gains optional provenance; handler dispatch by `jobType`; provider name taken from the job (allow-listed: `telegram-bot-webhook`, `telegram-user-capture`); approved-chat gate applied to events jobs as well | +45 / -5 |
| `apps/api/src/internalIngest.ts` (new) | `registerInternalIngest(app, deps)`: route, hooks, JSON schema, caps, response, minimal logs | +260 |
| `apps/api/src/index.ts` | read `TWINS_CAPTURE_INGEST_TOKEN`; refuse start if it equals the API key or webhook secret or is shorter than 32 chars; call `registerInternalIngest` only when set; new `ApiOptions.captureIngestToken` for tests | +30 |
| `infrastructure/staging/docker-compose.staging.yml`, `staging.env.example` | `TWINS_CAPTURE_INGEST_TOKEN: ${...:-}` for the API only (empty = route absent); placeholder line in the example | +4 / +6 |
| `scripts/ci/verify-migrations.mjs` | also assert the 0007 columns, the events table and the append-only trigger exist (CI only, read-only) | +15 |
| `tests/unit/rehearsal/targetConfig.test.ts` | **7 -> 8 migrations**, "behind" message expectations updated to the new tag names | ~6 |
| docs | `T2a_SCHEMA_AND_INGEST_PLAN.md` (record D1-D7), `R0B_EXECUTION_REPORT.md` entry | small |
Estimated production diff: about 900 added lines in 9 new/changed source files; tests below.

## 4. Endpoint contract (internal)
`POST /internal/ingest/telegram-user`, registered only when `TWINS_CAPTURE_INGEST_TOKEN` is set (otherwise 404 from Fastify).
| Condition | Response | Records / jobs |
|---|---|---|
| request carries any of `Forwarded`, `X-Forwarded-For/Host/Proto`, `X-Real-IP` (came through a proxy) | 404 | none |
| missing/wrong/empty bearer, wrong scheme; also `TWINS_API_KEY` or the webhook secret used as bearer | 401 `Unauthorized` (checked in `onRequest`, before the body is read) | none |
| body > 2 MB, invalid JSON, schema violation, unknown fields, >100 messages, text > 20000, `api_history` without `importBatch`, chat type not `channel` | 400 / 413 | none |
| chat not approved or id unusable (existing policy object) | 403 `chat_not_approved` | none; log: reason, chat id, count only |
| hourly/daily cap exceeded | 429 `Retry-After` | none |
| queue unavailable | 503 (existing bounded-enqueue pattern) | none |
| success | 200 `{accepted, duplicates, rejected:[{id,reason}]}` | one job per message (`tg-<channelIdentifier>-<externalMessageId>`), or one `telegram_events` job for deletes |
Server clock sets `observed_at`; client time is stored only as `clientObservedAt` in event `raw_meta`. Logs: request id, counts, reason codes, chat id - never text, entities, tokens or the body.

## 5. Worker semantics (event keys, idempotency)
- Key format: `<sourceId>:<messageId>:<event_type>:<editDateUnix|0>:<hash12|0>`; `seen` once per message, `deleted_observed` once per message, `edited_observed` once per (edit date, hash).
- Message job: ingest as today (plus provenance), then look up the stored row and insert `seen` (originals) or `edited_observed` (revisions). A message first seen already edited is stored under the revision identity with `first_seen_edited=true`; a revision with an existing original has `first_seen_edited=false`.
- Delete job: insert `deleted_observed` per id (message reference NULL when unknown); **no statement touches `telegram_messages`**.
- Worker gate: the approved-chat check runs before any database access for both job types; options-only applies to message jobs exactly as now.

## 6. Test plan
**Run in T2a-1 (no database):**
- `tests/unit/api/internalIngest.test.ts` (real `buildApp`, explicit policies, fake queue): route absent when token unset; 401 matrix (none/wrong/empty/Basic/API key/webhook secret); proxy headers refused even with a valid token; non-approved/unusable chat -> 403 and `add` never called; schema rejections; batch/size limits; caps -> 429; startup refusal when the token equals another secret or is short; logs contain no text or token (canaries); duplicates in one request counted; token never echoed.
- `tests/unit/telegram/userCapture.test.ts`: mapping of message/edit/media metadata; revision key identical to the Bot API adapter on shared fixtures; text, entities and media never mutated; hostile strings; channel identity.
- `tests/unit/worker/captureJobs.test.ts` (fake database recording statements): dispatch by job type; provenance written; first-seen-edited rule; delete job issues only event inserts (assert no statement on `telegram_messages`); allow-listed provider names; approved-chat gate before any access.
- `tests/unit/database/captureMigration.test.ts`: reads the SQL text: required CHECKs, trigger statements present, no `UPDATE`/`DELETE`/`TRUNCATE` on `telegram_messages`, journal idx 7/tag/`when` ordering, snapshot consistency, file hash stable.
- Packaging: no `/internal` router label, token not in the shared anchor, worker does not receive it; mutation-checked.
- Existing suites unchanged and green (704 unit, packaging, Python T1 57), typecheck, lint.
**Written in T2a-1, run only in T2a-2 (need the migrated database):** `tests/integration/signals/telegramCapture.test.ts`: duplicate idempotent (live + history), edit revision with the original row byte-identical (hash before/after), delete event leaves raw rows untouched and is idempotent, delete of an unknown id, first-seen-edited, CHECK and trigger enforcement (`UPDATE`/`DELETE` on events raise), options-only blocking and never-approvable claims, no market request.

## 7. Knock-on effects to expect
- Adding the 0007 journal entry makes every existing 7-migration database "behind": **the integration suite, `options-demo.ts` preflight and any run against `twins_rehearsal_f2_fresh` will refuse to run until T2a-2 upgrades it** (expected, by design of the guard).
- The deployed staging image contains the 7-migration chain and is unaffected until a later build and an explicit staging migration (separate approval, after a backup).
- `scripts/ci/verify-migrations.mjs` changes only matter in CI.

## 8. Gates, rollback, boundaries
- **Review gate before T2a-2:** you approve the final generated `0007` SQL text, the snapshot diff and the trigger block; after that the file is frozen.
- **T2a-1 will not:** apply any migration, open a database connection, run integration tests, call Telegram, build or deploy anything, touch the VPS, commit or push.
- **Rollback of T2a-1:** delete the new/changed files (nothing is committed or applied); the endpoint is absent without the token, so even a merged but unconfigured build exposes nothing.
- **Approvals:** T2a-1 (this plan); review gate on the SQL; T2a-2 (apply to the named local databases and run integration tests); later, separately: commit/push, staging migration after a backup, image build, deployment, token generation, any Telegram connection.

## 9. Risks and review points
D1/D2 (the first hand-written migration statements and the NULL semantics); the in-memory caps reset on restart; the events table grows with every message (index and retention are a later decision); the `observed_at`/`received_at` distinction must be respected by analysts (documented in the schema comments); a trigger can surprise future maintenance tooling (documented, one place); API `index.ts` is already large, hence the new module.
