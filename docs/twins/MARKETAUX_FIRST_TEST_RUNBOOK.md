# Marketaux: first permitted live test (runbook)

Status: **not started, blocked.** Nothing in this runbook may be run until Gate 0 is satisfied. See D-109 and PROVIDERS.md ("Alternative news source: Marketaux").

## Gate 0 (all required, owner)

1. Marketaux's **written permission** (reply to the owner's contact-form message) or API terms that clearly cover: automated hourly requests for personal research, storing headlines / URLs / timestamps / entity scores, derived per-symbol aggregates, a private dashboard, paper trading now and personal live trading later. If the reply asks for a paid or commercial plan, stop and decide.
2. The owner's explicit go-ahead to make the first live request.
3. For the host steps (phase 3 on): the owner's **separate** firewall go-ahead, and PR #97 merged and deployed (each its own approval).

## Phase 1: shape check from the Mac (one request, no host change, no firewall change)

The Mac is not behind the staging allow-list, so this needs only Gate 0 items 1 and 2. The key is in `~/.twins-marketaux-key` (mode 600, outside the repository).

```
node --import tsx scripts/ops/marketaux-shape-check.ts --key-file ~/.twins-marketaux-key --permission-confirmed
```

Optional: add `--universe-csv <constituents csv>` once per file to see which stocks the adapter would keep. The script makes **one** request (host pinned to `api.marketaux.com`, one attempt), refuses to run without `--permission-confirmed`, reads the key from the file (never an argument or the environment) and prints a shape report: field names and types, counts, ranges. It prints no headline, URL, snippet or key. Save the output (it is safe to keep) as the evidence for D-110.

### What to read in the report, and what to change if it is wrong

| Check | Expected | If not |
|---|---|---|
| `ok` | true, `requests: 1` | HTTP 401/402/429: stop, do not retry in a loop; the error code is printed without the URL |
| `checks.dataIsList`, `articleKeyTypes` | `data` is a list; articles carry `uuid`, `title`, `url`, `source`, `published_at`, `entities` | the adapter refuses the answer (`adapterDryRun.refused`): fix the field names in `marketaux.ts` first |
| `checks.everyArticleHasEntities` | true (`must_have_entities`) | the parameter name is wrong or ignored: the adapter still drops untagged articles, but fix the request |
| `checks.sortedNewestFirst` | true (`sort=published_at`, `sort_order=desc`) | the sort parameter is wrong: the newest articles may be missing from the first two pages; fix before enabling |
| `checks.allWithinWindow` | true (`published_after`) | the filter is ignored: the adapter drops stale items (`stale` count) but wastes the 3-article page; fix |
| `checks.everyPublishedAtHasOffset` | true | the adapter refuses offset-less times (by design); decide with the owner |
| `scoresNumeric` / `scoresMissing` / `scoresOutOfRange` | mostly numeric, 0 out of range | out-of-range means the scale is not -1..+1: stop and re-read the provider's documentation |
| `countriesAllIndia` | true or "no country field" | `countries=in` is not filtering entities: expect more `unmapped` |
| `symbolPatterns`, `symbolsSeen` | `.NS`, `.BO`, `index (known)` | an unexpected suffix (for example `.NSE`): extend `mapEntitySymbol` deliberately; nothing unknown is kept silently |
| `adapterDryRun` | `kept` > 0 over time; `unmapped`, `noScore`, `stale` explain the rest | a high `unmapped` share is normal (only the universe is kept) |

Record the findings in the decision log (D-110), correct any wrong parameter in code (a new PR with its own test), and only then continue.

## Phase 2: store the key on the host (after Gate 0 item 3 for the firewall; the helper itself changes only a file)

1. Install the updated helper on the host (it now accepts a provider name): copy `infrastructure/staging/twins-set-provider-key.sh` to `/opt/twins-staging/` (0750 root), keeping the previous copy.
2. From the Mac, the key goes over standard input from the key file; it never appears in a command line, a log or this chat:
   `ssh hostinger-vps /opt/twins-staging/twins-set-provider-key.sh marketaux < ~/.twins-marketaux-key`
   It prints only non-secret facts (key length, file mode 600, owner root, number of other lines kept). The FRED line and every other line stay.
3. Check `providers.env` still has mode 600, owner root, and that `TWINS_FRED_API_KEY` is present (count only).

## Phase 3: firewall (separate approval)

Add `api.marketaux.com` (tcp/443 only, exporter network only) to `HOSTS` in `twins-providers-egress.sh` and the service description; run the existing egress tests; install with the existing procedure (see PROVIDERS.md section 5); `twins-providers-egress.sh status` and the Kite one must still report OK. Resolved addresses on 2026-11-06 were Cloudflare (`172.67.135.159`, `104.21.26.76`); the 30-second refresh and 10-minute expiry cover rotation. Rollback: remove the name and re-run, or `remove`.

## Phase 4: enable and verify (after the merge and deploy of PR #97, each with its own go-ahead)

1. Add `TWINS_NEWS_SOURCE=marketaux` to `providers.env` (other lines untouched; keep a backup copy).
2. One manual pass, GDELT untouched because the source switch replaces it: `... run news sentiment`. Expect `news` and `sentiment` published, or a fixed failure reason (`rate_limited`, `quota_exhausted`, `response_invalid`).
3. Verify `news.json`: `source` is `marketaux`; every item has exactly one symbol, one market, a score in -1..+1, `impact` LOW, `category` unclassified, reliability 0.4, and no snippet. Verify `sentiment.json`: `source` is `marketaux-derived-entity-mean`, every `sample_size` equals the number of that entity's items, no entry for an entity without a scored item.
4. Check the firewall drop log: nothing dropped for `api.marketaux.com`.
5. Count requests: a pass uses at most 2 (the free plan allows 100 a day); the hourly loop uses about 48 a day.
6. Then the worker: add `TWINS_AGENT_NEWS_PROVIDER` and `TWINS_AGENT_SENTIMENT_PROVIDER` (`file:/var/lib/twins-providers/news.json`, `.../sentiment.json`) in compose (a PR, like D-108). Shadow only.

## Rollback

Remove `TWINS_NEWS_SOURCE` from `providers.env` (the exporter reverts to GDELT, which keeps failing harmlessly); remove the two worker settings; the firewall name can stay or be removed. Delete `news.json` / `sentiment.json` if they should not be read.

## Stop conditions

Any 401, 402 or 429 on the first request; a score outside -1..+1; Marketaux asking for a commercial plan; the owner's instruction. Never loop on a failure.
