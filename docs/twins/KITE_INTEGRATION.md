# Zerodha Kite Connect integration (Integration 2) - delivery status

> Scope fixed by the owner: **NIFTY 50, BANKNIFTY, SENSEX** (index references and their listed futures/options). Anything else fails closed. `LIVE_TRADING=false`. No order code exists or is authorized.

## Delivery split
| Part | Content | State |
| --- | --- | --- |
| **A1 (this change)** | `packages/kite`: types and errors, read-only allowlist, rate limiting, session/exchange handling, instruments CSV parser, secret redaction. Offline, fixtures only. | implemented, locally tested |
| **A2 (implemented, locally tested)** | REST full quote / LTP / day-OHLC and historical-candle clients, plus pure mapping into `InstrumentQuote`, `LastPrice` and `OhlcSeries` (existing validators). No provider or snapshot wiring. | implemented, locally tested |
| **A3 (implemented, locally tested)** | WebSocket ticker: strict binary decoder, injectable transport, bounded reconnect, explicit freshness state. No provider or snapshot wiring. | implemented, locally tested; never run against a live feed |
| **B** | Provider and snapshot wiring (`QuoteProvider`, `OhlcProvider`, `InstrumentReference`, snapshot export), failure handling | pending |
| **C** | Gateway / order functionality | separate execution approval; nothing in A or B may call an order endpoint |

## Configuration (variable NAMES; values live in an env file outside the repo, never printed)
`TWINS_KITE_API_KEY`, `TWINS_KITE_API_SECRET` (needed only for the token exchange), `TWINS_KITE_ACCESS_TOKEN` (optional). Entitlement of the account (Connect plan, realtime and historical data) is **unverified**.

## Session design
A human completes the official browser login (`loginUrl(apiKey)`); the package never handles the password or TOTP. The `request_token` from the redirect is exchanged with the documented checksum (`SHA-256(api_key + request_token + api_secret)`) via `POST /session/token`, the single authentication exception to the read-only rule. A token is **unverified** until the server accepts a call (`verifySession()` -> `GET /user/profile`); `advisoryExpiry()` (about 06:00 IST) is a hint for operators and never decides validity. A `403` / `TokenException` invalidates the session, drops the token and stops all calls until a new exchange. Token persistence between runs is not part of this change.

## Data rules (A2)
- `asOf` is always the **upstream** timestamp (quote `timestamp`, read as IST). The local fetch time is carried separately (`fetchedAt`) with `ageMs`; a quote without a valid upstream timestamp is not mapped, and fetching now never makes data fresh.
- Requested instruments absent from a response are reported as `missing`; unexpected keys are reported; each entry's `instrument_token` must match the catalog.
- Not invented: empty depth levels (price 0) are `null`; absent `oi` is `null`; `avgVolume` is always `null` (Kite's quote has none); an index never carries volume, OI or depth.
- `/quote/ltp` and `/quote/ohlc` have no timestamp, so they return typed **limited** results and cannot become `LastPrice` / `OhlcSeries`. A `LastPrice` comes from a full quote only.
- Candles: strict, oldest-first, exchange offset kept; any malformed bar fails the whole series; identical duplicates are removed and counted, conflicting ones fail; the last bar is flagged `lastBarMayBeOpen`. Only currently listed contracts; no expired-option history, no continuous data. Per-request span limits follow the documented maxima.
- Retries: reads only, at most `maxRetries` (default 2, cap 5), for network/timeout/5xx/429 with doubling back-off (Retry-After honoured, capped at 5 s). Never for authentication failures, bad requests, refusals or the token exchange.
- A loopback test transport accepts only `test*` credentials.

## WebSocket ticker (A3)
- **Transport** is injected (`WsFactory`); `builtinWebSocketFactory()` wraps the runtime's built-in WebSocket (Node 22+; no dependency added). The authenticated URL (it contains the key and token) exists only inside the factory call and is never logged. Log events carry fixed fields only.
- **Decoder** (`decodeFrame`): big-endian; frame = int16 count + (int16 length + packet)*; 1 byte = heartbeat. Layouts: 8 LTP; index 28 (quote) / 32 (+exchange timestamp); tradable 44 (quote) / 184 (full: last-trade time, OI, exchange time, 10-level depth). Accepted only for subscribed catalog tokens and only when the length is valid for that instrument's kind. A broken frame (truncated, wrong count, trailing bytes) is dropped whole; a bad packet inside a sound frame is dropped alone. Byte order, epoch-second timestamps and the 100 price divisor come from the published protocol description and client libraries, **not from a live feed**.
- **Times are kept apart**: `receivedAt` (local), `exchangeTimestamp` (upstream quote time) and `lastTradeTime`. A packet without an exchange timestamp is a LIMITED reading: it never creates or refreshes a validated quote. Heartbeats prove connection activity only. Freshness = connected AND exchange time young enough; reconnecting or receiving other packets never refreshes a cached quote; an instrument never moves backwards in exchange time.
- **Lifecycle**: one socket and at most one reconnect timer and one watchdog; doubling back-off, capped, bounded attempts (then `failed`); a server token error, an invalid session or a rejected `checkSession` ends in `auth_failed` with no further attempts; subscriptions and modes are re-sent after every reconnect; `stop()` is restartable, `dispose()` is final. Order postbacks are counted and ignored (never stored or logged). Storage is bounded by the subscription cap (default 200, max 3000).

## Guards
Only the allowlisted GET paths and `POST /session/token` can be sent (checked before the rate limiter or `fetch`); a source-scan test fails on any order/GTT/portfolio/margin path or extra write method. Errors carry fixed messages; server text is redacted and bounded. Instruments naming is verified against synthetic fixtures only and must be reconciled with a first live dump before wiring (B).

Tests: `tests/unit/kite/` (no network; fake `fetch`).
