# Design: Telegram news feed (read-only route and UI) - APPROVED 2026-11-07

**Design only. No code, no migration, no live call.** Decisions of 2026-11-07: raw message text is never exposed by the API or the UI; only structured fields (symbols, themes, polarity, cluster id, timestamp); read-only route with the same API-key auth; no live calls until Marketaux permission and the owner's go-ahead; channel-only evidence is capped at CAUTION. Builds on the merged pure modules (`packages/agents/src/channelNews.ts`, `newsImpact.ts`; design in [PHASE3_NEWS_SOURCE_COMBO.md](PHASE3_NEWS_SOURCE_COMBO.md)). Engine off, shadow ON, `LIVE_TRADING` false, paper OFF, no orders, no Stage 6.

## 1. Where the text is read (the main decision)
The extractor must read message text once. The API process should never do that. Options:

| | A. Worker job writes a file, API reads the file | B. New table filled by the worker, API reads the table | C. API extracts on request |
|---|---|---|---|
| Text read by | worker (already reads text at intake) | worker | API (**rejected**: puts raw text in the API process) |
| Storage | `channel-news.json` (`twins-channel-news-v1`) in the read-only provider mount, written atomically | `telegram_news_items` (migration, append-only) | none |
| Migration | none | yes (own approval) | none |
| History | latest window only | durable | none |
| Matches existing pattern | yes (exporter files, strict reader, source health) | like `shadow_observations` | no |

**Recommendation: A.** No schema change, the API stays text-free by construction, and it reuses the strict reader and the source-health profile. If durable history is wanted later (calibration needs it), add B behind its own approval.

## 2. Pipeline (option A)
1. A worker-side job (no schedule of its own; it runs after each processed Telegram message, or hourly in the exporter loop) selects messages from the last 48 h that are not signals or result reports (the parser already classifies them: `none`).
2. `extractChannelNews` produces items. Symbols are matched against the instrument reference, never free text; themes come from the fixed vocabulary; polarity from the fixed word list. Skipped messages are counted by reason, never stored.
3. `dedupeChannelNews` (30 min) then `clusterChannelNews` (2 h buckets). Caps: at most 500 items per file and 50 per symbol.
4. `buildChannelNewsFile` writes the file atomically (temp file and rename) into the provider folder. The file holds ids, masked channel labels, times, symbols, themes, polarity, reliability. **No text, no sentence fragment, no message id from Telegram** (the item id is a hash of the internal id).
5. Failure leaves the previous file in place and the source-health profile marks it stale by age; an unreadable file is UNKNOWN, never "no news".

## 3. Read-only route
`GET /news/telegram?symbol=&limit=` (same API key as the other routes, GET only, 401 without, POST 404, OpenAPI entry, frontend proxy allow-list entry).

Response (allow-list of fields, no free text):
```
{ asOf, ageSeconds, status: "ok" | "stale" | "missing" | "invalid",
  items: [{ id, publishedAt, channel (masked), symbols[], themes[], polarity (-1..1), reliability, duplicates }],
  clusters: [{ clusterId, symbol, theme, bucketStart, items, channels, polarity, mixed }],
  skipped: { signal_or_claim, result_report, empty, no_symbols_or_themes } }
```
`clusterId` is a stable hash of (symbol, theme, bucketStart). A missing or invalid file returns `status` with empty lists and a reason code, not an error and not zeros.

## 4. Combined impact (shadow only)
`combinedNewsImpact` runs in the news agent in SHADOW, with API news absent until Marketaux is permitted: with no API items the corroboration is CHANNEL_ONLY, which is **capped at CAUTION** (the code already enforces this; a test pins it). It can lower confidence or raise a caution flag; it never raises size or removes a block. Good news recommends nothing. Wiring the agent is a separate step after review and is logged, not acted on.

## 5. UI
The Market page News panel stops showing SAMPLE data when the route returns `ok`: a list of clusters (symbol, theme chips, a polarity bar, item count, channels count, MIXED badge) and a line "commentary from channels you capture; low reliability; never a signal". `stale`, `missing` and `invalid` render as such, never as "no news". Rows show masked channels only. Sample data stays only when the route is absent (404).

## 6. Safety rules and tests (to build after approval)
* A test that the API package imports no Telegram message table and that the route handler reads only the file (static check, like the shadow-isolation tests).
* A leak test: build a file from messages containing a distinctive sentence and assert no substring of any message appears in the file, the route output or the UI fixture.
* Injection test: messages containing instructions ("ignore previous", URLs, prompt-like text) produce only fixed-vocabulary fields.
* The writer cannot touch any table other than reading `telegram_messages`; the folder is writable only by the worker; the API mount stays read-only.
* Channel-only cap pinned; result reports and signals never become news.

## 7. Gates
Owner review of this document; owner decision on the theme vocabulary and the polarity word list (both are in `channelNews.ts` today); option A or B; the route and UI are read-only and auto-approvable once reviewed, the agent wiring stays shadow. No external call is involved at any step; Marketaux activation is separate and still waiting for its reply.

## 8. Open questions
1. A or B (is durable history needed for calibration now)?
2. Writer cadence: after each message, or hourly with the exporter?
3. Should the Dashboard show a one-line summary, or only the Market page?

## 9. Owner decisions (2026-11-07) and build plan
Decided: **option A, file only, no migration**; writer **hourly with the exporter** (batch, not per message); Market page shows the full panel (items and clusters); **Dashboard shows a one-line summary** (for example "3 clusters, 2 mixed, CAUTION"); the theme vocabulary and polarity word list are approved as they stand in `channelNews.ts` (revisit later if needed).

Build plan (each step its own PR, read-only or pure, no live call, nothing deployed before the next deploy window):
1. **Writer:** `scripts/ops/channel-news-export.ts` plus a pure `selectNewsCandidates`; reads `telegram_messages` with the worker role, writes `channel-news.json` atomically into the provider folder; runs from the exporter loop once per hour. Counts only in its log line. Tests: leak, injection, caps, atomic write, previous file kept on failure.
2. **Reader and route:** strict file reader in the API (no database access), `GET /news/telegram`, OpenAPI entry, proxy allow-list. Tests: 200 with key, 401 without, POST 404, static check that the route and its module import no Telegram table, status codes for missing / stale / invalid.
3. **Summary:** a pure `summarizeChannelNews` (cluster count, mixed count, capped recommendation word) used by the route (`summary` field) and the Dashboard line. CAUTION-cap test pinned here.
4. **Frontend:** full Market panel (replaces the SAMPLE News panel when the route answers; SAMPLE stays on 404) and the Dashboard one-liner.
5. **Shadow wiring of the news agent** is NOT part of this build; separate step after review.
