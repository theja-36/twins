# Market, liquidity and event-risk gates - Stage 3 / Task 5

> Decision [D-059](DECISION_LOG.md); requirement [SZ-16](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [POSITION_SIZING.md](POSITION_SIZING.md), [PORTFOLIO_RISK_LIMITS.md](PORTFOLIO_RISK_LIMITS.md), [CIRCUIT_BREAKERS.md](CIRCUIT_BREAKERS.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/risk/src/market/` (`config`, `sessions`, `expiry`, `engine` pure; `windows`, `record`), migration `0018_market_risk_gates`.

Nothing here places an order, calls a broker, sends an approval card or creates executable state. **No live market-data provider, calendar or news feed is integrated or called.**

## 1. Where the gates sit - the only route to APPROVED_FOR_REVIEW
`PENDING` → **sized** (v2, Task 2) → **portfolio-passed** (v3, `PENDING`, Task 3; the snapshot outcome `APPROVED_FOR_REVIEW` there means "passed") → **market gates** (v4, this task) → `APPROVED_FOR_REVIEW`. Passing the portfolio limits is therefore no longer an approval (it was in Task 3; changed here, D-059). The database enforces the whole chain: an `APPROVED_FOR_REVIEW` row needs a SIZED size (0015), a passing portfolio evaluation (0016), **`output_snapshot.market.outcome = 'PASSED'` (0018, NOT VALID: enforced for every new row)**, and no open loss breaker (0017).
`evaluateMarketRisk(db, decisionId, opts)` evaluates the current version when it is a portfolio-passed `PENDING` decision (or its own earlier market evaluation) and appends one new chained version (`service:market-risk`):
* all gates pass → `APPROVED_FOR_REVIEW` (reason `market_gates_passed`);
* any gate fails → `REJECTED` (reason `market_<reason>`, machine-readable, all failures listed);
* only a WARNING event window → `PENDING`, **conditional** (reason `market_conditional_event_blackout_warning`): never approved automatically.
The version stores every gate result, the observed values, the thresholds, the active event windows, the market-data snapshot and an input hash. Idempotent (identical inputs return the same version, also when retried against the superseded one or in parallel); changed data appends the next version, including falling back from approved to rejected.

## 2. Sessions (timezone-aware; Intl)
| Session | Markets | Default hours (local) | Days |
|---|---|---|---|
| IN | NSE, BSE, NFO, BFO | 09:15-15:30 Asia/Kolkata | Mon-Fri |
| US | NYSE, NASDAQ, AMEX, ARCA | 09:30-16:00 America/New_York (DST honoured) | Mon-Fri |
| JP | TSE, JPX, OSE | 09:00-15:00 Asia/Tokyo | Mon-Fri |
Open is inclusive, close exclusive. Override: `TWINS_MARKET_SESSION_IN|US|JP=HH:MM-HH:MM@Area/City` (malformed → the loader throws). A market with no session is never open. Weekend or out-of-hours → `MARKET_CLOSED`; a holiday → `MARKET_HOLIDAY`.
**Holidays:** `HolidayCalendar { isHoliday(sessionKey, localDate) }` with an **empty default** (`emptyHolidayCalendar`); no holiday is hardcoded. Until an owner-maintained calendar is supplied, a weekday market holiday looks like a normal trading day (the data-freshness gate is then the practical protection: a closed exchange publishes no fresh quotes). `staticHolidayCalendar({IN: ["2024-01-26"]})` shows the shape.

## 3. Expiry rules (options and futures; equity has none)
A contract expires at the **close of its market's session on the expiry date**. `EXPIRED_CONTRACT` once that instant has passed; `EXPIRY_TOO_SOON` when fewer than the minimum minutes remain (default **30** for options **and** futures: `TWINS_MARKET_MIN_MINUTES_TO_EXPIRY_OPTION|FUTURE`); a missing, malformed or impossible expiry (or one with no session) → `INVALID_MARKET_DATA` (never guessed).
**Expiry day** (the local date equals the expiry date) is stricter: the liquidity minimums are multiplied (default ×2) and the maximum spread multiplied (×0.5); data that passes a normal day but not these fails with `EXPIRY_DAY_RESTRICTION`. `TWINS_MARKET_EXPIRY_DAY_BLOCK=true` blocks new approvals on the expiry day outright (default false). The stop-loss, sizing, portfolio and breaker requirements are untouched.

## 4. Event blackout windows
Admin-defined, in the append-only, hash-chained `event_blackout_windows` table (the tenth audit chain): market (or `ALL`), scope `MARKET` or `SYMBOL` (+ symbol), severity, start, end (exclusive; at most 31 days), reason code. A window is never edited or deleted: a `CANCELLATION` row (which must describe the window it withdraws) cancels it. **CRITICAL** active → `EVENT_BLACKOUT_ACTIVE` (REJECTED). **WARNING** active → conditional (`PENDING`), never approved, and a WARNING never softens another failure. Interface for future providers: `EventWindowSource.listWindows({market, symbol, at})` (`databaseEventWindows(db)` is the manual source; `staticEventWindows(list)` for tests). Operations: `risk-control blackout add|cancel|list` (see the CLI header). Windows are read at evaluation time; an unreadable source → `event_windows_unavailable`, nothing written.

## 5. Market data, liquidity, spread, freshness
Interface `MarketDataProvider.getSnapshot(query)` → `{ last, bid, ask, bidQty, askQty, volume, openInterest?, timestamp }`. **No provider is configured in any process** (the worker's `marketDataProvider` is unset and no code sets it): in production a portfolio-passed decision therefore stays `PENDING` (`worker.risk_market.skipped no_market_data_provider`) and can never become approval-eligible. Tests inject synthetic providers.
| Gate | Rule (defaults; per kind equity / future / option) | Reason |
|---|---|---|
| Data validity | last, bid, ask > 0; bid ≤ ask (not crossed); quantities and volume ≥ 0; open interest present for options/futures; valid timestamp, not in the future; **entry price within 5% / 5% / 25% of the last price** | `INVALID_MARKET_DATA` |
| Freshness | age ≤ **60 s** (`TWINS_MARKET_MAX_DATA_AGE_SECONDS`) | `STALE_MARKET_DATA` |
| Liquidity | bid and ask quantity ≥ **100 / 50 / 50**; volume ≥ **10,000 / 1,000 / 100**; open interest ≥ **– / 10,000 / 1,000** | `INSUFFICIENT_LIQUIDITY` |
| Spread | (ask − bid) / mid ≤ **0.5% / 0.5% / 5%** | `SPREAD_TOO_WIDE` |
Environment: `TWINS_MARKET_MIN_QTY_`, `_MAX_SPREAD_PCT_`, `_MIN_VOLUME_`, `_MIN_OI_`, `_MAX_ENTRY_DEVIATION_PCT_` + `EQUITY|FUTURE|OPTION`. **These numbers are proposed conservative defaults, not calibrated to any real market data - they need owner review** (D-059). Missing data (no snapshot, provider failure) is not a verdict: the evaluation **fails closed** (`market_data_unavailable`) and writes nothing.
Other gates: **circuit breakers** (`CIRCUIT_BREAKER_ACTIVE` when a loss breaker is open) and **runtime safety state** (kill switch / intake / unreadable state refuse before any data is read).

## 6. Outcomes and precedence
Reasons: `CIRCUIT_BREAKER_ACTIVE` › `MARKET_HOLIDAY` › `MARKET_CLOSED` › `EXPIRED_CONTRACT` › `EXPIRY_TOO_SOON` › `EXPIRY_DAY_RESTRICTION` › `EVENT_BLACKOUT_ACTIVE` › `INVALID_MARKET_DATA` › `STALE_MARKET_DATA` › `INSUFFICIENT_LIQUIDITY` › `SPREAD_TOO_WIDE` (the first failing one is the primary reason; all are stored). Errors that write nothing: `safety_refused`, `market_data_unavailable`, `event_windows_unavailable`, `circuit_breaker_unavailable`, `sizing_missing`, `portfolio_missing`, `stop_loss_not_valid`, `decision_expired`, `not_found`, `not_evaluable`, `not_latest_version`.

## 7. Alerts (existing alerting; fixed templates; only `reason` and `kind`)
`risk.market_gate.warning` **WARNING** for stale data, wide spread, low liquidity, approaching expiry (`EXPIRY_TOO_SOON`) and a failed expiry-day rule - only for the evaluation THIS call recorded (retries do not repeat it). `risk.market_gate.data_unavailable`: **CRITICAL** when the provider fails (operational failure), WARNING when it returns no data. **No alert** for a closed market, holiday, weekend, expired contract, blackout or open breaker (normal rejections). No symbol, price, message or identity is included; secret-shaped values are redacted by the allow-list.

## 8. Limits and remaining risks
* No real market data exists, so no decision can currently reach `APPROVED_FOR_REVIEW` outside tests; the thresholds are untested against real quotes.
* No holiday calendar: weekday holidays are not recognised until one is supplied.
* Underlying/expiry come from the decision as recorded; no instrument-master cross-check beyond that (the options contract verification of earlier tasks is unchanged).
* Displayed bid/ask quantity is compared with absolute minimums, not with the planned position size.
* Expiry is evaluated at the session close of the market; exchange-specific early expiry/settlement rules are not modelled.
* The worker has no alert wiring in staging unless the alert relay variables are present; events are always recorded.
