# Data providers: what is wired, what is verified, what is not

> Built 2026-11-06 (`packages/providers`, `scripts/ops/provider-exporter.ts`). **Nothing here is running on staging yet**: the exporter service is OFF (compose profile `providers`) and needs host steps and the owner's approval (section 4). The research agents do not read these files until their settings are pointed at them.

The worker deliberately has no internet access. The exporter is a separate process on its own network with the only outbound route of the data side; it reads the Kite snapshots read-only and writes ONLY the provider data files, each validated by the agents' own strict parser **before** it is published (an invalid document leaves the previous good file in place). It has no database, no Redis, no broker and no Kite credential.

## 1. Providers

| Kind | Provider | Key | File | State |
|---|---|---|---|---|
| News | GDELT DOC article list | none | `news.json` (`twins-news-v1`) | Code + tests. **One real article-list response was seen** (VPS, 2026-11-05) and matches the parser. |
| Sentiment | GDELT average-tone timeline (`timelinetone` + `timelinevolraw`) | none | `sentiment.json` | Code + tests against GDELT's documented shape. **NOT verified live**: every timeline request I made (Mac and VPS, spaced 7-10 s) was answered 429. |
| Macro | Kite snapshots (index level, previous close, open, recent closes) + FRED daily series (S&P 500, Nasdaq, Dow, Nikkei, USD/INR) | FRED: free key | `macro-context.json` | Index part runs against the real snapshot formats; **FRED part not run live (no key yet)**. |
| Economic calendar | FRED release dates (CPI, jobs, GDP, FOMC, PPI, retail sales, PCE, JOLTS) | FRED: free key | `economic-calendar.json` | Code + tests; **not run live (no key)**. FRED gives the DATE; the time of day is the usual release time (an approximation). |
| Holidays | **Owner-supplied CSV** (`date,kind,name,early_close`) | none | `holiday-calendar.json` | No reliable free machine-readable NSE source exists. The importer validates strictly; the owner supplies and confirms the dates. |
| Market data | Kite snapshots: one-day change of each subscribed INDEX | none | `market-quotes.json` | Runs against the real snapshot formats. |
| Index constituents | **Owner-supplied CSV** (`symbol,weight,sector[,recent_change_pct]`) | none | `index-constituents.json` | No free source publishes index weights; equal weights are never invented. |

### Not provided (no honest free source), so the agents keep reporting UNAVAILABLE for them
Market breadth (advancers / decliners), India VIX, per-article sentiment and impact, index-constituent weights without a file, **stock-level quotes** (the Kite feed subscribes to indices and the option window only; extending it is a separate owner-approved change that needs a live Kite run), the NSE holiday list without a file.

### What the news file does and does not claim
GDELT supplies discovery metadata only (headline, URL, domain, first-seen time). The agents' format requires sentiment, impact and category, so every article is written as the least informative honest value: `NEUTRAL`, no score, `LOW`, `unclassified`, with source reliability 0.3. Symbols are tagged by keyword matching on the headline against the watch list; an article that matches nothing is market-wide. **These items are context, never evidence of a pass.** Use them in shadow mode only until the owner decides otherwise.

### GDELT and rate limits
GDELT allows one request every 5 seconds and in practice answers 429 more often. The exporter spaces requests (5.5 s), makes at most two attempts, **stops asking GDELT for the rest of a pass after the first 429**, runs every 60 minutes at most (minimum 30), and requests sentiment for the index-level entry only by default (two requests). A 429 is reported as `fetch_rate_limited_429`, never retried in a loop. If GDELT stays unusable, the sentiment and news files simply stay absent or stale (their `as_of` shows it); nothing is guessed.

## 2. Files and freshness
Files are written atomically (temp file, flush, rename), mode 0600, into `/var/lib/twins-providers`. A document's `as_of` is the OLDEST upstream timestamp it contains (macro and quotes: the oldest index price; others: the export time), so staleness is visible to the agent. `GET /market/snapshot` lists each file with presence, `as_of`, age and item count.

## 3. Failure reporting
Every provider run ends as `published`, `skipped` or `failed`, with a FIXED reason (`key_missing`, `snapshot_incomplete`, `no_fresh_index`, `provider_rate_limited`, `fetch_http_error_<status>`, `fetch_timeout`, `response_invalid`, `refused_validation`, `csv_invalid`, `file_not_configured`, `no_data`). No message, URL or key is ever logged.

## 4. Activation (each step needs the owner's go-ahead; none has been done)
1. Create the host directory `/var/lib/twins-providers` (mode 0700, uid 1000). The API and the exporter mount it; the API read-only.
2. **Install the egress allow-list for the network `twins_providers_egress`** (10.0.29.0/24, verified free on the host): **BUILT 2026-11-06 (owner-approved), NOT INSTALLED.** `twins-providers-egress.sh` is the Kite mechanism (D-087 / D-091) with the two provider hosts: a hostname-pinned address set (30 s refresh, 10-minute expiry, public unicast IPv4 only), ONE chain (replies, tcp/443 to the set, LOG, final DROP) and ONE jump from DOCKER-USER inserted last (no fail-open window), a start-up `status` check, a staleness alert (`providers.egress_stale`), and full rollback (`remove`). `twins-providers-start.sh` is the only supported way to start the exporter: it refuses unless `status` passes. 13 dry-run tests cover it. To install (needs the owner's go-ahead because it changes the host firewall): copy the two scripts to `/opt/twins-staging/` (0755) and the three `twins-providers-egress*.service|timer` units to `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now twins-providers-egress twins-providers-egress-refresh.timer`, and check `twins-providers-egress.sh status` and the Kite one still reporting OK. **Live caveat:** both hosts sit behind CDNs that can rotate addresses; after installing, run one exporter pass and read the DROP log (`journalctl -k | grep twins-providers-egress-drop`) to confirm nothing legitimate is dropped. If address pinning proves brittle, a hostname-filtering proxy is the alternative. **The exporter must not be started before this is in place** (`twins-providers-start.sh` enforces it).
3. FRED: the owner creates a free key at fred.stlouisfed.org and puts `TWINS_FRED_API_KEY=...` in the host-only `providers.env` (never in chat, never in the repository). Without it calendar and global macro are skipped; everything else still runs.
4. Optional files: `TWINS_HOLIDAYS_CSV` (+ `TWINS_HOLIDAYS_MARKET/FROM/TO`), `TWINS_CONSTITUENTS_CSV` (+ `TWINS_CONSTITUENTS_INDEX`).
5. First a single pass (the egress allow-list must be installed): `docker compose ... --profile providers run --rm provider-exporter run` and read the report; check `/market/snapshot`.
6. Then the loop (start it only with `/opt/twins-staging/twins-providers-start.sh`), and only then, as a separate owner decision, point the worker at the files: mount `/var/lib/twins-providers` read-only into the worker and set `TWINS_AGENT_NEWS_PROVIDER`, `TWINS_AGENT_SENTIMENT_PROVIDER`, `TWINS_AGENT_MACRO_PROVIDER`, `TWINS_AGENT_ECONOMIC_CALENDAR`, `TWINS_AGENT_HOLIDAY_CALENDAR`, `TWINS_AGENT_MARKET_DATA_PROVIDER`, `TWINS_AGENT_CONSTITUENT_PROVIDER` to `file:/var/lib/twins-providers/<file>`. Shadow mode only.
7. Rollback at any step: stop the exporter, unset the settings, recreate the worker. Nothing to undo in the database.
