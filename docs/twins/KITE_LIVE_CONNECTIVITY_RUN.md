# Kite Connect - read-only live connectivity run (2026-10-31)

> **Status of this record:** one successful read-only connectivity run from the owner's Mac. It is **not** a completed TWINS integration and **not** fresh-market validation. `LIVE_TRADING=false`. No orders, no GTT, no account modification, no engine activation, no VPS or R2 change. Live activity is **paused** until the owner decides otherwise. This summary is redacted: it contains no credentials, tokens, callback or WebSocket URLs, or account/profile data.

## What ran
A one-shot runner kept **outside the repository** (not committed) used the code on `feat/kite-readonly-foundation` at `c6e6cf1`: a localhost callback listener on `127.0.0.1:8765`, the documented `request_token` exchange, then one attempt each of the stages below (no retries). The market was closed (Saturday); no value below is fresh.

| Stage | Result | Notes |
| --- | --- | --- |
| Credentials file shape | PASS | Present and well-formed; values never printed |
| Authentication | PASS (per the run log) | Callback received with a matching one-time `state`; token exchange succeeded; the server accepted the session on its profile endpoint (success/failure only recorded) |
| Instruments | PASS | Real dump 8.98 MB, 110,311 rows; 5,629 in scope, 0 rejected in-scope rows. Index tokens: NIFTY 50 = 256265, NIFTY BANK = 260105, SENSEX = 265. Per underlying (NIFTY / BANKNIFTY / SENSEX): 3 futures each; 1,702 / 925 / 2,990 options |
| REST | PASS, all values stale | Full quote, LTP and day OHLC for 7 instruments (3 indices, 3 nearest futures, 1 near-the-money NIFTY call) mapped through the existing validators; none missing. Upstream timestamps about 1,545-1,614 minutes old; bid/ask absent for all 7 |
| Historical | PASS | NIFTY 50 day candles, 14-day window: 9 bars (2026-10-19 to 2026-10-30), no duplicates. One expected trading day absent, cause not verified |
| WebSocket | PASS for connection and decoding only | Connected; 7 instruments subscribed in full mode for about 20 s; 6 heartbeats; 1 data frame / 7 ticks (layouts `index_full` and `full`); 0 rejected packets; 2 server text messages ignored unread. All 7 quotes **stale** (about 1,546-1,615 minutes) |

## What this does and does not establish
- Establishes: the Connect app's REST, historical and WebSocket access work for this account; the parser reconciles with the real instruments dump for the three indices and their listed derivatives; the index-full and tradable-full tick layouts decode consistently with the REST timestamps (supports the big-endian, epoch-second and /100 assumptions for those two layouts only).
- Does **not** establish: fresh-market behaviour; the 8-byte LTP, 28-byte index-quote and 44-byte quote layouts; market depth; streaming under load or across market sessions; provider/snapshot wiring (pending); anything about orders (none exist or are authorized).
- An open socket and heartbeats prove connectivity only. Freshness is judged from exchange timestamps, and none was fresh.

## Open items kept explicit
1. **Browser/callback origin is unexplained** (investigated 2026-11-03: see [KITE_CALLBACK_ORIGIN_INVESTIGATION.md](KITE_CALLBACK_ORIGIN_INVESTIGATION.md); a remote origin is excluded by the loopback binding, an existing browser session is the most likely explanation, **closed 2026-11-04** after the owner's checks, D-089). The run log shows a valid callback with the correct `state`, but the owner did not see a login tab. An existing browser session is a possible explanation and is **not** confirmed. The owner is reviewing the account's activity; nothing here assumes the outcome.
2. **Token state is not asserted.** The runner held the access token in memory only and never wrote it anywhere, but process exit does **not** prove the token is absent everywhere (for example in a browser, a shell history or another process) and does **not** revoke it server-side. Server-side expiry is expected around 06:00 IST; no invalidation or secret rotation was performed by TWINS.
3. No repeat login, secret rotation, session invalidation or further API call is made without a new, explicit instruction.
4. The credentials file `~/.twins-kite/kite.env` (outside the repo, mode 0600) still exists on the Mac unless the owner removes it.
5. Pending, unchanged: provider/snapshot wiring (package B), a market-hours validation run, hosted CI (blocked by billing), and any order/gateway work (separate execution approval).
