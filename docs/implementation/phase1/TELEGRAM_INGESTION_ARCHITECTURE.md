# TWINS Telegram ingestion architecture - v2 (DESIGN ONLY; nothing implemented, connected, registered or created)

Status 2026-10-22, revised with the owner's final decisions. No Telegram API call has been made. No bot, webhook, session, `api_id` or channel access exists. The source channel id and the approver's user id are NOT written in this repository: they appear as `<SOURCE_CHANNEL_ID>` and `<APPROVER_USER_ID>` and live only in server-side configuration and, for the channel id, in the existing `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` gate.
Evidence labels: [R] read in this repository; [K] from my general knowledge of Telegram - verify against current official documentation (my knowledge can be out of date); [D] design decision.
Companion plans (also design only): `T1_LOCAL_FEASIBILITY_PLAN.md`, `T2a_SCHEMA_AND_INGEST_PLAN.md`.
Update 2026-10-22: **T1 basic feasibility passed** (owner-run; see `T1_EVIDENCE_REPORT.md`): pinned TDLib accepted, channel accessible, membership=member via `supergroup.status`, `protected_content=false` at the time, latest-message metadata readable. **Event observation (new/edit/delete) remains UNVERIFIED; live capture and history import are NOT done.** T1-D cleanup result is not yet recorded. Next-step scope: `T2a1_SCOPE_AND_DIFF_PLAN.md`.

## 0. Decision record (owner, 2026-10-22)
1. The **existing personal Telegram account** is used for the User API capture session (no dedicated account).
2. **Telegram Desktop export is not used.**
3. **Historical messages are imported through the User API / MTProto history API**, in bounded batches, with full flood-wait compliance.
4. Raw historical messages are **retained for research** (private, never redistributed).
5. **Deletions are recorded as events**; stored original messages are never deleted or overwritten.
6. Source channel: `<SOURCE_CHANNEL_ID>`. Approver: `<APPROVER_USER_ID>` (single human approver).
7. **Source capture and the approval bot are completely separate** systems.

Consequences accepted by these decisions, stated plainly: a stolen session of the primary personal account exposes every chat of that account and lets an attacker act as the owner [K]; bulk history through the API carries a higher chance of Telegram flood-waits and, in the worst case, account restrictions than live reading [K]. The design below therefore compensates with stronger controls (section 6), a deliberately slow history import (section 5) and hard prerequisites before any deployment (section 8, T2b).

## 1. Why the Bot API alone cannot capture this channel [K]
A bot receives channel posts only if it is an administrator of the channel; the owner is a subscriber and cannot add one; a bot cannot join channels or read history by itself. Manual forwarding to a bot is per message, loses edit/delete events and is the forwarding pattern the owner wants to avoid. Only a member client session (User API / MTProto) can read what the owner can already read. The existing Bot API intake (`POST /webhooks/telegram`, `normalizeRawUpdate` [R]) stays **permanently unrouted**; it is not the source path.

## 2. Architecture
```
Telegram DCs (MTProto/TLS)
      | read-only member session (live updates + bounded history batches)
      v
 +--------------------+   internal network only, own bearer token   +------------------------+
 |  capture service   | ------------------------------------------> |  TWINS API             |
 |  (own container;   |   POST /internal/ingest/telegram-user       |  - token + schema      |
 |   holds the        |                                             |  - allowlist gate      |
 |   session)         |                                             |  - enqueue only        |
 +--------------------+                                             +-----------+------------+
  no DB/Redis creds, no bot token                                               v
  egress: Telegram + API only                              worker: approved-chat gate + options-only gate
                                                           -> immutable raw store (telegram_messages)
                                                           -> append-only telegram_message_events
                                                           -> parser v2 -> UNVERIFIED options claim
                                                           -> research / outcome pipeline (later)

 SEPARATE SYSTEM (later): approval bot = its own service, own bot token, own webhook route and secret;
 reads derived data only; shares nothing with capture except the database it reads.
```
1. **The capture service holds only the session.** If it is compromised the attacker gets the Telegram session but no TWINS data; if the API or worker is compromised they do not get the session.
2. **The verified pipeline is reused:** `NormalizedTelegramMessage`, revision key `<id>_edit_<edit_date>_<sha256-12>`, deterministic job id `tg-<channel>-<externalMessageId>`, the approved-chat gate and options-only gate in API and worker [R].
3. **The capture service never writes to the database or the queue directly.** The API validates and enqueues; the worker writes. The raw store and events table are written only by the worker.
4. **Library: TDLib (official) built from a pinned tag in an isolated container.** Reason: it provides a built-in encrypted local database (`database_encryption_key`), which matters for a primary personal account; Telethon's default session is an unencrypted SQLite file and would need an extra encryption layer. The service exposes **no send/forward/join/leave/delete capability** and a static test fails the build if such calls appear.
5. **Source ids are configuration:** `TWINS_TELEGRAM_ALLOWED_CHAT_IDS=<SOURCE_CHANNEL_ID>` (API and worker, existing) and the capture service's own single-chat filter.

## 3. Components and stores
| Component | Holds | Network |
|---|---|---|
| `capture` (new) | session volume (TDLib encrypted DB), `api_id`/`api_hash`, ingest token, DB-encryption key - all as root-only secret files | egress only to Telegram ranges; internal to the API |
| `api` (existing + internal route) | `TWINS_CAPTURE_INGEST_TOKEN` | route never exposed through Traefik |
| `worker` (existing) | none new | no internet |
| PostgreSQL | raw store, events, provenance | internal |
| `notifier` (later) | bot token | egress to `api.telegram.org` only |

Database additions (T2a; details in its plan): provenance columns on `telegram_messages` (`capture_method` in `bot_webhook|api_live|api_history`, `observed_at`, `imported_at`, `first_seen_edited`) and an **append-only** `telegram_message_events` table (`seen`, `edited_observed`, `deleted_observed`). An import checkpoint/batch table arrives with the history-import task. Media: metadata only; no files are downloaded.

## 4. Message semantics
- **New message:** immutable raw row, idempotent on `(source, message_id)`.
- **Edit:** a new revision row (`<id>_edit_<edit_date>_<hash12>`) plus an `edited_observed` event. The original text stays byte-identical. Telegram gives no edit history [K]: only edits observed while connected are recorded.
- **First seen already edited** (typical for history import): stored under the **revision identity**, never under the plain message id (so no row claims to be the original text), with `first_seen_edited=true`. Timing-sensitive research excludes such rows.
- **Delete:** a `deleted_observed` event with `observed_at`; nothing is deleted or altered. Detection is best-effort: live delete updates while connected plus a bounded reconciliation sweep of recent ids, which records the observation time, not the true deletion time [K]. Deleted messages cannot be imported later (they are gone from history).
- **Provenance:** `capture_method` = `api_live` or `api_history`; `observed_at` = when TWINS saw this content (server clock); `imported_at` = set only for `api_history`. History rows have no meaningful receive latency, so signal-timing studies use `api_live` rows or the message's own date with that caveat.
- **Protected content:** if the channel has "restrict saving content" [K] the service records the flag and pauses by default until the owner decides.
- **No redistribution:** no send/forward functions; stored text is reachable only via the private API and the local viewer; later cards carry derived fields, not verbatim channel text.

## 5. API-based historical import (design)
Goal: import the channel's history for research without Telegram Desktop export, as gently as possible on a primary account.
- **Direction and checkpoint:** newest to oldest. Checkpoint = lowest message id and its date imported so far (plus run id and counters), persisted after every committed batch. Resume starts at `checkpoint - 1`.
- **Bounded batches:** page size 50 messages (TDLib maximum per call is 100 [K]); per-run cap (pilot 100, normal 500); per-day cap 2,000; configurable lower. One run at a time (lock). Optional date horizon: stop at a date you choose.
- **Pacing:** randomised 4-8 s between history calls; no parallel requests; runs only in a window you approve; the live stream has priority and history pauses while a live burst is processed.
- **Flood-wait handling (no automatic retry):** any flood-wait/"retry after N" or 429-class error **stops the run immediately**; the service records `blocked_until = now + N + 10 min margin`, writes the checkpoint, raises an alert and exits. It **does not retry and does not resume by itself**. A new run starts only on an explicit operator command and refuses to start before `blocked_until`. A second flood-wait within 24 h doubles the cool-down and requires explicit approval to continue. TDLib may also delay requests internally [K]; the service treats any signal of throttling as a stop.
- **Idempotent import:** every message goes through the same ingest endpoint; duplicates (including messages already captured live) collapse by the unique `(source, message_id)` / revision key and deterministic job id; re-running a range creates no new rows. If an already stored message now shows a newer `edit_date`/hash, it becomes a revision (`edited_observed`), never an overwrite.
- **Provenance:** every row carries `capture_method=api_history`, `imported_at`, `observed_at`, the run/batch id in event metadata, and `first_seen_edited` where applicable.
- **Alerts:** flood-wait, blocked-until active, requests/min above the configured ceiling, import stalled, checkpoint not advancing, rejects from the ingest endpoint, unexpected volume.
- **Start conditions:** only after live capture of one message is proven (T3); a pilot of 100 messages first, reviewed by the owner, before any larger run.

## 6. Security controls - primary personal account (D)
1. **Encrypted session storage:** TDLib database encrypted with a random 32-byte key kept in a root-only secret file (`0400`) outside the repo, compose files and logs; session volume owned by the non-root container user; `api_id`/`api_hash`/ingest token also secret files.
2. **Session excluded from all backups and off-host copies.** It never leaves the host; recovery = log in again. A restore test must prove the session is absent from backups.
3. **No session transfer between devices without explicit approval.** Login happens once, by the owner, on the machine that will keep the session (the VPS); copying a session directory elsewhere is forbidden without an approval that includes revoking the old session. Moving sessions between IPs can also trigger Telegram revocation [K].
4. **Owner-only login, never through the assistant.** The owner types the phone code and any 2FA password into the tool's own prompt in the owner's own terminal. No password, OTP or 2FA code enters the repository, environment variables, compose files, shell history, chat or logs. 2FA on the account is a prerequisite.
5. **Account-wide watch (read-only):** hourly `getActiveSessions` comparison against the known set; alert on any new or unexpected session, device or country. This detects a stolen account or a stolen copy of the capture session.
6. **Least privilege:** non-root, read-only rootfs, `cap_drop ALL`, `no-new-privileges`, no Docker socket, no DB/Redis/bot credentials, egress limited to Telegram's published ranges [K, verify] and the internal API (a firewall change, separately approved), code-level read-only API surface.
7. **Kill switch and revocation (rehearsed before go-live):** (1) flag `capture_enabled=false` (soft pause); (2) `docker compose stop capture`; (3) **terminate the capture session in the Telegram app: Settings > Devices** (immediate and authoritative); (4) delete the session volume and secret files; (5) rotate the ingest token; (6) if the account itself is suspected stolen: change the 2FA password and terminate all other sessions, then re-evaluate.
8. **Alerts (existing Uptime Kuma push monitors):** authorization failure/session revoked; flood-wait and blocked-until; disconnect > 5 min; **unexpected message-volume spikes** (initial thresholds: more than 20 messages in 10 minutes or more than 100 in a day on the live channel, tuned after two weeks of real rates; the ingest endpoint also enforces an hourly cap and rejects beyond it); unknown Telegram session; ingest rejects; heartbeat missing. A quiet channel is not an error.
9. **Reconnect:** exponential backoff with jitter (1 s to 5 min); authorization errors stop the service and require a human login - never an automatic re-login.
10. **Logging:** ids, counts and states only; never message text, phone numbers, codes, tokens, session data or `api_hash`; redaction tests.
11. **Hard prerequisites before the session exists on the VPS (T2b):** Phase 0B items SSH hardening (no passwords) and the Ollama bind change completed, Phase 0C monitors and the kill-switch runbook in place. The VPS is shared and root SSH with password authentication is currently enabled [verified earlier]; a primary-account session must not be placed there until that is fixed.

## 7. Terms and ethics considerations (not legal advice) [K - verify current texts]
Telegram's API terms require your own `api_id`/`api_hash` and, to my understanding, prohibit spam, abuse, evading limits and harming user privacy; automation of a personal account can lead to limits or a ban if it looks abusive, which is why live reading is read-only and history import is slow and capped. The channel owner holds rights in the content; a subscription may carry its own terms (no copying, no sharing, automated access) - read them. TWINS stores the data privately for research only: no forwarding, reposting, publishing or sharing; restrict access to the owner; define retention. If "restrict saving content" is on, do not bypass it. Whether Indian rules apply to collecting or acting on third-party tips is unverified.

## 8. Task plan and approval boundaries (E)
| # | Task | Scope | Not included | Done when |
|---|---|---|---|---|
| T0 | Decisions | recorded above | - | done |
| **T1** | Local read-only feasibility | tool + static test; you log in yourself; metadata only; throwaway session; cleanup | no VPS, no storage of text, no history | metadata report accepted, session logged out, local files deleted (see `T1_LOCAL_FEASIBILITY_PLAN.md`) |
| **T2a** | Schema + internal ingest endpoint | migration, append-only events, endpoint, tests | no Telegram, no VPS, no staging migration | tests green on guarded local databases (see `T2a_SCHEMA_AND_INGEST_PLAN.md`) |
| T2b | Secure deployment | prerequisites in 6.11, staging migration (after a backup), image build, secrets, capture container, firewall egress rule, monitors; owner logs in on the VPS | no ingestion of real content yet | heartbeat green, nothing ingested |
| T3 | Live capture of ONE message | enable the single allowed channel; prove edit/delete on a private test channel first | no history | one real message correct end to end |
| T3h | History import pilot then bounded runs | pilot 100 messages, review, then capped runs | no unattended runs | checkpoint/resume and flood-stop proven |
| T4 | Parser accuracy baseline | labelled sample | no outcome engine | report accepted |
| T5 | Approval bot (separate system) | bot, notifier, `/webhooks/telegram-approval`, owner-only, replay protection | no order path | owner-only approval verified |
Every row is a separate approval; T1 and T2a are specified in full in their own documents and are not started.

## 9. Approval bot (separate; unchanged by this revision)
Own bot via BotFather (token only on the notifier); own route `POST /webhooks/telegram-approval` with its own secret token (checked before the body is read), HTTPS, `allowed_updates=["callback_query"]`, small `max_connections`, optional IP allow-list, rate limit, 64 KB body cap, schema validation; accepts only `callback_query` with `from.id == <APPROVER_USER_ID>` in the private chat with the stored card message id; replay protection (monotonic `update_id`, single-use card state machine with expiry, HMAC-signed `callback_data`); logs without text or secrets; an approval records intent and an evidence snapshot and places no order. It must NOT be in the capture path, never receives channel content, never touches the session or the ingestion queue.

## 10. Risks and open questions
Risks: session theft (primary account); history import and account restrictions; edit/delete observation limits; channel terms; TDLib build/supply chain; shared VPS hardening pending; first-seen-edited rows bias timing research; downtime loses timing precision.
Open questions: how far back should history go (date horizon)? Typical live message rate of the channel (to tune spike alerts)? Is 2FA on? Is "restrict saving content" enabled? Retention period? Comfortable with Homebrew's `tdlib` for T1 (official source, packaged bottle)? Phone-code login or QR login for T1?
