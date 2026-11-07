# Phase 5: broker connect (Groww, Dhan, Kite): terms and API research

**Research only: no live call, no account action, no subscription, no credential, no firewall change. No order of any kind.** Researched 2026-11-07 from web search summaries of vendor pages, forum posts and third-party guides. The primary SEBI / NSE circular text and each broker's Terms of Use were NOT retrieved, so every row marked "verify" must be confirmed on the vendor's own pages before any decision. Where sources disagreed, the disagreement is stated.

## Summary table
| | Zerodha Kite Connect | Groww Trade API | Dhan (DhanHQ) |
|---|---|---|---|
| Plans / cost | Personal: free, orders and portfolio but no market data. Connect: INR 500 per month per API key (already bought, D-090) | Product page: paid plan INR 499 plus taxes per month. A free tier covering orders and portfolio but not live quotes or candles is reported by one blog (verify) | Trading APIs free; Data APIs INR 499 plus taxes per month (option chain with greeks is in the Data plan) |
| Market data | Quotes, instruments, historical candles on Connect. **No IV or greeks.** Expired option history not available | Live data, historical candles, option chain and greeks reported (verify) | Live feed, quotes, historical, intraday, depth, option chain with greeks on the Data plan |
| Orders / portfolio / margin | Yes. Our client is deliberately read-only (no order method, allow-list refuses every write) | Yes: orders, portfolio, margin (official product page) | Yes |
| Token | Daily, lapses about 06:00 IST; login needs a human in a browser | Reported daily expiry 06:00; official SDK offers key + secret and a TOTP flow (verify) | Third-party blog says about 30 days from the web console (unconfirmed); other sources imply shorter |
| Rate limits | Quote 1/s, historical 3/s, other 10/s (our client's documented limits) | Sources conflict: orders 10-15/s and 250/min; live data 10/s and 300/min; token endpoint 150 per 24 h (verify on the official page) | Reported 1 request/s for the option chain (staff reply) vs 1 per 3 s (unofficial client) |
| Static IP for orders | Required for order endpoints per Zerodha's FAQ (one primary + one optional secondary, account-level; sharing beyond immediate family risks suspension). Not required for login or data calls | Expected under the same SEBI framework (verify) | Expected under the same framework (verify) |

## Regulation that applies to any order API (secondary sources, verify against the circulars)
* SEBI's retail algo framework is reported as in force for all brokers from 1 April 2026, with the earlier broker milestones in late 2025.
* Retail API access: a unique vendor-client API key, a **whitelisted static IP** (one or two), OAuth plus two-factor, automatic daily session logout, an algo identifier tagged on orders, a broker kill switch.
* Registration of the algo is reported to be required above 10 orders per second; below that a personal algo needs no separate registration but is still tagged.
* Hosting on Indian servers is mentioned by some sources.

## What this means for TWINS
1. **Nothing to build for orders now.** Stage 6 is off; the Kite client stays read-only.
2. **Static IP:** the staging host would be the whitelisted address. Whether it has a fixed address, and where its datacenter is, has not been checked (check before any order work; the egress firewall already pins destinations, not our source).
3. **Token operations differ by broker.** Kite needs a daily human login (a standing morning chore). Groww reportedly allows a TOTP flow; Dhan may have a longer-lived token. Whichever is chosen for orders adds a credential, its renewal, and an alert for a missed renewal (the token-check timer pattern).
4. **Data versus execution are separate choices.** Kite (already paid) covers index/option quotes and bars; IV and greeks need another source (Dhan's option chain or computing them). Execution can use a different broker than data.
5. **Abstraction:** a broker-neutral adapter interface (read: instruments, quotes, candles, positions; write: absent until Stage 6) with one implementation per broker would keep the choice open. The current Kite package is Kite-specific.
6. **Terms to read before choosing:** each vendor's API terms on personal automation, storage and derivation of market data, multi-device or multi-IP use, and what happens on a suspension.

## Recommendation (judgement)
Stay on Kite as the primary data source and the first execution candidate (already paid, already integrated read-only, known token routine). Keep Dhan as the option-greeks source only if #4 needs it and the INR 499 is justified (you skipped it on 2026-11-06). Treat Groww as a candidate for a second broker or a TOTP-based token flow after reading its official terms. Decide nothing until the verification list below is done.

## Decision (owner, 2026-11-07)
Kite first (data and execution); Dhan only if greeks are needed; Groww terms check before it is considered. Before any order work: check whether the host has a fixed public address and where its datacenter is (not yet checked).

## Verification list (from official pages, before any build)
Each broker: current plans and prices; API terms of use; token lifetime and renewal method; official rate limits; static IP rule and registration steps; order tagging requirements; data licensing for storage and derived use. SEBI / NSE: the actual circulars and the exemption for personal use.

## Sources
* Groww: [API trading on Groww](https://groww.in/trade-api), [official SDK docs](https://groww.in/trade-api/docs/python-sdk), [Groww API review (Chittorgarh)](https://www.chittorgarh.com/broker/groww/api-for-algo-trading-review/173/), [market-data note (oidata)](https://www.oidata.in/blog/groww-api-market-data).
* Zerodha: [Kite Connect API FAQs](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/kite-connect-api-faqs), [static IP discussion](https://tradingqna.com/t/static-ip-for-algo-trading-in-zerodha/189901), [Personal API made free](https://tradingqna.com/t/kite-connect-personal-apis-are-now-made-free-for-personal-use/181620).
* Dhan: [Data API subscription](https://dhan.co/support/platforms/dhanhq-api/how-does-the-dhanhq-data-api-subscription-work/), [option chain with greeks](https://madefortrade.in/t/now-live-option-chain-with-greeks-on-dhanhq-api/38678).
* SEBI retail algo framework (secondary): [algobulls](https://algobulls.com/blog/industry-insights-and-updates/sebi-new-algotrading-regulations-for-retail-investors-2026), [antsheel](https://antsheel.com/blog/sebi-retail-algo-trading-rules-2026-india/), [alphaquark](https://alphaquark.in/blog/sebi-retail-algo-trading-rules-2026-guide).
