# Monday 2026-11-09 runbook: Kite login and feed run, shadow flag, functional deploy, capture export

Written 2026-11-07 for the owner's sequence. **Nothing here has been run.** Commands use the compose invocation already used for every deploy. Secrets are never printed, never typed into chat, and never passed as arguments: the Kite request token is typed by the owner at a hidden prompt on the host.

```
cd /opt/twins-staging/infrastructure/staging
C="docker compose -p twins-staging --env-file staging.env -f docker-compose.staging.yml"
```

## A. 08:30-09:00 IST before the login
1. The token-check timer fires at 08:30 IST and raises the CRITICAL "token not usable" alert. Expected; it is the reminder.
2. `/opt/twins-staging/twins-kite-preflight.sh` (read-only). Proceed only with **0 FAIL**. WARNs for an expired token and stale macro/quotes are expected.

## B. 09:00 IST login (owner at the browser; the request token never leaves the owner's terminal)
1. `$C --profile ops run --rm -T kite-login url </dev/null` prints the login URL (the API key is not a secret). Open it, log in, copy `request_token` from the redirect address.
2. **Owner, at an interactive host terminal:** `$C --profile ops run --rm kite-login exchange` and type the token at the hidden prompt (ONE live `POST /session/token`; stores the 0600 token file). I never see the token. (This corrects my earlier wording: the token is not sent to me.)
3. `$C --profile ops run --rm -T kite-login verify </dev/null` (ONE live read-only `GET /user/profile`). A rejection removes the token and stops the sequence.
4. `$C --profile kite run --rm -T kite-ticker node --import tsx /app/scripts/ops/kite-ticker.ts check-config </dev/null` (offline, redacted).

## C. Feed start (inside 08:55-15:40 IST)
`/opt/twins-staging/twins-kite-feed-start.sh` (refuses unless the egress allow-list is applied, filled and fresh). Watch `docker logs -f twins-staging-kite-ticker-1` for: instruments prepared, daily candles, subscription, no `auth_failed`, no reconnect storm.

## D. Feed verification (all must hold before the flag)
* `/market/sources` (via the API) shows macro and quotes **not STALE**; macro and quotes files rewritten after the exporter's next pass (up to 60 min) or after a manual single pass if you approve one.
* api, worker, alert-relay: 0 errors in the last 10 minutes; egress drops 0 (`journalctl -k --since "30 min ago" | grep -c twins-kite-egress-drop`).
* Safety flags unchanged (preflight section 5 passes): LIVE false, paper false, enforcing unset, shadow true.
* If anything fails: stop the feed (`$C --profile kite stop kite-ticker`), leave the flag OFF, report.

## E. Shadow flag ON
Only after D is clean: in `staging.env` set `TWINS_REDUCE_ONLY_SHADOW=true` (backup copy first), then `$C up -d --no-deps worker`. Verify: worker starts without a configuration error; `risk_sizing.shadow.*` lines appear only when a decision is SIZED (expected to be none until trust tiers and contracts exist); 0 errors. Rollback: set it back to `false` and restart the worker.

## F. Functional deploy (main at that time: #110, #111, #114, #115, #118 (read-only Telegram routes) and #119 (pure), plus the neutral #112, #113, #116, #117, #122; plus #120 (migration 0032, approved 2026-11-07); #121 (Dhan) is CLOSED and not included)
Same recipe as Deploys 17-19: tarball and SHA-256 manifest, `MANIFEST_MATCH`, derived build script, `twins-backup` (verified), edit `TWINS_IMAGE_TAG` (keep a `.before-main-<sha8>` copy), rolling `up -d --no-deps` of alert-relay, api, worker, then checks and a `deployments.jsonl` line. Extra steps for this deploy:
1. Copy the repo compose file over the host one (keep a `.before` copy); `$C config -q`.
2. **Set the premium default source (owner-confirmed 2026-11-07: the channel ending 2544, 109 of 126 claims).** The identifier is computed on the host and never printed: select it from `telegram_sources` where it ends in `2544`, require exactly one row, and write `TWINS_SOURCE_DEFAULT_LEVEL_BASIS=<identifier>=premium` into `staging.env`. Verified read-only on 2026-11-07: the identifier matches the setting's allowed characters and has no display name (so the exporter's channel label equals the identifier).
3. After the roll: worker starts (a malformed value would stop it at start-up); parser version in new intake is `telegram-regex-v3`; result adverts create no claim; 0 errors.
4. Exporter container is not rebuilt unless exporter code changed (it did not).

## G. Capture export, profile, dry run (no import)
Create a private folder: `install -d -m 0700 -o 1000 -g 1000 /opt/twins-staging/exports`. Run the tools in one-off containers from the new image with the output folder mounted (the container root is read-only; only `/exports` is writable). The premium default is passed from the container's own environment, never typed:
1. `$C run --rm -T --no-deps -v /opt/twins-staging/exports:/exports worker node --import tsx /app/scripts/ops/capture-export.ts --out /exports/capture-20261109.jsonl </dev/null` (read-only SELECTs; counts only). Expect about 124 originals minus result reports, 2 edits attached.
2. `... worker sh -c 'node --import tsx /app/scripts/ops/archive-profile.ts /exports/capture-20261109.jsonl --label capture-1 --default-market NSE --level-basis-default "$TWINS_SOURCE_DEFAULT_LEVEL_BASIS"'`.
3. `... historical-import dry-run` the same way (read-only database access; **first confirm the worker's database role can read the historical tables**, which has not been checked).
4. Report the counts, the verifiable share and the dry-run manifest hash. **No import without your separate go-ahead.** The export file contains message text: keep it on the host, mode 0600, never in a repository.
If the one-off container method fails (read-only root, role permissions, network), stop and report; do not improvise outside these steps.

## H. Report
Feed run result, verification table, flag state, deploy record, source default applied, export / profile / dry-run numbers, anything unexpected.

## Not part of Monday
Marketaux (waiting for the reply), Dhan, Stage 6, paper trading, any import, any order, the Phase 2 backend routes.

## Added 2026-11-07 (batch 7)
* After the deploy, check the two new read-only routes with the API key read inside the container (never printed): `GET /telegram/channels` and `GET /telegram/claims?limit=5` return 200 with masked channels and no message text; without the token they return 401.
* twins-frontend #7 and #8 are already merged; the Channels and decision-card pages need the SSH tunnel to be viewed against the live API.
* If you approve #120 (migration 0032) it adds a migration step to the deploy (take the usual backup first, apply, verify the table exists and the count of migrations is 33) and only then may `TWINS_SHADOW_PERSIST=true` be set.

## Migration step for this deploy (#120, migration 0032; owner-approved 2026-11-07)
Order, following Deploy 11 (D-101): (1) `twins-backup` verified; (2) image built and checked as for every deploy; (3) **stop api and worker** (alert-relay may stay up); (4) update `TWINS_IMAGE_TAG` and the compose file (keep the `.before` copies); (5) `$C --profile migrate run --rm migrate` (log: migrations applied); (6) `verify-migrations` in the new image against staging: it must report **33** migrations (the count comes from the repository journal); (7) re-apply `app-role.sql` and `approval-bot-role.sql` as the database owner (the runtime role gets SELECT and INSERT only on `shadow_observations`, because the table's trigger name ends in `_no_update_delete`); (8) audit chain verification still passes (the new table is not chained, so the chain count stays 32); (9) start alert-relay, api, worker; (10) V-checks. If any of 5-8 fails: do not start api or worker; follow the rollback plan (restore the verified backup) and report.
Extra V-checks: the table exists and is empty; `used_for_decisions` cannot be true, UPDATE / DELETE / TRUNCATE are rejected (rolled-back probes as the owner); as the runtime role: SELECT and INSERT work in a rolled-back probe, UPDATE and DELETE are denied; row counts of the live tables (risk_decisions, risk_approvals, orders, fills, positions, paper_trades) are unchanged by the migration; `TWINS_SHADOW_PERSIST` is `false` in the worker (compose default) after the deploy.
**Only after those pass and you say go:** set `TWINS_SHADOW_PERSIST=true` in `staging.env`, restart the worker, and confirm a shadow row appears when a decision is SIZED (none is expected until trust tiers exist; the agent-engine shadow also writes a row per assessed decision) with 0 errors. Rollback of the flag: set it back to `false` and restart the worker.
