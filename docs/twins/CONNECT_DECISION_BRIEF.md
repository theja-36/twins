# Kite Connect decision brief (for the owner; nothing has been purchased or called)

> Prepared 2026-11-03. Prices and plan contents come from Zerodha's published plan page as read on 2026-10-31 (`zerodha.com/products/api`); confirm them on the purchase page before paying, because the page does not list every endpoint per plan and prices can change.

## The decision
Buy the **Connect** plan (**INR 500 per month**, per the plan page; taxes and billing terms as shown at purchase) or stay on **Personal** (free).

## What each plan gives
| | Personal (free) | Connect (INR 500 / month) |
|---|---|---|
| Account reads: profile, margins, holdings, positions, orders, GTT list | yes | yes |
| Order / GTT management APIs (**TWINS never calls these**: every write path is refused in code) | listed by the vendor | listed by the vendor |
| Realtime WebSocket (ticks, depth, open interest) | **not listed** | yes |
| Historical candles | **not listed** | yes |
| Quote / LTP / OHLC REST | not listed (treated as unavailable) | listed under the full suite |

The code is deliberately conservative: on the default plan `personal` it refuses market data, candles and the WebSocket locally, before any request (verified on staging by the V11 probe).

## What Connect unlocks for TWINS
* **Real market data for the agents**: index spot, option quotes with open interest and volume, the option chain around the money, daily candles, and the instrument reference - published as one strict, all-or-nothing snapshot generation every minute during market hours (ready and fixture-tested; see KITE_INTEGRATION.md "Feed readiness").
* Fresh inputs for the liquidity, options-risk, technical-structure, price-action and historical agents, **but only once the agent engine is enabled**, which is a separate decision gated on the items below.
* A supervised view of how close the research assessment is to real market conditions (shadow mode, HB-06).

## What it does NOT unlock (still gated, none of it started)
1. **The agent engine stays disabled.** Enabling it needs: shadow / staged activation (HB-05, HB-06), engine alert routing (HB-18), the privacy question Q-009 for real-data disclosure, and the F1 independent review.
2. **No orders.** There is no execution code, no order path and no broker write capability; Stage 6 and a paper-trading phase come first, and `LIVE_TRADING` stays false. (For a later live phase, check whether the broker requires a registered static IP for order APIs; irrelevant to read-only use.)
3. **No automatic login.** The Kite login needs a person in a browser every morning (about one minute); the token lapses around 06:00 IST.
4. **The first live run is a separate approval**, with the unexplained callback origin of the earlier connectivity run resolved first.
5. Data-use terms: market data is subject to the exchange / vendor terms (internal research use only); read them before any redistribution, which TWINS does not do.

## What becomes possible the day after you buy it
Using the prepared pieces (no new code needed): create the host files and the egress allow-list, deploy the image that contains the feed code (a normal delta deploy, about 1 hour with the rehearsal), do the first morning login, run `check-config`, then a supervised first feed run during market hours with the published snapshots reviewed (they are only read by a disabled engine). Estimated owner effort: roughly 2-3 hours spread over a couple of days, plus one minute each trading morning.

## Costs and risks
* **Money:** INR 500 per month (about INR 6,000 per year), cancellable according to the vendor's terms. No other charge is incurred by TWINS.
* **Operational:** a new outbound network path (Kite hosts on tcp/443) from one dedicated container; mitigated by its own network, no database or Redis access, read-only code, and the host allow-list.
* **Data risk:** a stale or partial feed is never published (all-or-nothing, freshness-checked), and the engine that would read it is off.
* **Trading risk:** none from this step; no order path exists.

## Options
* **A. Buy Connect now** and proceed with the deploy and a supervised run (the fastest route to real data; the engine still stays off).
* **B. Wait**, keep everything dormant; nothing degrades (the dormant code is covered by CI).
* **C. Stay on Personal** and use Kite only for account reads (needs no purchase; gives margins / holdings / positions / orders visibility but no market data).

**Recommendation:** B or A depending on when the engine is expected to run: Connect only pays for itself once the engine, shadow mode and the Q-009 privacy answer are close, because until then nothing consumes the data. If you want to rehearse the whole feed chain end to end before the engine decisions, A for one month is the cheapest way.
