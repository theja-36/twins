# Task T2a - Provenance schema, append-only events and internal ingest endpoint (PLAN ONLY; NOT EXECUTED; separate approval required)

No Telegram connection, no VPS change, no staging migration in T2a. All work and tests are local, against the guarded local PostgreSQL/Redis targets. The channel id is `<SOURCE_CHANNEL_ID>` (configuration only).

## 1. Migration `0007_telegram_user_capture_provenance`
Applies to `telegram_messages` (immutable raw store; no UPDATEs are needed because new columns are written at INSERT):
| Column | Type | Rule |
|---|---|---|
| `capture_method` | text NOT NULL DEFAULT `'bot_webhook'` | CHECK in (`bot_webhook`,`api_live`,`api_history`); existing rows keep `bot_webhook` |
| `observed_at` | timestamptz NOT NULL | when TWINS observed this content (server clock); backfill = `received_at` |
| `imported_at` | timestamptz NULL | CHECK `(capture_method = 'api_history') = (imported_at IS NOT NULL)` |
| `first_seen_edited` | boolean NOT NULL DEFAULT false | true when the first observation already carried an `edit_date` |
New table `telegram_message_events` (**append-only**):
| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | default generated |
| `telegram_source_id` | uuid NOT NULL | FK `telegram_sources` ON DELETE RESTRICT |
| `telegram_message_id` | uuid NULL | FK `telegram_messages` ON DELETE RESTRICT; NULL when the event concerns a message TWINS never stored (e.g. delete of an unknown id) |
| `external_message_id` | text NOT NULL | Telegram message id as string |
| `event_type` | text NOT NULL | CHECK in (`seen`,`edited_observed`,`deleted_observed`) |
| `capture_method` | text NOT NULL | CHECK in (`api_live`,`api_history`,`bot_webhook`) |
| `observed_at` | timestamptz NOT NULL | server clock |
| `source_edit_date` | timestamptz NULL | Telegram's `edit_date` for edit events |
| `content_sha256` | text NULL | hash of the text at that revision; **never the text** |
| `raw_meta` | jsonb NOT NULL DEFAULT `{}` | content-free metadata only (views/forwards counters, batch id, client-claimed time); size-bounded and schema-validated by the API |
| `idempotency_key` | text NOT NULL UNIQUE | `<source>:<message_id>:<event_type>:<edit_date or 0>:<hash12 or 0>`; one `seen` and one `deleted_observed` per message |
Index on `(telegram_source_id, external_message_id, observed_at)`. A trigger on this table raises an error on `UPDATE` and `DELETE` (append-only enforced by the database). A matching trigger on `telegram_messages` is **proposed as a separate hardening step**, not part of T2a, because existing tooling and rehearsal data should be reviewed first.
Idempotency, revisions and deletions use the existing mechanisms [R]: raw rows are keyed `(source, externalMessageId)` where revisions use `<id>_edit_<edit_date>_<hash12>`; deletions write only an event.
Process rules from the repository: generate with drizzle, update the journal and snapshot, pass `scripts/ci/verify-migrations.mjs` and the migration-hash check in the integration global setup.

## 2. Internal ingest endpoint
`POST /internal/ingest/telegram-user` in `apps/api`. **Fail closed:** registered only when `TWINS_CAPTURE_INGEST_TOKEN` is set (otherwise the route does not exist: 404).
- **Network:** never given a Traefik label (a packaging test asserts the only public router rules are `Path(/health)`); additional in-app guard refuses any request carrying `X-Forwarded-*` or `Forwarded` headers (i.e. one that came through the proxy) even with a valid token.
- **Authentication:** `Authorization: Bearer <TWINS_CAPTURE_INGEST_TOKEN>`, constant-time comparison; a token distinct from `TWINS_API_KEY` and the webhook secret; checked in an `onRequest` hook **before the body is read**; failures return 401 with minimal metadata logs.
- **Limits:** body max 2 MB; at most 100 messages per call; per-minute request cap; hourly message cap for `api_live` (configurable) answered with 429 and a log record (alerting is wired in T2b).
- **Payload (schema version 1):**
```
{ "schemaVersion": 1,
  "captureMethod": "api_live" | "api_history",
  "event": "message" | "delete",
  "chat": { "id": <integer>, "type": "channel" },
  "messages": [ { "id": int, "date": unixSeconds, "editDate"?: unixSeconds, "text"?: string(<=20000),
                  "entities"?: [..bounded..], "media"?: {kind, mime?, size?, duration?, width?, height?, fileUniqueId?},
                  "views"?: int, "forwards"?: int, "authorSignature"?: string(<=128), "hasProtectedContent"?: bool } ],   // event=message
  "deletedMessageIds"?: [int, ... <=100],                                                                            // event=delete
  "clientObservedAt"?: ISO, "importBatch"?: { "batchId": uuid, "lowestMessageId": int, "lowestMessageDate": unixSeconds } }
```
Unknown top-level fields are rejected; string lengths and array sizes are bounded; `chat.id` must be a canonical integer.
- **Server-side decisions:** `observed_at` and `imported_at` come from the server clock (client time is stored only as `clientObservedAt` inside `raw_meta`); `capture_method` comes from the payload but `api_history` requires an `importBatch`.
- **Allowlist:** reuses `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` through the existing policy object [R]. A chat that is not approved (or an unusable id) -> HTTP 403 `chat_not_approved`, **nothing is enqueued**, a metadata-only log (reason, chat id, count). The worker repeats the check on every job.
- **Options-only gate and parser:** unchanged in the worker [R]; the API does not classify text.
- **Queueing:** one job per message with the existing deterministic id `tg-<channelIdentifier>-<externalMessageId>`; edits use the revision identity; the job payload carries `providerName="telegram-user-capture"`, `captureMethod`, `observedAt`, `importedAt`, `firstSeenEdited`. Deletions enqueue a small `telegram_events` job (no parsing). The API performs **no database writes**: the worker writes raw rows and events.
- **Response:** `{ accepted, duplicates, rejected:[{id,reason}] }`, 200 on success; 4xx for schema/auth/chat errors; 503 on queue unavailability using the existing bounded-enqueue pattern [R].
- **Logging:** request id, counts, reason codes, chat id; never message text, entities, tokens or the body.

## 3. Worker changes
- Accept the new job shape; insert provenance columns at INSERT; compute `first_seen_edited`.
- For `message` with `editDate`: if the original row exists -> revision row + `edited_observed` event; if not -> revision-identity row only (never labelled as the original) with `first_seen_edited=true`.
- For first sight of a new message: row + `seen` event. For `delete`: look up by `(source, message id)`, insert `deleted_observed` (null message ref when unknown); never touch raw rows.
- Event inserts use `ON CONFLICT (idempotency_key) DO NOTHING`.
- Provider name constant for logs/jobs; existing gates unchanged.

## 4. Configuration and packaging (local files only; not deployed in T2a)
Compose passes `TWINS_CAPTURE_INGEST_TOKEN` to the API from the env file with an empty default (route disabled when empty) - the local file change is made and tested, but **not installed on the VPS**. `staging.env.example` documents the variable as a placeholder. Packaging tests assert: no `/internal` router rule, the token is not in the shared anchor, the worker does not receive it.

## 5. Test plan (all must pass before T2a is called done)
Unit (API, fake queue; real `buildApp`, explicit policies, no allow-all wrapper):
1. **Unauthorized internal caller rejected:** no header, wrong token, empty token, `Basic` scheme -> 401, `queue.add` never called; token unset -> 404; valid token **with** `X-Forwarded-For` -> refused; the endpoint cannot be reached with `TWINS_API_KEY` or the webhook secret.
2. **Non-allowed chat rejected:** other chat id, empty allowlist, string/float/zero id -> 403 and no job; allowed chat -> 200.
3. Schema: unknown field, wrong `captureMethod`, `api_history` without `importBatch`, >100 messages, text >20000, oversized body, non-channel type -> 4xx, no job.
4. Caps: hourly cap returns 429 with a log; logs never contain text or tokens (canary strings).
Integration (guarded local database and real Redis queue; real worker path):
5. **Duplicate idempotent:** the same message sent twice (and once live, once as history) -> one raw row, one job, `duplicates` counted in the response.
6. **Edit creates a revision without changing the original:** hash of the original row before/after identical; revision row and `edited_observed` event exist; replay of the same edit adds nothing.
7. **Delete does not delete:** after a delete event the raw message and all revisions are byte-identical and present; one `deleted_observed` event; a second delete is idempotent; delete for an unknown id creates an event with a NULL message reference and no message row.
8. **First-seen-edited:** a history message with `editDate` is stored under the revision identity with `first_seen_edited=true`, `capture_method=api_history`, `imported_at` and `observed_at` set.
9. **Database rules:** CHECK rejects `api_history` without `imported_at` and the reverse; the events table rejects UPDATE and DELETE (trigger); duplicate `idempotency_key` conflicts.
10. **Options-only and parser:** an equity-style message through the endpoint is blocked by the worker with no signal/instrument/market request; an options message becomes an UNVERIFIED claim that stays never-approvable.
11. **Migration rehearsal:** upgrade `twins_rehearsal_f2_fresh` (existing rows: `capture_method='bot_webhook'`, `observed_at=received_at`), fresh chain on the CI database, journal/hash verification, and a reviewed reverse script exercised on a scratch copy.
12. Regression: all existing unit (685) and integration (170 passed / 5 skipped) suites, typecheck, lint, packaging tests (mutation-checked for the new `/internal` assertion), network guard active (no external requests).

## 6. Rollback plan
- Code: `git revert` of the T2a commits; the endpoint is absent when the token is unset, so even a merged-but-unconfigured build exposes nothing.
- Local databases: rehearsal targets are disposable; run the reviewed reverse script (drop events table and triggers; drop the new columns/constraints) or recreate from the migration chain.
- Staging is **not migrated in T2a**; when it is (T2b), the rollback is the proven backup + restore procedure taken immediately before, plus the reverse script only while no `api_live`/`api_history` data exists.

## 7. Approval boundaries
- **T2a-1:** approve implementation and unit tests (code + tests, no database writes).
- **T2a-2:** approve running the migration and integration tests against the named local databases (`twins_rehearsal_f2_fresh` upgrade rehearsal, CI database fresh chain) - these are the guarded local targets only.
- **Not in T2a (separate approvals):** committing/pushing; staging migration (needs a fresh backup); image build; deployment; token generation on the server; any Telegram connection.

## 8. Risks
Schema design mistakes are cheap to fix now and expensive after capture data exists; the append-only trigger could surprise future maintenance tools (documented); `first_seen_edited` and the revision identity for history rows must be respected by every later analysis (covered by tests and a note in the analysis plan); an internal route is only as private as the network, hence the proxy-header guard, packaging test and the unrouted Traefik policy.

## 9. As built (T2a-1 / T2a-2, 2026-10-22) - approved deviations and mutation matrix
**Approved deviations from the plan:** (1) a `BEFORE TRUNCATE` statement trigger on `telegram_message_events` in addition to UPDATE/DELETE (kept by owner decision); (2) `telegram_message_events.capture_method` allows only `api_live` and `api_history` (the bot-webhook path writes no events); (3) no change to `packages/types`; (4) a hand-written strict payload validator (Fastify's default ajv strips unknown fields); (5) the route exists only when `TWINS_CAPTURE_INGEST_TOKEN` is set (32-256 chars, distinct from the API key and webhook secret) and the compose/env example carry an empty entry; (6) default caps 60 req/min, 600 live/hour, 2000 history/day (`TWINS_CAPTURE_MAX_*`); (7) the fresh-chain check used a new scratch database `twins_t2a_chain_fresh` instead of dropping `twins_ci`.
**Mutation matrix** (mutant introduced -> tests that failed -> original restored byte-identical, verified with `cmp`):
| Guard | Mutant | Failing tests |
|---|---|---|
| ingest token | `bearerMatches` check replaced by `false` | internalIngest: auth-before-body, 401 matrix, rate cap counts only authenticated (3) |
| proxy-header rejection | proxy check replaced by `false` | internalIngest: proxied request with valid token -> 404 (1) |
| chat allowlist (API) | gate replaced by `false` | internalIngest: approved-chat gate (2) |
| chat allowlist (worker, message) | gate replaced by `false` | worker/intakePolicy unit (8); integration `gates` unapproved chat (1) |
| chat allowlist (worker, events) | gate replaced by `false` | captureJobs (3) |
| options-only | `if (!optionsFlow)` replaced by `false` | intakePolicy unit (2); integration options-only (1) |
| idempotency, events | `ON CONFLICT DO NOTHING` removed | unit captureEvents (1, added); integration (3) |
| idempotency, messages | `ON CONFLICT DO NOTHING` removed | unit captureProvenance (1, added); integration (2) |
| revision identity | `revisionExternalId` returns the origin id | unit (8); integration (3) |
| original preserved | identity collapsed AND conflict turned into `DO UPDATE SET raw_text` | integration (3: edit/original byte-identical, first-seen-edited, deletion fingerprint) |
| append-only trigger (TRUNCATE) | `DROP TRIGGER ..._no_truncate` on the rehearsal DB | integration append-only test (1); trigger re-created from the migration's own statement |
| append-only trigger (UPDATE/DELETE) | `DROP TRIGGER ..._no_update_delete` | integration append-only test (1); re-created likewise |
| migration text | TRUNCATE trigger line deleted from the SQL | captureMigration: hash pin, hand-written-block, ordering (3) |
After the trigger mutants, the trigger definitions were compared by md5 of `pg_get_triggerdef` (identical before and after) and `verify-migrations` passed again.
