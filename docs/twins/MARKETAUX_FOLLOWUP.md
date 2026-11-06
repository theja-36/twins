# Marketaux follow-up (status and ready-to-send draft)

**Status 2026-11-07:** the written-permission email was sent on 2026-11-06; no reply is known to me (I cannot read the mailbox; tell me if one arrived). PR #97 (offline adapter) is open, **updated with current main (conflicts resolved, decision renumbered D-111), not merged**. No Marketaux request has ever been made from the repository or the host; no key or setting exists on the host.

## Gate list (unchanged)
1. Written permission from Marketaux for our use (storage and derivation for personal analysis).
2. Owner go-ahead to activate.
3. Then, in order: shape check against a real response, key installed on the host by stdin only, hostname-pinned firewall rule (separate go-ahead), merge #97, deploy, supervised first pass. Runbook: `docs/twins/MARKETAUX_FIRST_TEST_RUNBOOK.md`.

## Follow-up email draft (for the owner to send; I cannot send email)
Subject: Follow-up: permission to use Marketaux news/sentiment API for personal research

Hello,

I wrote on 2026-11-06 about using the Marketaux API (free plan) for personal, non-commercial market research: fetching news and sentiment for a small list of tickers, storing the results privately on my own server, and using them only for my own analysis. I will not redistribute the data or share access.

Could you please confirm in writing that this use is allowed under the free plan, and let me know if there are any conditions (attribution, retention limits, request caps) I should follow? I will stay within the 100 requests per day limit.

Thank you,
[name]

## If there is still no reply
* Do nothing live; the adapter stays offline. News is partly working via GDELT (intermittent 429s; sentiment mostly missing).
* The news and sentiment agents are not wired to the news file yet, so no decision currently depends on either source. The only visible effect of missing news is the "unusable source" count in the reduce-only sizing shadow.
