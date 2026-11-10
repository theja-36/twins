# DRAFT: Stage 03 owner decision review (2026-11-10)

> **Cross-reference 2026-11-10:** the owner approved Option A (engineering/validation boundary). This document is still a DRAFT; its decisions D0 to D7 are the deferred external-validation decisions listed in `STAGE_03_ENGINEERING_BOUNDARY_AND_ACCEPTANCE.md`.


**Status: DRAFT, for the product owner's review. Not committed. It does not replace or change `STAGE_03_DECISION_PACKAGE.md`; where it differs, this draft says so.** Written from the existing Stage 03 documents plus public web pages read on 2026-11-10 (nothing was connected, imported or purchased). Marking: **[V]** = read from a fetched page, **[S]** = search-result summary only, **[U]** = unverified or unknown.

## 1. Verified engineering baseline (no item below is reopened)
| Item | Evidence |
|---|---|
| G-19 claim-to-candidate pipeline, migration 0042 | CI run 42522586920 (`3c4d22c`) |
| Read APIs, migration 0043 playbook guard, temporal matcher | `c4b1e73` run 42685359712; `67dee94` run 42528709453 |
| G-37 decided (option 1: unstated and "near" entries stay INCOMPLETE) | owner decision 2026-11-09; policy and adversarial tests in CI |
| G-39 point-in-time scorecards by default (`source-scorecard-v2`) | `29e7fab` run 42686591238 (window assertions 50/30/50 to 46/26/46 held) |
| G-40 point-in-time pattern training (`pattern-metrics-v2`), G-41 decision-time research packages, legacy runs flagged `pointInTime: false` | `1aa2e85` run 42894318636: 7 of 7 jobs; unit 245 files / 4,011 tests on Node 20 and 22; integration 81 files passed, 2 skipped, 1,089 tests passed, 4 skipped; both G-41 tests and all 9 `patterns.test.ts` tests passed |
| G-42 web login and sessions (against a TEST-ONLY backend stand-in) | frontend `7ba47bc` run 42689637294; latest frontend `3dcbb6c` run 42892773857: 79 unit, 50 Playwright, build, bundle check |
| Provider-independent building blocks: canonical contract record (11 tests), classifier evaluation harness (12), price-quality checks (9) | `72c7831`; synthetic tests only, no real data |

## 2. Remaining blockers
M02-15, M01-14, G-38, G-30, G-32, G-42 (real backend), and historical leakage proof on a real authorised archive. Every one needs data, a provider, an environment or a decision that code cannot supply.

## 3. Decision options per blocker

### D1: M02-15 classifier accuracy on real Telegram messages
- **Decision:** may real channel messages be read and labelled, which channels, how many, who labels, where text is stored, how long it is kept.
- **Options:** (a) pilot of about 300 messages from 2 to 3 channels, last 90 days, exported by you; (b) full 600+ in one step; (c) defer.
- **Pros and cons:** (a) sizes labelling effort and tests the guide before the 200-claim floor, but is too small to publish accuracy; (b) reaches the floor sooner, higher labelling cost and privacy exposure; (c) accuracy stays unknown.
- **Technical:** harness, dataset schema and leakage checks exist (`M02_15_DATASET_AND_ANNOTATION_SPEC.md`); text stays outside Git in an encrypted store.
- **Data:** JSONL with timestamps (with offset), revisions, labels from two annotators plus adjudication. **Provider:** none.
- **Cost:** no provider cost; reviewer time (2 annotators + 1 adjudicator); estimate not available.
- **Licence/privacy/security:** you must be entitled to read the channels; members' messages are personal data; no text in logs, CI or hosted-AI prompts; retention is your call.
- **Impossible until decided:** any claim of real-world accuracy.
- **Recommended:** (a). **Reversible:** yes (delete text, keep labels and hashes).

### D2: G-38 instrument/contract master source
- **Decision:** which source is the authoritative contract master, and whether a broker-published file may stand in.
- **Options:** (a) NSE contract master + BSE equity-derivatives contract master (exchange files); (b) Upstox public instrument JSON as the day-to-day cross-check; (c) Dhan scrip master (already parsed by the repo); (d) paid vendor or NSE Data & Analytics.
- **Facts:** Upstox instrument JSON is public, daily, NSE and BSE, drops expired contracts **[V, earlier research]**. Brokers state exchange tokens are reused after expiry **[V]**, so contract identity never rests on a token. NSE says it owns market data and that non-display use (automated calculations or algorithms supporting trading) needs an agreement with NSE Data & Analytics; historical-data redistribution needs a licence and annual fees **[S]**. Whether the contract master files are public, and their exact terms, are **[U]** (nseindia.com timed out for research). Cost of exchange files **[U]**. No source documents public expired-contract history **[U]**.
- **Pros and cons:** (a) authoritative, field spec published, terms unverified, new BSE parser needed; (b) free and quick, broker-published so not authoritative; (c) no new integration, same limits as (b); (d) clearest licence, price unknown.
- **Technical:** canonical record exists; persistence table (migration 0044) and read API still to build; archive daily files from the day a licence is confirmed to build expired-contract history.
- **Impossible until decided:** verified contract ids, lot and tick size from an authority; exchange-verified status; sizing from the canonical record.
- **Recommended:** (a) primary with (b) as cross-check, after D0. **Reversible:** yes (append-only, versioned records).

### D3: G-30 / G-32 historical price source
- **Decision:** which provider supplies bars for outcome resolution and unexecuted-decision estimates.
- **Options:** (a) Dhan Data API; (b) Upstox expired-candles API; (c) Kite Connect (underlying and live only); (d) NSE Data & Analytics or an authorised vendor quote (audit-grade).
- **Verified facts:** Dhan Data API costs 499 INR plus taxes per month, renews every 30 days **[V]**; Dhan expired-options data covers NSE index, NSE stock, BSE index and BSE stock options **[V]** (this corrects the earlier note that BSE/SENSEX coverage was unverified); intraday 1/5/15/25/60-minute bars up to 5 years back, 90 days per call, and expired options 30 days per call with strikes only ATM +/-10 (index near expiry) or ATM +/-3 (others) **[V, earlier research of Dhan docs]**; one third-party guide says intraday minute data is only about 5 trading days, which conflicts with Dhan's own page, so confirm with a small test after approval **[conflict]**. Whether the monthly fee is waived with trades is **[U]** (a search summary said that promotion ended; the fetched page did not say). Kite Connect: expired option candles not retrievable; paid plan stated as 500 INR per month **[V, earlier research]**. Upstox: expired candles need the Plus plan **[V]**; Plus terms say it was free initially and may become chargeable **[S]**; price **[U]**. NSE Data & Analytics: price and terms **[U]**.
- **Not documented anywhere:** point-in-time ("as-of") retrieval and corporate-action adjustment; storage and redistribution rights for each broker **[U]**.
- **Pros and cons:** (a) the only verified 1-minute expired-option history, low verified price, strike window misses far out-of-the-money claims, 30/90-day windows need chunked fetch and our own frozen snapshots; (b) coverage and depth unverified; (c) cannot resolve expired claims; (d) strongest evidence if audited, cost and lead time unknown.
- **Technical:** provider interface and quality checks exist; add retrieval time and licence reference to the dataset descriptor; unify three holiday-calendar sources.
- **Impossible until decided:** any real-priced outcome, so no G-30 or G-32 evidence.
- **Recommended:** (a) with a small first run to size the strike-window limit, plus a quote request under (d) if audit-grade evidence is required. **Reversible:** yes (cancel subscription; frozen snapshots remain).

### D4: contract-verification policy for sizing
- **Decision:** may a broker-listed contract (Dhan or Upstox file) ever feed sizing, or only exchange-verified or manually verified records?
- **Options:** (a) keep the current rule: only EXCHANGE_VERIFIED or MANUAL_VERIFIED size trades; (b) allow PROVIDER_LISTED when two independent sources agree and the owner accepts the risk.
- **Pros and cons:** (a) safest, blocks sizing until D2 is done; (b) faster, accepts non-authoritative lot/tick data in a money path.
- **Technical:** (a) is implemented and tested (`isSizingEligible`); (b) needs a new policy version, a two-source agreement check and tests that a conflict always blocks.
- **Recommended:** (a). **Reversible:** yes.

### D5: M01-14 channel reliability and the archive-to-live mapping
- **Decision:** who approves mapping an archive channel label to a live channel, and on what evidence.
- **Options:** (a) owner-approved table with an automated match report (message id or time-plus-text-hash, at least 20 matches); (b) no mapping: keep archive and live separate.
- **Pros and cons:** (a) enables per-channel reliability, a wrong mapping contaminates it; (b) safe, reliability stays unavailable.
- **Data:** archives and live capture for the same window; needs D1-style access and D3 prices. **Provider:** none beyond D3.
- **Impossible until decided:** channel reliability, channel attribution of real outcomes.
- **Recommended:** (a), per channel, with your sign-off. **Reversible:** yes (append-only mapping versions).

### D6: G-42 real-backend login verification
- **Decision:** provide or approve a staging backend and two test accounts.
- **Options:** (a) HTTPS staging API reachable from the web server; (b) manual checklist through a laptop tunnel.
- **Pros and cons:** (a) proves `Secure` cookies, expiry, revocation and rate limits; (b) cheaper, no HTTPS cookie proof.
- **Technical:** `TWINS_API_URL` for the web process only; accounts created through the admin route; plan in the frontend `docs/stage09/g42-staging-verification-plan.md`.
- **Security:** credentials supplied through the operator's secret store, never logged.
- **Impossible until decided:** end-to-end proof against the real backend. **Recommended:** (a). **Reversible:** yes.

### D7: historical leakage proof on a real authorised archive
- **Decision:** which archive, and approval to import it for validation.
- **Options:** (a) the same archive and date range as D1 and D3; (b) a separate archive.
- **Pros and cons:** (a) one import, shared labelling and price work; (b) independent but duplicates effort.
- **Technical:** protocol in `HISTORICAL_LEAKAGE_VALIDATION_REPORT.md` (properties A to E over several as-of dates). **Needs** D1 access and D3 prices.
- **Impossible until decided:** proof that no real-data path leaks the future. **Recommended:** (a). **Reversible:** yes.

### D0: licence review (gates D2 and D3)
- **Decision:** who reviews the NSE and BSE data terms and each broker's API terms for internal storage and use of contract files and bars.
- **Why it matters:** NSE states non-display (algorithmic) use needs an agreement **[S]**; TWINS is a private tool, but whether that applies to it, and whether internal storage of broker data is allowed, is **[U]** and is a legal question, not an engineering one.
- **Recommended:** the owner (or counsel) reads the NSE Data Sharing and Usage Policy and Non-Display Policy and each chosen provider's terms before any subscription or archive. **Reversible:** n/a (it is a review).

## 4. Consolidated provider evaluation
| Provider | Capability needed | Confirmed [V] | Unknown [U] | Effort |
|---|---|---|---|---|
| NSE / BSE contract master files | authoritative contracts | exchange-published, field spec exists | public vs member-only, terms, cost | importer for NSE format, new BSE parser, table, API |
| Dhan | prices incl. expired options (NSE and BSE index/stock), scrip master | 499 INR + taxes per month, 30-day renewal; expired-option coverage as above; scrip master already parsed | fee waiver, storage terms, strike window effect on claims, depth conflict | provider interface, chunked fetch, frozen snapshots |
| Upstox | instrument JSON, expired candles | public instrument JSON; expired candles need Plus | Plus price and terms, intervals, option coverage | trial first |
| Kite Connect | underlying and live candles | no expired options; 500 INR per month stated | terms | adapter exists (Kite package) |
| NSE Data & Analytics / vendors | audit-grade historical | exists | price, terms, lead time | procurement |
**One provider for several needs:** Dhan can supply both D3 prices and a provider-listed contract file, so integrating Dhan once serves G-30, G-32 and a cross-check for G-38; it cannot make a contract "exchange verified". Latency is not a requirement for any of these (all are historical or daily). Integration effort for the interface, quality checks and canonical record is already built; only the provider adapters and persistence remain.

## 5. Dependency sequence
1. **Now, in parallel:** D0 (licence review), D1 (pilot data approval), D6 (staging), D4 (policy choice).
2. **After D0:** D2 and D3 (one review covers both). D3 can use the same Dhan integration for several needs.
3. **After D1 and D3:** D5 (mapping) and D7 (real-archive leakage proof).
4. **Build after approvals:** contract table and API (migration 0044) after D2; Dhan adapter and snapshots after D3; mapping records after D5.
Tasks that need nothing from you: none remain.

## 6. Owner approval register
| ID | Decision required | Recommended | Cost / commitment | Risk | Approval required | If postponed |
|---|---|---|---|---|---|---|
| D0 | licence and terms review | owner or counsel reads NSE policies and provider terms | time only | subscribing without rights | confirm who reviews and the outcome | D2 and D3 cannot start |
| D1 | pilot labelled dataset | about 300 messages, 2 to 3 channels, 90 days | reviewer time; no provider cost | privacy; sample too small for accuracy | channels, dates, annotators, storage, retention | M02-15 and D7 stay blocked |
| D2 | instrument master | NSE + BSE files, Upstox cross-check | exchange cost [U]; broker files free | terms may forbid storage; no expired history | licence acceptance, file confirmation, history need | G-38 stays open; no verified lot/tick |
| D3 | price source | Dhan Data API (+ vendor quote if audit-grade) | 499 INR + taxes per month [V] | strike window, unverified storage terms | account, subscription, token as secret, terms | G-30, G-32, D5 and D7 blocked |
| D4 | provider-listed contracts for sizing | keep exchange/manual only | none | slower verification | confirm policy | none (current rule stays) |
| D5 | archive-to-live mapping | owner-approved table with match evidence | reviewer time | wrong mapping | approver and per-channel sign-off | M01-14 stays unavailable |
| D6 | staging backend | HTTPS staging API + 2 test accounts | environment cost [U] | credential handling | provide or approve | G-42 real proof missing |
| D7 | real-archive leakage proof | same archive as D1 and D3 | import and review time | none beyond D1 | archive and date range | leakage unproven on real data |

## 7. Closure criteria (a selection or purchase is never closure)
- **M02-15 VERIFIED:** named dataset version of at least 200 labelled claims, no dataset or leakage problems, kappa reported, report reviewed, invented-value rate 0, labelled contradictions refused.
- **M01-14 VERIFIED:** mapping records with evidence per channel; attribution carries the source channel; reliability on at least 30 resolved, real-priced, out-of-sample outcomes per channel with intervals; fixtures never counted.
- **G-38 CLOSED:** approved source configured; operator import yields EXCHANGE_VERIFIED records with hash and retrieval time; table and read API with PostgreSQL integration tests; candidate verification resolves through them; unknown or conflicting contracts refused; sizing reads lot and tick from the canonical record; CI green.
- **G-30 / G-32 CLOSED:** licensed source connected; frozen hashed snapshots with retrieval times; `assessBars` GOOD or gaps reported; outcomes carry real prices and resolution times; analytics separate fixture from real; CI green.
- **G-42 VERIFIED:** the staging plan's nine checks pass against the real backend with a signed report.
- **Leakage proof:** properties A to E hold on the real archive, report signed, violations 0.
- **Stage 03 COMPLETE:** all of the above plus no open mandatory criterion.

## Corrections this review makes to earlier documents (not yet applied)
`G30_G32_PRICE_PROVIDER_DECISION.md` and `STAGE_03_DECISION_PACKAGE.md` say Dhan's price is an unverified search snippet and that BSE/SENSEX coverage is unverified. A Dhan page now verifies 499 INR plus taxes per month with a 30-day renewal, and verifies expired-option coverage for BSE index and stock options. The "waived with 25 trades" note is unverified. These two documents should be updated if you approve this draft.
