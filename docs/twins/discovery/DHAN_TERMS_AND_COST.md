# Dhan data: terms and cost check (research only)

**Docs only. No call was made to Dhan; nothing was signed up for.** Findings are from search summaries of Dhan's support pages, community posts and third-party guides, researched 2026-11-06. Dhan's own Terms of Usage were NOT retrievable, so the licensing questions below remain open. Companion to [OPTIONS_DATA_SOURCE_PREP.md](OPTIONS_DATA_SOURCE_PREP.md).

## Cost
* Trading APIs: free (Dhan support pages, community post).
* **Data APIs: INR 499 plus taxes per month**, auto-renewing every 30 days from the ledger balance (Dhan support page "How does the DhanHQ Data API subscription work?"). Taxes are labelled "taxes" on one page and "GST" on another.
* Option chain data is listed as part of the Data API (with live feed, quotes, historical and intraday data, market depth). So the option chain needs the paid Data plan.
* A waiver for active traders (a minimum number of trades per month) is mentioned as a question but I found no confirmed answer, and a guide says Dhan has changed it over time. Do not assume it.

## Access token
* One third-party blog says a token generated from the web console lasts about 30 days; I could not confirm this on an official page, and other sources imply a shorter daily renewal. Unconfirmed.
* Either way this is a new credential to hold, with its own renewal: a separate approval, and never pasted in chat.

## Rate limit
* Reports conflict (1 request per second per a Dhan staff reply; 1 per 3 seconds per an unofficial client). An hourly or few-minutes-cadence pass for NIFTY and BANKNIFTY expiries is far below either.

## Not established (must be confirmed on Dhan's official Terms before any live use)
1. May we store the data in files and derive risk verdicts from it on our own server (personal use)?
2. Is any redistribution restricted? (We do not redistribute; the files are private on one host.)
3. Is exchange-data licensing for derived/stored use stated?
4. Exact response schema of the option-chain endpoint (the converter is built on an assumed shape; see below).

## Decision needed from the owner
Whether to pay INR 499 per month plus taxes for the Data plan, and to authorize: (a) reading Dhan's official Terms yourself or by me with a page you provide, (b) a new credential, (c) the firewall rule for Dhan's API host (a separate go-ahead). None is assumed.

## What is already built
`convertDhanOptionChain` ([packages/providers/src/dhanOptionChain.ts](../../../packages/providers/src/dhanOptionChain.ts)): a pure converter from a Dhan-shaped response to the existing `twins-option-quotes-v1` / `twins-option-chain-v1` files, validated by the agents' own parsers. No network, no credential, not wired into the exporter (so it is disabled by construction). Tested on synthetic fixtures only; the response shape is an assumption until checked against the official docs or a real response.
