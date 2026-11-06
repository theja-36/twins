# Kite token refresh and feed run: preparation (nothing run, no Kite call made)

**Docs only.** Written 2026-11-06 after the owner raised this to top priority. Host facts below were read-only (file listings, variable NAMES, firewall rules); no secret value was read or printed and nothing was started.

## What is already in place on staging
| Piece | State (2026-11-06 ~20:25 UTC) |
|---|---|
| Plan | Connect plan bought 2026-11-04 (D-090); `TWINS_KITE_PLAN=connect` in the host-only `kite.env` |
| `kite.env` | exists, 0600-style host file, contains `TWINS_KITE_API_KEY`, `TWINS_KITE_API_SECRET`, `TWINS_KITE_PLAN` (names only checked) |
| Host dirs | `/var/lib/twins-kite` and `/var/lib/twins-snapshots` exist, mode 0700 |
| Egress | network `twins_kite_egress`, chain `TWINS-KITE-EGRESS` (443 to the `twins_kite_dst` set only, everything else dropped and logged), ipset has 4 entries, `twins-kite-egress-refresh.timer` active every 30 s |
| Token | `kite-token.json` dated 2026-11-05 05:26 UTC: **expired** (tokens lapse about 06:00 IST daily). This is why macro `as_of` is stale |
| Token-check timer | `twins-kite-token-check.timer` is **not** listed as installed, so a missed morning login raises no alert yet |

## What is missing
1. Today's login: a human step in your browser (Kite does not allow a headless login), about one minute.
2. The feed run itself (`kite-ticker`, compose profile `kite`), started by you at market open under supervision.
3. Optional: install the token-check timer so a missed login alerts.

## Steps when you give the go (each live call is one the code makes, none beyond these)
1. Me: confirm egress works (`twins-kite-egress` status, ipset resolves `api.kite.trade` and `ws.kite.trade`). No Kite request.
2. You: `kite-login url` output opened in your browser, log in, copy the `request_token` from the redirect URL.
3. You or me via stdin, never as an argument or in chat: `kite-login exchange` (ONE live `POST /session/token`, stores the token 0600), then `kite-login verify` (ONE live `GET /user/profile`, read-only).
4. `kite-ticker check-config` (offline). Then, during 08:55-15:40 IST on a trading day: start the feed with the `kite` profile. It makes one instruments request, one daily-candle request per index underlying, and a websocket subscription. It writes snapshots only; the engine stays off.
5. Check: macro and quotes `as_of` freshen, `/market/sources` shows no STALE, errors and egress drops stay at 0, no order path exists (the client has no write method and refuses every write path).
6. Stop the feed when finished (it runs only inside the market window anyway).

## Cadence reality
The token lasts to about 06:00 IST next day, so every trading morning needs the same one-minute login. If you want the feed daily this is a standing chore; the token-check alert exists to remind you.

## What a Kite refresh unlocks (the new priority order)
* Fresh macro and quotes (the stale `as_of`).
* Historical bars for outcome evaluation: the historical client exists. Built now: `buildBarsDataset` (pure) converts fetched candles into the `twins-historical-bars-v1` files the evaluator loads.
* #4 options risk quotes. Kite has no IV or greeks (see OPTIONS_DATA_SOURCE_PREP.md), so option quotes would carry premium, bid/ask, OI and volume with IV/greeks null; the agent then degrades to CAUTION on those dimensions rather than passing.

## Needs from the owner
Your go for the live run (step 2 onward), the day and time, and whether to install the token-check timer.

## Scheduled (owner decision 2026-11-06)
* **Kite login and supervised feed run: Monday 2026-11-09, 09:00 IST.** Owner does the browser login; I supervise the feed run (egress check first, then verify, check-config, feed start, checks in step 5).
* **Token-check timer installed** (weekdays 08:30 IST). Note: it fires at 08:30 IST, before the 09:00 login, so on Monday it will raise the CRITICAL "token not usable" alert as a reminder; that alert is expected and not a fault. A dry run (alert disabled) confirmed it reports `token_expired` for the current token.
* Feed window is 08:55-15:40 IST; 09:00 is inside it.

## Preflight script (installed 2026-11-07)
`/opt/twins-staging/twins-kite-preflight.sh` (source: `infrastructure/staging/twins-kite-preflight.sh`) is a read-only go/no-go checklist for the morning of the run. It makes no network request, reads no secret value (kite.env variable names and the plan only; the token file's timestamp only), starts nothing, and always exits 0. It prints PASS / WARN / FAIL per check and a summary: clock and feed window, egress allow-list, token file age, kite.env contents by name, safety flags inside the running api and worker (must be LIVE false, paper false, enforcing unset, shadow true), services up, feed not already running, provider file freshness, memory and disk. A FAIL means do not start the feed; WARNs such as an expired token are expected before the login. Test: `tests/unit/infrastructure/kitePreflight.test.ts`.

First run (Friday night): 12 PASS, 5 WARN (weekend, outside window, token expired, macro and quotes not rewritten), 0 FAIL.

**Explained finding:** the exporter has been SKIPPING macro and market-quotes since 19:13 UTC with reason `no_fresh_index`, i.e. it refuses to republish while the Kite-fed index values are stale. That is the safe behaviour (it will not present old numbers as fresh) and it clears after the feed has run.
