# T5 - Approval bot (Telegram Bot API) - DESIGN FOR OWNER REVIEW (nothing built, nothing created, no bot, no token, no migration)

`<APPROVER_USER_ID>`, `<BOT_TOKEN>` and `<SOURCE_CHANNEL_ID>` are placeholders: the real values live only in a host-side env file (section 2), never in the repository, docs, examples or logs.

## 0. What it is and is not
A small, SEPARATE service that shows each newly parsed options claim to ONE human approver in a private Telegram chat and records the approver's **Approve** or **Reject** decision with a timestamp and an evidence snapshot. A recorded "approve" is **intent only**: it changes no claim, enables no order, and `options_claims.approval_possible` stays false (database CHECK). No broker integration, no order path, no trading library, `LIVE_TRADING` is neither read nor changed. It is not part of capture: it never touches the Telegram user session, the capture queue or the ingest endpoint, and it never receives channel text.

## 1. Architecture (decisions marked D1-D8 need your answer, section 8)
- **Service:** `services/approval-bot`, TypeScript in the monorepo, run from the SAME application image as api/worker with a different command (one build path), as its own compose service `approval-bot` (profile `bot`, off by default, `restart: unless-stopped`, non-root, read-only root filesystem, all capabilities dropped, no published ports, memory/cpu limits).
- **Transport (D1): long polling** (`getUpdates`, 50 s timeout), not a webhook. Outbound HTTPS only to `api.telegram.org`; **no inbound surface, no public route, no Traefik change, no webhook secret** (this replaces the webhook plan in the ingestion architecture section 9, which needed a public route). Calls used: `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getMe` (startup self-check). Nothing else.
- **Network:** its own egress network (`twins_bot_egress`, a new /24) plus `twins_data` (to reach Postgres only). Host firewall in the same style as the capture network: DROP everything except tcp/443 to Telegram's published ranges (api.telegram.org sits inside 149.154.160.0/20), the same ufw host-path block, and a fail-closed startup self-test (a non-Telegram canary must be unreachable). Firewall and network changes are separate approvals.
- **Database access (D2): a dedicated least-privilege Postgres role `twins_bot`** (password only in the bot env file). Column-level grants, so the bot **cannot read channel text at all**: `SELECT` on `options_claims`; `SELECT (id, external_message_id, message_timestamp, telegram_source_id, capture_method)` on `telegram_messages` (NOT `raw_text`, NOT `raw_payload`); `SELECT (id, channel_identifier)` on `telegram_sources`; `INSERT` on the audit tables; `SELECT/INSERT/UPDATE` only on its own card-state table. Nothing else (no `signals`, accounts, broker or execution tables); `CREATE` on schema public revoked. At every start the bot verifies its own privileges (`has_table_privilege` / `has_column_privilege`) and **refuses to run** if it can write `options_claims` or read `raw_text`.

## 2. Secrets
- A separate host env file (e.g. `/opt/twins-staging/infrastructure/staging/bot.env`, root-owned, mode 0600) used as `env_file` ONLY by the `approval-bot` service, so no other container ever receives them: `TWINS_BOT_TOKEN`, `TWINS_BOT_APPROVER_ID`, `TWINS_BOT_DATABASE_URL` (the `twins_bot` role), `TWINS_BOT_HMAC_KEY` (random, generated on the host, signs button data), plus non-secret settings. Repo gets only `bot.env.example` with empty values.
- Entered the same way as the capture credentials: by you, in your own SSH session, silent prompts, built-in `printf`, only lengths printed back. I never see the token.
- The token appears in every Bot API URL, so the HTTP wrapper redacts it from errors and logs by construction (tested), and logs never contain message text. Config validation refuses a malformed token, a non-numeric approver id, or a database URL that is not the `twins_bot` role.
- Rotation: revoke/regenerate in BotFather, replace one env line, recreate one container.

## 3. What the approver sees (D3: derived fields only, no channel text)
Plain text (no Markdown/HTML parse mode, so nothing can be injected), built only from parsed fields and our own assessor strings:
```
TWINS claim 7F3A  |  UNVERIFIED  |  records your decision only - places NO order
Source: <channel label> - message 28956 - posted Fri 23 Oct 12:57Z (2 d 3 h ago)
BUY (presumed long entry) NIFTY 24500 CE, expiry 27 Oct 2026
Entry: above 120 | Stop: 90 | Targets: 150, 170 | Levels refer to: premium
Assessment: INSUFFICIENT_EVIDENCE
 - option_premium_data.unavailable (WARN): no premium data source configured
 - ... (up to 5 reason codes with their fixed descriptions)
Parser: telegram-regex-v2 | card expires in 4 h
[Approve (record only)]  [Reject]
```
Underlying, strike, type, expiry, levels, intent and reason codes come from the stored `claim`/`reasons` JSON (`options_claims`); the raw message text is never loaded or sent (D3 default; an opt-in excerpt flag is possible later but not proposed). Card length is capped (4096 limit) and deterministic, and its sha256 goes into the audit evidence.
Only claims with `result_kind = 'claim'` get a card; ambiguous/unsupported results do not (D5). Source filter (D4): only the real signal channel by default, not the test channel.

## 4. Flow, state machine and audit
1. **Select** (poll every 30 s): new claims, `result_kind='claim'`, source in the configured list, `created_at` later than the bot's activation time (so the 32 historical pilot rows do NOT flood the chat; an explicit one-off backfill command can send them in small batches, D6), no card yet, oldest first, at most 5 per cycle, rate caps 20/hour and 100/day (a burst becomes a backlog, not a flood).
2. **Send:** insert the card row (`pending`) in a transaction, `sendMessage` to the approver's private chat with two inline buttons whose `callback_data` is `v1.<cardId>.<a|r>.<hmac>` (HMAC-SHA256 over card id, action and card nonce with `TWINS_BOT_HMAC_KEY`, truncated, well under 64 bytes), then mark `sent` with the Telegram message id.
3. **Receive:** only `callback_query` (and `/start`, `/status`, `/pause`, `/resume` text from the approver). Accepted ONLY when `from.id == APPROVER_ID` AND the chat is the approver's private chat AND the card message id matches AND the HMAC verifies (constant-time). Everything else is ignored and counted in the audit log (reason code only). `update_id` offsets are persisted (replay protection).
4. **Decide (single use):** one transaction: `UPDATE card SET state='decided' WHERE state='sent' AND expires_at > now()` must affect exactly one row, then `INSERT` the decision. A double tap, a replayed update or a late tap finds no `sent` card and records nothing. The message is edited to show the outcome ("Approved (recorded) 12:58:03Z" / "Rejected") and the buttons are removed; `answerCallbackQuery` closes the spinner.
5. **Expiry:** after the card TTL (D7, default 4 h) the card becomes `expired` (message edited, no decision). Nothing is ever auto-approved.
6. **What "approve" does:** writes the decision row only. Claims remain never-approvable (`approval_possible` CHECK untouched, the bot has no write access to the claims table); any future use of decisions needs the separate execution/broker design and approval.

**Audit (append-only, in the same Postgres, so it is in the daily encrypted backup):**
- `claim_reviews`: one row per decision: card id, claim id (FK, restrict), `approve|reject`, `decided_at`, verified approver user id, card Telegram message id, the Telegram `update_id`, an evidence snapshot (claim id, parser version, sha256 of the claim JSON and of the card text, reason codes). UNIQUE per card; a trigger rejects UPDATE/DELETE/TRUNCATE (same pattern as `telegram_message_events`).
- `approval_bot_events`: lifecycle and security events, content-free: `card_sent`, `card_expired`, `decision`, `callback_rejected:{not_approver|wrong_chat|bad_hmac|stale|replay|unknown_card}`, `paused`/`resumed`, `started`/`stopped`, `telegram_error`. Same append-only trigger.
- `claim_review_cards`: the mutable state machine (`pending|sent|decided|expired`, nonce, expiry, message id); the only table the bot updates. `approval_bot_state`: persisted `update_id` offset, activation time, pause flag.
All four are created by ONE new migration (0008), applied locally first, then on staging, each under its own approval; the role itself is created with a one-off SQL whose password you type.

## 5. Failure behaviour and kill switch
Startup self-checks (any failure = alert + 15-minute hold + exit, like capture): token valid (`getMe` returns the expected bot), approver id numeric, database role privileges as designed, egress canary unreachable. Telegram 429: honour `retry_after`, stop sending until then. Repeated errors back off (capped); bad token (401) stops. `/pause` (approver only) or `docker compose stop approval-bot` stops all sending; decisions already recorded are untouched.

## 6. Tests (all with fakes: no Telegram, no broker, no staging)
Card formatter (no raw text, fixed fields, escaping, length cap, determinism, hash); HMAC (valid, tampered, other card, other action, truncated); approver gate (wrong user, wrong chat, group chat, bot sender, missing `from`); state machine (double tap, replay of the same `update_id`, expiry race, two concurrent decisions); flood handling; token redaction in errors and logs; config validation; privilege self-check with fake privileges; selection query (activation time, source filter, rate caps, no duplicate cards); a **loopback fake Bot API server** driving the whole loop; static guards: the only write targets are the four new tables, no mention of `options_claims` in any INSERT/UPDATE/DELETE, no broker/execution/market-data imports, no `LIVE_TRADING`, no `raw_text` in any SQL; a guarded integration test (run only on the rehearsal DB, rolled-back transactions) proving the real role cannot UPDATE `options_claims` or read `raw_text` and that the append-only triggers fire. Mutation checks on the approver gate, HMAC check, single-use update and the privilege self-check.

## 7. Build and rollout phases (each its own approval)
1. This design (you). 2. Build + tests, local only. 3. Migration 0008 + role grants rehearsed on the local rehearsal databases. 4. Staging migration + `twins_bot` role (you type its password). 5. You create the bot in BotFather and enter token/approver id/HMAC key in `bot.env`; egress network + firewall chain for the bot; image build; deploy the service OFF. 6. Private-chat handshake: the bot sends "online" to the approver only; you press a test card on a synthetic claim (a clearly labelled TEST card that creates no claim). 7. Activation on new real claims (Monday observation can run in parallel; capture is untouched). Commit/push after each build stage on your word.

## 8. Decisions I need from you
- **D1** long polling (recommended) vs the earlier webhook design.
- **D2** direct database access with a column-restricted role (recommended) vs a new internal API for the bot.
- **D3** cards show parsed fields only, no channel text (recommended); alternatives: a short excerpt, or the full text.
- **D4** which channel(s): real signal channel only (recommended).
- **D5** `result_kind='claim'` only (recommended); also send ambiguous/unsupported as informational cards without buttons?
- **D6** start with NEW claims only (recommended); optionally backfill the 32 pilot claims in small batches.
- **D7** card expiry (default 4 h; options moves fast, shorter may suit you) and approve/reject wording.
- **D8** also use this bot for OPERATIONAL alerts to you (capture stopped, backup failed)? It would fix the missing phone alert path found on 2026-10-24, but it makes the bot read the host alert log or a status table: proposed as a later, separate approval, not in v1.

## 9. NOT built, by design
Broker connection, order construction, any trading, execution or position logic, any use of decisions to change claims, signals or risk state, market data, a dashboard, multi-approver support, webhooks.
