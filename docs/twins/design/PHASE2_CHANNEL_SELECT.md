# Phase 2: Telegram channel select and signal feed

**Design plus a built read-only UI. No backend change, no migration, nothing deployed by this document.** Mockup (invented data): `design/mockups.html` in twins-frontend (also published privately as an artifact). Built: the Channels page in twins-frontend PR #6.

## What exists
* Capture runs and stores messages per source (`telegram_sources`, `telegram_messages`). Which chats are accepted is a host setting (`TWINS_TELEGRAM_ALLOWED_CHAT_IDS`, enforced again in the worker).
* The API's `intake/status` returns recent messages with a MASKED channel and their processing status.
* The frontend already has Telegram Intake (job status) and Signals (decisions).

## What was built now (no backend dependency)
A **Channels** page from `intake/status` only: channel list (masked id, message count in the last 100, last received) with checkboxes, and the recent-message feed filtered by the choice. The choice is a per-browser view filter. It cannot change what is captured. With no messages there are no channels (no sample data in the app).

## What is not possible yet (gaps)
1. No endpoint lists channels: the page only sees channels that appear in the last 100 messages, and shows no signal counts, no allowed/not-allowed state and no per-channel setting.
2. The feed shows processing status, not signal content (claim, levels, stop, why it cannot be sized). That needs the claims view below.
3. Changing the ingestion allow-list is a host edit and a restart.

## Backend wiring (after Monday; each item its own approval)
1. **`GET /telegram/channels` (read-only, new route + OpenAPI + proxy allow-list):** per source: masked id, display name, messages, claims, result reports (from the parser's classification), last message time, whether it is in the ingestion allow-list, and whether a per-source default stop basis is configured. No message text.
2. **`GET /telegram/claims?channel=&limit=` (read-only):** parsed fields only (underlying, strike, type, action, entry, stop, basis and whether it was inferred, targets, expiry status, blockers). The feed rows in the mockup come from this. Never the raw text.
3. **Allow-list changes are never made from the browser.** A host script prints the proposed list and the diff and applies it only with an explicit confirmation, then restarts capture. The page may show the line to run, never run it. Reason: the frontend proxy is GET-only on purpose, and the API token it holds is not a per-person login.
4. **Two tiers per channel (design option, needs a decision and a migration if stored):** CAPTURE (store messages) and DECIDE (create risk decisions). A new channel starts at CAPTURE only and is promoted by the owner after a quality look (share of parseable signals, stop completeness, result-report share). Today a channel is all-or-nothing.

## Rules the UI keeps
Read-only; masked identifiers; no message text; nothing that looks like an order or approval; unavailable data is shown as unavailable, never as zero.

## Open questions
* Should unselected channels also be hidden on the Signals and Overview pages, or only on Channels?
* Is a persisted server-side watch list wanted (a migration), or is a per-browser filter enough?
* Who may promote a channel from CAPTURE to DECIDE, and on what evidence?
