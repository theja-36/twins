# #4 Options risk: data-source preparation (research only)

**Docs only. No provider call, no key, no firewall change, no code.** Web research done 2026-11-06; claims below are from search summaries and forum posts, not from official documentation, so each needs confirming on the vendor's own pages before any decision.

## What the agent needs
`options-risk-v1` already exists and returns UNAVAILABLE without data. It takes an injected option quote and chain per contract: premium, bid/ask spread, IV and IV change, delta, theta, gamma, vega, open interest, volume, quote time, plus an underlying price. Missing greeks degrade to CAUTION rather than passing. So the missing piece is only a source, published as a read-only provider file in the same exporter pattern (hostname-pinned, no key in chat).

## Candidates

| | Zerodha Kite Connect | DhanHQ |
|---|---|---|
| Premium, bid/ask, volume, OI | Quote endpoints exist; option OI per contract not confirmed from what I found | Option chain returns LTP, best bid/ask, volume, OI |
| IV and greeks | **Not provided via API** (a Zerodha staff reply on the developer forum says Kite Connect is an execution platform and points to data vendors; greeks/IV appear in the Kite app only). They would have to be computed by us from price, which needs a rate, dividends and an IV solver | **Returned by the option chain** (delta, theta, vega, gamma, IV), per Dhan's announcement as quoted on its community forum |
| Access | Needs the daily token refresh, which is deferred | Owner's existing Dhan account; token handling not yet looked at |
| Rate limit | Not checked | Reported inconsistently: 1 request/sec (staff forum reply), 1 per 3 sec (unofficial client). Confirm before sizing a pass |
| Cost | Not checked | Not found; confirm |
| Terms | Check redistribution/storage terms | Check data-API terms, as was done for Marketaux |

## Recommendation (judgement)
Dhan looks like the better first source for #4, because it appears to supply IV and greeks directly, whereas Kite would force us to compute them and still depend on the deferred token refresh. This reverses the earlier "Kite first, Dhan backup" order, so it is your decision, not mine. Kite remains the better source for plain quotes and underlying prices once its token is refreshed.

## Before any build
1. Confirm on Dhan's official docs: endpoint, fields, rate limit, price, terms of use for storing and deriving from the data, and how its access token is issued and renewed.
2. Your go-ahead for a new external API call and a firewall rule (a separate approval, same as Marketaux).
3. Decide scope: long calls/puts only (what the agent assumes) versus spreads; NIFTY/BANKNIFTY weeklies versus stock options.

## What can be built without any live call
A pure parser and validator for a Dhan-shaped option-chain file into the agent's `OptionChain` / quote types, tested on synthetic fixtures, plus the exporter wiring behind a disabled switch. Nothing would contact Dhan until approved.

## Sources
* Dhan community post: "Now Live: Option Chain with Greeks on DhanHQ API" (madefortrade.in)
* Kite Connect forum: "How do I get option greeks data like delta theta of a particular strike price" (kite.trade)
* Zerodha help pages on the Kite option chain (UI features)

## Update 2026-11-07: dormant Dhan wiring built (owner order), PR open, HOLD
`scripts/ops/dhan-options-export.ts` (config, client, pass and CLI in one file, kept OUT of the providers package because a repository test restricts that package to the two provider hosts and no environment access) connects the Dhan converter to a host-pinned POST client and a one-shot pass that publishes `dhan-option-quotes.json` and `dhan-option-chain.json` into the providers folder. It is off in four independent ways: `TWINS_DHAN_OPTIONS_ENABLED` must be `true`; a token and client id must be in the environment; it is not in the exporter loop and not a compose service; no firewall rule or egress entry exists for `api.dhan.co`. The request shape is an assumption never executed. Tests use a fake fetch only (10). Nothing reads the two files yet. Enabling it needs your decisions on the Data plan cost, a credential, the firewall rule, and verification against Dhan's official docs.
