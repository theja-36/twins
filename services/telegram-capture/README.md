# TWINS Telegram user-capture client (T2b-1: code and tests only; NOT deployed, NEVER run against Telegram yet)

Read-only. Standard library only (Python 3). Talks to Telegram solely through the pinned TDLib 1.8.68 (`/opt/tdlib/libtdjson.so` in the `capture-*` image) and
to the TWINS API solely through `POST /internal/ingest/telegram-user` (own bearer token, internal network only).

Run (inside the image): `python3 -E -s -B services/telegram-capture/main.py <command>`
- `run` - the service. Never prompts, never logs in. Update for an approved channel -> payload -> ingest. Edits are read with one `getMessage`.
- `login` - one-time, interactive, by the OWNER in their own terminal (phone, code, 2FA password; one attempt each). Creates the encrypted session.
- `logout` - `logOut` on Telegram's side and deletes the local TDLib database.
- `check-config` - validates the environment only (no Telegram, no network).

Environment (all required for run/login/logout; values are never printed): `TWINS_TELEGRAM_API_ID`, `TWINS_TELEGRAM_API_HASH`, `TWINS_TELEGRAM_SESSION_DB_KEY` (64 hex),
`TWINS_TELEGRAM_ALLOWED_CHAT_IDS` (1-5 numeric `-100...` ids), `TWINS_CAPTURE_INGEST_TOKEN`, `TWINS_CAPTURE_INGEST_URL` (internal host only).
Optional paths: `TWINS_TELEGRAM_SESSION_DIR` (default `/var/lib/twins-capture/tdlib-db`), `TWINS_CAPTURE_STATE_DIR` (default `/var/lib/twins-capture/state`), `TWINS_TDJSON`.

Exit codes: 0 ok / stopped by signal; 2 configuration; 75 flood-wait (`blocked_until` recorded; refuses to start until then); 76 authorization failure (owner must run `login`);
77 channel unusable (not found, not a member, protected content); 78 the ingest endpoint refuses us (401/403/404); 79 the Telegram-only egress restriction is not in force (startup self-test: a non-Telegram canary host answered). Every stop writes `alert.json` and one `capture.alert` log line.
Transient failures restart the session with backoff 1,2,4... capped at 300 s. Nothing is retried after a flood-wait and nothing logs in again automatically.

Safety properties are enforced by tests: `tests/unit/tools/telegramCapture.test.ts` (static) and `tests/*.py` (behaviour, fake TDLib transport).
Known limits: events are held in a bounded in-memory queue (500) - a restart loses undelivered events (the approved history import recovers gaps, later task);
`updateMessageEdited` is resolved with `getMessage`, so an edit that happens while the client is offline is not seen until history import.

Unattended operation (container restart policy `unless-stopped`): the service refuses to start unless `1.1.1.1:443` is unreachable (fail-closed egress self-test, run before any TDLib call);
on any fatal condition (exit codes 75-79) it alerts, closes TDLib gracefully and then HOLDS for 15 minutes (a stop signal ends the hold) before exiting, so a restarted container cannot loop
against Telegram, and it never logs in by itself. A manual `docker compose stop` is not restarted.

History pilot (`main.py history`, a one-off container with the capture volumes; the capture service must be stopped because two TDLib clients cannot share one session database):
`history --chat <id> --dry-run` reads the newest messages of ONE approved channel (at most 50 messages or 7 days, whichever is smaller, via `getChatHistory`, hard-limited to 50 per request, read-only)
and prints counts, ids and dates - never text - and the exact parameters of the import; it never contacts the ingest endpoint. `history --chat <id> --import --from-ts T --to-id N --expect-count K`
re-reads the same window, aborts before any write unless it matches what the owner confirmed, then posts `api_history` batches (batch id, nothing retried; the first error or rate limit stops it).
The server de-duplicates by message id, so re-running is safe; the worker's options-only gate still decides what is stored.
