# T3h - History pilot for the signal channel (read-only, bounded) - executed 2026-10-24 on staging

`<REAL_CHANNEL_ID>` and `<TEST_CHANNEL_ID>` are placeholders: the real ids live only in the host's `staging.env`. This record contains counts and times, never message content or message ids of the real channel.

## 1. What it is
A command of the capture client (`main.py history`, run as a one-off container with the capture volumes while the capture service is STOPPED, because two TDLib clients cannot share one session database). It reads the newest messages of ONE approved channel and, after an explicit confirmation, imports them as `api_history` rows through the same internal ingest endpoint, worker gates and immutable store as live capture.
- **Request allowlist:** `getChatHistory` is the 14th request type. The request layer (`tdlib.req`) enforces the hard limits for every caller: `limit` 1-50, `offset` 0, `from_message_id` >= 0, `only_local` false, an approved chat that must be named explicitly (an omitted `chat_id` is refused for every chat-scoped request - a gap found and closed by its test). `getChatHistory` is requested from exactly one place (`history.py`).
- **Window:** newest first, at most 50 messages and at most 7 days, whichever is smaller; at most 6 pages (a runaway guard); the caller cannot widen either bound.
- **Dry-run** (`--dry-run`): reads from Telegram only and NEVER contacts the ingest endpoint. It prints counts, ids and dates (no text) and the exact import parameters (`--from-ts`, `--to-id`, `--expect-count`).
- **Import** (`--import --from-ts T --to-id N --expect-count K`): re-reads the identical window and aborts BEFORE any write unless the number of importable messages equals the confirmed count (`to_id` keeps messages that arrived after the dry-run out). It posts `api_history` batches (<= 50 messages; one batch id; `importBatch.lowestMessageId/Date`), stops on the first non-2xx/transport error/rate limit and retries nothing. Flood-wait: stop, record `blocked_until`, alert. Re-running is safe (the server de-duplicates).
- Safety shared with live capture: fail-closed egress self-test, `blocked_until`, no login, membership and protected-content checks, graceful TDLib close, content-free output.

## 2. Execution (staging)
| Step | Result |
|---|---|
| Rehearsal on the private test channel: dry-run | 13 messages in the channel, 12 with text |
| Rehearsal import (the prediction was made before running it) | API: 1 accepted, 11 duplicates, 0 errors; the one accepted message (never captured before, not an options message) was declined by the worker's options-only gate; database before/after IDENTICAL (12 rows, 13 events, 12 claims, every row fingerprint equal): 0 new rows |
| `<REAL_CHANNEL_ID>` dry-run | window = 50 messages (the cap is smaller than 7 days), 49 with text, 1 without text, 0 edited; 2 pages, 6 s; no flood-wait; 0 ingest requests, 0 rows written |
| `<REAL_CHANNEL_ID>` import (after the owner confirmed 49) | API: 49 accepted, 0 duplicates, 0 ignored, one batch; worker: 32 stored as options claims (never approvable), 17 declined by options-only; 0 errors |
| Stored rows | 32 `api_history` rows, `imported_at` and `observed_at` set, `first_seen_edited=false`, no revisions, 32 `seen` events with matching hashes and the same import batch id, 0 signals; message times about 2026-10-21 to 2026-10-23; raw/event tables: 0 updates, 0 deletes; 0 text matches in the capture/api/worker logs |
| Backup before any write | `twins-staging-pre-historyimport-20261024T142734Z.dump`, sha256 `ae8839f2a6ef4765c8186cb55236d096a7e1ecc08a1a804cc0239650a3eae0df`, verified |

## 3. Gap analysis
- Against live capture: vacuous for the real channel (it had no live-captured rows); the de-duplication against live rows was demonstrated on the test channel (above).
- Inside the window: the 18 messages not stored = 17 declined by options-only + 1 without text (declined messages are not recorded, so they cannot be told apart individually).
- 16 message ids inside the span of the window do not exist in the channel any more (deleted at the source, including a run of ten consecutive ids). History cannot recover deleted messages; only live capture sees a deletion as an event.

## 4. Limits and risks
- The 32 stored real-channel messages are permanent by design (immutable raw store). Only options-style messages are stored (options-only mode): equity-style posts are not.
- The window is 50 messages: older history was not imported. The database-level duplicate path (as opposed to the queue-level one) was covered by the integration test, not by this run.
- A history import must not run while the capture service runs.
