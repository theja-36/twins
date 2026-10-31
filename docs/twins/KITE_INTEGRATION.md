# Zerodha Kite Connect integration (Integration 2) - delivery status

> Scope fixed by the owner: **NIFTY 50, BANKNIFTY, SENSEX** (index references and their listed futures/options). Anything else fails closed. `LIVE_TRADING=false`. No order code exists or is authorized.

## Delivery split
| Part | Content | State |
| --- | --- | --- |
| **A1 (this change)** | `packages/kite`: types and errors, read-only allowlist, rate limiting, session/exchange handling, instruments CSV parser, secret redaction. Offline, fixtures only. | implemented, locally tested |
| **A2** | REST quotes/LTP/OHLC client methods, historical candles, WebSocket ticker | pending |
| **B** | Provider and snapshot wiring (`QuoteProvider`, `OhlcProvider`, `InstrumentReference`, snapshot export), failure handling | pending |
| **C** | Gateway / order functionality | separate execution approval; nothing in A or B may call an order endpoint |

## Configuration (variable NAMES; values live in an env file outside the repo, never printed)
`TWINS_KITE_API_KEY`, `TWINS_KITE_API_SECRET` (needed only for the token exchange), `TWINS_KITE_ACCESS_TOKEN` (optional). Entitlement of the account (Connect plan, realtime and historical data) is **unverified**.

## Session design
A human completes the official browser login (`loginUrl(apiKey)`); the package never handles the password or TOTP. The `request_token` from the redirect is exchanged with the documented checksum (`SHA-256(api_key + request_token + api_secret)`) via `POST /session/token`, the single authentication exception to the read-only rule. A token is **unverified** until the server accepts a call (`verifySession()` -> `GET /user/profile`); `advisoryExpiry()` (about 06:00 IST) is a hint for operators and never decides validity. A `403` / `TokenException` invalidates the session, drops the token and stops all calls until a new exchange. Token persistence between runs is not part of this change.

## Guards
Only the allowlisted GET paths and `POST /session/token` can be sent (checked before the rate limiter or `fetch`); a source-scan test fails on any order/GTT/portfolio/margin path or extra write method. Errors carry fixed messages; server text is redacted and bounded. Instruments naming is verified against synthetic fixtures only and must be reconciled with a first live dump before wiring (B).

Tests: `tests/unit/kite/` (no network; fake `fetch`).
