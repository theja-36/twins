# Phase 3: Telegram news source plus Marketaux (design only)

**No code, no live call, no activation. Marketaux stays unrequested until written permission and your go-ahead.** Companion to P1 #12 (`newsImpact`, built offline) and the Marketaux adapter (PR #97, open, offline).

## Goal
One news view per symbol that combines (a) the news API feed (Marketaux, or GDELT today) and (b) non-signal commentary in the Telegram channels you already capture, without letting untrusted text steer the system and without letting good news increase risk.

## What exists
* `twins-news-v1` file (items with id, time, source label, headline, symbols, impact, sentiment, reliability) and a strict reader; GDELT feeds it intermittently (rate limits); sentiment mostly missing.
* Marketaux adapter built offline: free plan 100 requests/day, 3 articles per request; shape check and runbook exist; not activated.
* `newsImpact` (pure): time decay, reliability and relevance weights, flags THIN / STALE / CONFLICTING / SPIKE, and only ever recommends caution (never an increase).
* The news and sentiment agents are not wired to the news file yet.
* Telegram captures many messages that are not signals (commentary, results). Result reports are now classified `result_report`; other non-signal messages are simply `none`.

## Design
1. **Two inputs, one output.** API news (headline allowed, as today) goes to `news.json`. Telegram commentary goes to a SEPARATE `channel-news.json` (format `twins-channel-news-v1`) containing only structured fields: message id, time, channel (masked), symbols mentioned (matched against the instrument reference, never free text), theme codes from a FIXED vocabulary (earnings, rates, oil, results, policy, global cues), and a polarity from a fixed word list (negative / neutral / positive). **No Telegram sentence ever reaches an agent**, which removes the prompt-injection and advert-text path.
2. **Reliability is earned, not assumed.** API items use the provider's reliability; channel items start at a low default (0.3) and move only with the channel's scorecard tier (same mechanism as signals). A channel with no tier stays low.
3. **Corroboration.** Items are clustered by (symbol, theme, 2-hour bucket). A cluster with an API item and a channel item counts as corroborated (confidence up); channel-only clusters stay low weight; opposite polarity makes the cluster MIXED.
4. **Asymmetry kept.** The combined impact can raise caution or a review of new entries; it never raises size or removes a block (same rule as `newsImpact`).
5. **Dedup and limits.** One item per id; near-duplicate channel posts (same symbols, theme, polarity inside 30 minutes) collapse to one with a count; hard caps on items per file and per symbol.
6. **Health.** Both files appear in the source-health profile (status, age, count) like the other providers; an empty channel-news file is "no commentary", not "all clear".
7. **Failure behaviour.** Any unreadable file means that input is UNKNOWN; the other input still works; nothing is presented as fresh when it is not.

## Gates before anything is live
Marketaux written permission and your go-ahead (then the existing runbook: shape check, key by stdin, hostname-pinned firewall, merge #97, deploy); wiring the news agent to the files (shadow first); an owner decision on the Telegram theme vocabulary and word list; calibration on real data (none exists yet).

## Risks
Channel commentary is promotional by nature (pump risk); the polarity word list is crude; theme codes miss nuance; clustering windows are guesses until measured. All are reasons to start in shadow and weight channel input low.

## Open questions
Which channels count as news sources (their own list, separate from signal channels)? Is a second API provider wanted as a fallback to GDELT if Marketaux is refused? Should channel news ever be shown on the decision card, or only feed the confidence weighting?

## Built offline (2026-11-07, batch 7)
`packages/agents/src/channelNews.ts`: structured extraction (instrument-reference symbols, fixed theme codes, polarity from fixed word lists; the message is read in memory and never copied), skipping of signals, claims and result reports through an injected classifier (so the agents package gains no dependency on the intake parser), near-duplicate collapse, symbol x theme x 2-hour clustering with a MIXED flag, `combinedNewsImpact` (API plus channel; corroboration labels; **channel-only evidence capped at CAUTION**; good news recommends nothing), and the strict `twins-channel-news-v1` file builder and parser. 12 unit tests. Not wired: nothing writes the file, the news agent does not read it, no exporter pass produces it.
