# T3m - Market-hours observation of the signal channel (runbook; prepared 2026-10-24, NOT started)

`<REAL_CHANNEL_ID>` is a placeholder; the id lives only in the host's `staging.env` allowlist (together with the test channel). Read-only throughout: the client cannot post, edit, delete, join or mark anything as read. LIVE_TRADING stays false.

## Window
Indian equity-options hours are 09:15-15:30 IST = 03:45-10:00 UTC (pre-open from 03:30 UTC). Plan: start about 03:30 UTC Monday, run through the close (about 10:00 UTC), stop by about 10:15 UTC (about 6.75 h). The NSE holiday calendar was NOT checked here: on a trading holiday the channel will simply be quiet.

## Start (host, as root; only on the owner's explicit "go")
1. Preconditions (all verified on 2026-10-24 and re-checked at start): capture container not running; `/opt/twins-staging/capture-egress-firewall.sh status /opt/twins-staging/telegram-cidr-ipv4.txt` prints OK; `twins-backup --status` OK and fresh (the daily backup runs about 02:34 UTC); `check-config` prints `capture.config_ok count=2`.
2. `cd /opt/twins-staging/infrastructure/staging && docker compose -f docker-compose.staging.yml --env-file staging.env --profile capture up -d --no-deps capture` (recreates the container from the tag in `staging.env`, restart `unless-stopped`).
3. Watcher: `START_EPOCH=$(date +%s) DURATION=26100 ALERT_LOG=/opt/twins-staging/logs/capture-alerts.log nohup /opt/twins-staging/capture-watch.sh >> /opt/twins-staging/logs/capture-watch-monday.log 2>&1 &`
4. Expect within seconds: `capture.library_verified`, `connectionStateReady`, `capture.started` with `count: 2`; no `capture.alert`, no `egress_unrestricted`.

## While running (stop conditions: stop capture, keep logs, report)
Any `capture.alert` (flood_wait, login_required/session_ended, protected_content, not_a_member, ingest_*, egress_unrestricted); capture exit or restart; `capture.queue_overflow`; `capture.delivery_retry` for more than 5 minutes; any API 5xx or OOM kill; a database row for a chat other than the two allowed ones; message text in any log. Delivered messages are verified read-only with the evidence queries (ids, counts, flags, hash comparisons - never text). Non-options posts are delivered to the worker and declined by the options-only gate (no row); options-style posts become never-approvable claims.

## Stop
`docker compose -f docker-compose.staging.yml --env-file staging.env --profile capture stop capture` -> expect exit 0, `capture.closed`, and that `unless-stopped` does not revive it. Then the final evidence queries and the leak check. The allowlist is not changed by this procedure.

## Alerting (honest limits)
The watcher streams events and appends alerts/anomalies/state changes to `/opt/twins-staging/logs/capture-alerts.log`; the operator's assistant session monitors it and pushes a notification. There is no independent always-on alert yet (that needs the approval bot or the Uptime Kuma monitors, both owner-side setup). Under `unless-stopped` a crash restarts the container automatically; a fatal condition alerts, closes TDLib and holds 15 minutes before exiting, so a restart loop contacts Telegram at most about once per 15 minutes and never logs in by itself.
