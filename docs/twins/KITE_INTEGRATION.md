# Zerodha Kite Connect integration (Integration 2) - delivery status

> Scope fixed by the owner: **NIFTY 50, BANKNIFTY, SENSEX** (index references and their listed futures/options). Anything else fails closed. `LIVE_TRADING=false`. No order code exists or is authorized.

See [KITE_LIVE_CONNECTIVITY_RUN.md](KITE_LIVE_CONNECTIVITY_RUN.md) for the redacted record of the first read-only live connectivity run (2026-10-31, market closed; connectivity only, not fresh-market validation; live activity paused).

## Delivery split
| Part | Content | State |
| --- | --- | --- |
| **A1 (this change)** | `packages/kite`: types and errors, read-only allowlist, rate limiting, session/exchange handling, instruments CSV parser, secret redaction. Offline, fixtures only. | implemented, locally tested |
| **A2 (implemented, locally tested)** | REST full quote / LTP / day-OHLC and historical-candle clients, plus pure mapping into `InstrumentQuote`, `LastPrice` and `OhlcSeries` (existing validators). No provider or snapshot wiring. | implemented, locally tested |
| **A3 (implemented, locally tested)** | WebSocket ticker: strict binary decoder, injectable transport, bounded reconnect, explicit freshness state. No provider or snapshot wiring. | implemented, locally tested; never run against a live feed |
| **B (implemented, locally tested)** | Provider adapters (`InstrumentReference`, `QuoteProvider`, `LastPriceProvider`, `OptionsQuoteProvider`, `OptionsChainProvider`, `OhlcProvider`) and a LOCAL snapshot exporter/publisher over the existing versioned schemas. Fixture evidence only; no live-hours validation, no R2 upload, no scheduler. | implemented, locally tested |
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

## Provider and snapshot wiring (B)
Composition lives in `packages/kite` (it depends on `@twins/agents`; the reverse never happens, and a test guards the direction).
- **Mapping**: TWINS keys an underlying by its spot market: NIFTY and BANKNIFTY -> `NSE`, SENSEX -> `BSE` (their derivatives are NFO / BFO at Kite). Keys: `NSE:NIFTY`, `NSE:NIFTY:2026-11-26`, `NSE:NIFTY:2026-11-26:24000:CE`. Only catalog-listed contracts resolve; anything else is null with a recorded reason. Indices are not exported as "equity" instrument records.
- **Sources**: a `QuoteSource` is REST (`restSource`, from `getFullQuotes`) or WebSocket (`websocketSource`, from the ticker). `chooseSource` returns exactly the requested one; there is no fallback, so a stale REST source is never silently replaced by a WebSocket one (or vice versa). A reading is usable only with an upstream exchange timestamp, a passing existing validator, and an age within the source's `maxAgeMs` measured at READ time.
- **Not invented**: Kite's quote has no implied volatility or greeks, so option quotes carry `iv`/greeks = null, the option chain rows carry `iv` = null, and `avgVolume` is null. The underlying price is attached to an option quote only when the index quote is within 60 s of the option's. There is no native option-chain endpoint: a chain is assembled from catalog-listed contracts around the money and is **all-or-nothing** (a missing row means no chain, never a partial one).
- **Historical**: the OHLC adapter applies as-of semantics (old bars are valid history); a possibly still-forming last bar is withheld unless asked for.
- **Snapshots**: `buildSnapshotDocuments` produces instrument-reference, quotes, option-quotes, option-chain, last-price and ohlc in the existing schemas and checks each with the consumer's own strict parser. File-level `as_of` is the OLDEST upstream timestamp among the entries (never the export time), so old data stays old to the snapshot validator. `publishGeneration` stages and inspects all documents with the consumer's `inspectSnapshot` (must be OK), marks a generation manifest `publishing`, replaces files with the consumer's atomic writer (previous kept), re-validates, then marks `complete`; any failure restores the previous files and manifest. An incomplete export (any requested entry missing) is refused unless `requireComplete=false`, and is then recorded `complete:false`. A crash mid-publish cannot be made atomic across files, but it leaves a `publishing` manifest that `verifyGeneration` reports as inconsistent.
- Local only: no R2 upload, no scheduler, no engine activation. Fixture tests are not live compatibility evidence.

## B acceptance follow-up
- **Instrument verification** (real `instrument-verification-v1`): each underlying's listed futures and options verify SUPPORTIVE (contract found, lot size present) with no change to the reference schema. The index SPOT is not a tradable instrument and the reference format has no index type, so verifying it as an "equity" is BLOCKED with `INSTRUMENT_NOT_FOUND` (fail-closed, not relabelled); the index is known as an underlying through its derivatives. Positively verifying an index spot would need a new `index` instrument type across the reference format, the agent and the risk-decision types: **a schema change that is NOT implemented and needs your decision.**
- **Reader-enforced generations**: `@twins/agents` now owns the generation contract (`.snapshot-generation.json`, `snapshotGeneration.ts`). Every file provider (`readJsonFile`, `fileInstrumentReference`) and the snapshot validation (`inspectSnapshot` / `listSnapshots`) refuse files owned by a generation that is `publishing`, mixed (a file differs from the manifest) or has an unreadable manifest, and a file read is re-checked against the manifest after it is read. A generation published as incomplete is MALFORMED (`GENERATION_INCOMPLETE`) for consumers unless `TWINS_AGENT_SNAPSHOT_REQUIRE_COMPLETE_GENERATION=false`. A directory without a manifest behaves as before. The publisher takes an exclusive lock (`.snapshot-publish.lock`; a crashed publisher leaves it for an operator to remove after review) and will not publish over a crashed generation unless the new one covers every kind that generation owned.
- **Wiring configuration** (`loadKiteWiringConfig`): quote max age = `rules.quotes.unavailableMinutes` and future tolerance = `rules.quotes.futureToleranceMinutes` (product rules; an override may only be stricter); the underlying-time window (60 s) and chain width (5 strikes each side) are **unapproved operational defaults, not tuned or production-ready**. Adapters, sources and the exporter refuse missing or invalid values.
- **With IV and greeks null**: Options Risk reports `IV_MISSING` and `GREEKS_INCOMPLETE` (CAUTION) and its IV level / IV spike / IV-above-ATM, theta, gamma, vega and delta families cannot fire; spread, open interest, volume, strike distance, expiry proximity and premium-versus-stop still work. Liquidity reports `AVG_VOLUME_MISSING` (INFO); its average-volume comparisons cannot fire. Nothing is modelled or relaxed.

## Guards
Only the allowlisted GET paths and `POST /session/token` can be sent (checked before the rate limiter or `fetch`); a source-scan test fails on any order/GTT/portfolio/margin path string or extra write method in the package source (the account READ paths live only in the allowlist's regex list, GET only). Errors carry fixed messages; server text is redacted and bounded. Instruments naming is verified against synthetic fixtures only and must be reconciled with a first live dump before wiring (B).

Tests: `tests/unit/kite/` (no network; fake `fetch`).

## P0 spine additions (2026-10-31)

- **Account reads (GET only):** profile, margins (`/user/margins[/equity|commodity]`), holdings, positions, order book and per-order history/trades, trades, GTT list/detail. Reached through `KiteClient.getAccountJson`; market data stays on `getJson`. Every write verb, order/GTT placement, modification, cancellation, holdings authorisation, mutual funds and logout remain refused for all methods. LIVE_TRADING stays false.
- **Plan matrix** (`packages/kite/src/plans.ts`, from zerodha.com/products/api read 2026-10-31): Personal (free) lists order/GTT/alerts management, margin computation and portfolio management, and does NOT list market data; Connect (INR 500/month) lists realtime WebSocket streaming and historical candles. The vendor page does not enumerate every endpoint per plan, so the table is conservative: unlisted means refused locally (`PLAN_RESTRICTED`) before any request or socket. The default plan is `personal`; the owner's actual plan is configuration, never inferred. Buying Connect needs explicit owner approval.
- **Alerts:** `telegram.capture.gap` (via `detectCaptureGap`), `kite.session.invalidated` (via the `Session` invalidation hook) and exhausted `worker.queue.job_failed` map to CRITICAL alerts. The detector and hook are code only; scheduling the capture-gap check on the host needs approval.
- **Not done:** daily-token persistence (0600 atomic store) and typed account-response parsers; live connection still requires owner approval.

## Merge prep (2026-11-02): what the merged code is, what it needs, what is missing

**Branch history reconciled.** `feat/kite-readonly-foundation` (A, A2, A3, B) had four `tsc -b` errors (BR-01). `feat/p0-spine` carried the four fixes plus the account reads and the plan gate on top of it, so it was used as the base, and current `main` (through PR #51, migrations 0000-0029) was merged in without conflicts. `tsc -b` is clean, lint has 0 errors, and the unit suite passes (148 files, 3016 tests).

**Included (all offline-tested with fixtures and a fake `fetch`; the test network guard fails any real network call, so CI never touches Kite):**
* Read-only gateway: request allowlist (exact method + path), login/token exchange with checksum, server-verified sessions, 403 / `TokenException` invalidation, rate-limit classes (quote 1/s, historical 3/s, default 10/s), bounded retries for safe reads only.
* **Account reads, GET only:** profile, margins, holdings, positions, order book, per-order history / trades, trades, GTT list. **Every write is refused for every method:** placing, modifying or cancelling an order or a GTT, converting a position, authorising holdings, mutual funds, logout.
* Instruments loader (CSV dump parser and catalog), quote / LTP / OHLC and historical-candle clients with contract mappings, strict binary WebSocket decoder and ticker (injectable transport, bounded reconnect), provider adapters, local snapshot exporter / publisher with reader-enforced snapshot generations.
* Plan gate (`plans.ts`) and the alert rules for capture gap, Kite session invalidation and exhausted queue jobs.
* One recorded read-only connectivity run (`KITE_LIVE_CONNECTIVITY_RUN.md`): connectivity only; the callback origin was never explained.

**Plan requirement (owner decision pending).** Zerodha's plan page (read 2026-10-31) lists for **Personal (free)** order / GTT / alerts management, margin computation and portfolio management, and **no market data**; **Connect (INR 500 per month)** lists the realtime WebSocket and historical candles. The code therefore refuses market data, historical candles and the WebSocket on the default plan `personal` (`PLAN_RESTRICTED`, checked before anything is sent); account reads work on both. Real market data needs Connect (a purchase that needs the owner's explicit approval) and `TWINS_KITE_PLAN=connect`. The vendor page does not enumerate every endpoint per plan, so the table is deliberately conservative.

**Not in this merge / still missing for real market data:**
1. The owner's plan decision and, for market data, the Connect subscription.
2. Daily access-token handling on the host: a 0600 atomic token store, the morning login step and expiry hand-off (tokens lapse around 06:00 IST); the session invalidation alert exists, the store does not.
3. A running ticker / poller on the host with market-hours validation, and the scheduled snapshot exporter (HB-11) that lands snapshots in the directory the agents read (HB-12 / HB-13).
4. Wiring the agents' providers to the snapshots, then a `shadow` rollout (HB-06) before anything uses real data; the engine stays disabled.
5. Typed parsers for the account-read responses (they are returned as parsed JSON).
6. Owner approval of a live run, with the unexplained callback origin of the earlier run resolved.
7. Hosted CI never makes a live call; a live run is a manual, approved operation.
8. No order, GTT, basket or position write exists or is planned here; execution is Stage 6+.
