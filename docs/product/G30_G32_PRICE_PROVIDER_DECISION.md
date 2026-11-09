# G-30 / G-32: real-price validation, data contract and provider decision

**Status:** provider-independent price checks IMPLEMENTED and TESTED (`packages/historical/src/outcomes/priceQuality.ts`, 9 unit tests). No real price source is connected; every paper outcome stays FIXTURE-backed and analytics keep reporting NOT_VALIDATED_FIXTURE. G-30 and G-32 stay OPEN (Stage 10).

## What is required
G-30 needs closed paper positions priced from real bars with real resolution times, with fixtures never counted. G-32 needs historical bars to estimate what unexecuted decisions would have done. Both need option-premium history for the claimed contract (including contracts that have since expired), the underlying's bars, and point-in-time retrieval.

## Provider-independent contract (extends `twins-historical-bars-v1`, which already has provider, dataset id/version, sha256, per-bar ISO offsets and gap limits)
| Item | Rule (status) |
|---|---|
| Instrument and derivative identity | series key = canonical contract (see `G38_CONTRACT_MASTER.md`); today (symbol, strike, optionType, expiry) (partial) |
| Exchange, session, timezone | explicit exchange, session start/end, tz offset; calendar supplied by the caller (`SessionSpec`; implemented) |
| Bars | OHLCV in the existing format; a bar covers [ts, ts + interval) (existing) |
| Point in time | a bar is knowable only when closed AND retrieved: `barsKnownAt(bars, interval, asOf, retrievedAt)` (implemented). The dataset file does not yet record `retrievedAt`: add it to the descriptor when a provider is connected |
| Missing bars, holidays, stale data, quality | `assessBars` reports MISSING_BARS, BAR_ON_NON_TRADING_DAY, BAR_OUTSIDE_SESSION, duplicates/unsorted, invalid OHLC, STALE; status GOOD/DEGRADED/INSUFFICIENT (implemented) |
| Corporate actions | NOT in the format: equity series need an adjustment basis flag and factors; options on indices are unaffected (missing) |
| Revisions | per-dataset version + sha256; no per-bar restatement history (missing; handled by keeping every frozen snapshot) |
| Provenance | provider, dataset id/version, sha256 (existing); add source URL, retrieval time, licence reference (missing) |
| Calendars | three unlinked holiday sources exist (agents calendar snapshot, Kite hours env, evaluator tz map); unify before real data (missing) |

## Sources (checked 2026-11-09; V = read from the page)
| Source | Verified facts | Gaps |
|---|---|---|
| Dhan Data API | intraday 1/5/15/25/60-minute, up to 5 years, 90 days per call (V); expired index and stock options up to 5 years, 30 days per call, OHLC/IV/volume/OI/spot, but strikes only ATM +/-10 (index, near expiry) or ATM +/-3 (others) (V) | no verified BSE/SENSEX coverage; monthly fee about 499 INR was a search snippet only; terms and storage rights unverified |
| Zerodha Kite Connect | minute to day candles; expired option candles NOT retrievable (tokens flushed at expiry); paid plan stated as 500 INR/month (V) | cannot resolve expired option claims; good for underlying and live |
| Upstox expired-candles API | examples include an expired NIFTY option key; needs a paid Plus plan (V) | coverage and depth not explicitly stated; price not published |
| NSE Data & Analytics / BSE official data / TrueData / GDFL | not verified (pages timed out or 404) | procurement quote needed for an audit-grade source |
| Yahoo, bhavcopy | not verified; end-of-day only or personal-use licence | not suitable |
No source documents point-in-time ("as-of") retrieval or corporate-action adjustment: we must stamp our own retrieval time and freeze snapshots.

**Recommendation:** primary = Dhan Data API (the only verified 1-minute expired-option history), accepting its strike window and the need for a separate SENSEX source; alternative = Upstox expired-candles after a small paid trial; add an NSE Data & Analytics / vendor quote if the evidence must withstand audit. **Approval requested:** `STAGE_03_DECISION_PACKAGE.md` item C. Nothing is purchased or connected.

## Acceptance criteria to close G-30 / G-32
A licensed source connected through the provider interface; frozen, hashed snapshots with retrieval times; `assessBars` GOOD on the evaluated windows or the gaps reported; resolved outcomes carry real prices and resolution times (see G-39); analytics label fixture and real outcomes separately; CI green.
