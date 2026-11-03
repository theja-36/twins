# Operational alerting, scheduled verification and recovery readiness - Stage 2 / Task 5

> Decision [D-053](DECISION_LOG.md); requirements [XC-04](REQUIREMENTS_TRACEABILITY.md) (observability, incident response), XC-03, XC-11, XC-12, TG-12. Deployment evidence: [STAGING_DEPLOYMENT_VERIFICATION.md](STAGING_DEPLOYMENT_VERIFICATION.md) §9. Related: [OFF_HOST_BACKUP_AND_RECOVERY.md](OFF_HOST_BACKUP_AND_RECOVERY.md), [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md).

## 1. Design
Alert delivery is a **generic JSON webhook** (no notification mechanism was configured; the Telegram approval bot is deliberately not reused). Two senders implement the same payload contract:
* **Application containers** (api, worker, migrate, safety-control, audit-verify, …) live on an internal network with no internet and **never see the webhook**. They post to the **`alert-relay`** compose service (internal network, no published port, bearer token `TWINS_ALERT_RELAY_TOKEN`), which alone holds `TWINS_ALERT_WEBHOOK_URL` / `_SECRET` and alone has an egress network (`twins_alert_egress`, 10.0.27.0/24). The relay re-validates and re-sanitises every payload (a compromised service cannot inject free text or secrets), rate-limits (30/min; CRITICAL is never dropped) and forwards with an optional HMAC-SHA256 signature (`x-twins-signature: sha256=<hex>` over the body).
* **Host jobs** (backup, local backup verification, health check, systemd `OnFailure`) use `twins-alert.sh` (bash + curl + python3 for the HMAC) with `/etc/twins-alerts/alert.env` (root 0600). The URL is read from that file, passed to curl through a descriptor (never argv), and never printed.
No public alert endpoint exists. If no destination is configured, every alert is **logged as undelivered** (`alert.undelivered`) so a missing destination is visible, never silent. The webhook URL is a credential (these URLs embed tokens): it lives only in `staging.env` (relay only) and `alert.env`, both root 0600, and in the GitHub secret `TWINS_ALERT_WEBHOOK_URL` for the two GitHub-side alerts.

### 1a. Telegram alert destination (follow-up, 2026-10-29)
The relay can deliver to **Telegram** in addition to (or instead of) the webhook. It uses the **existing approval-bot token**, copied on the host from `bot.env` into `staging.env` as `TWINS_ALERT_TELEGRAM_BOT_TOKEN` (0600; the bot's other settings are not exposed to the relay), and a **dedicated operational alert chat** whose numeric id is stored only as `TWINS_ALERT_TELEGRAM_CHAT_ID` in `staging.env`. The token and the chat id are never committed, never logged and never in a status file or error (the sender label is the constant `telegram`; the resolver prints only the last 4 digits). The approval bot itself is untouched (`TWINS_BOT_ACTIVE` stays false); the alert path only calls `sendMessage`.
* **Format:** concise plain text (no `parse_mode`, so nothing is interpreted as markup): `<icon> SEVERITY event` / `env | service | build` / `time` / `code` / summary / optional correlation id and ≤ 6 allow-listed details (≤ 1000 characters). Built only from the sanitised payload, so no secrets, tokens, keys, message text or user data.
* **Retries:** transient failures (network, timeout, 5xx, 429 honouring `retry_after`) are retried up to 4 times with exponential backoff and jitter; a permanent 4xx (wrong chat, bot removed/blocked, bad token) is not retried.
* **CRITICAL is never dropped silently:** if no destination accepts it, the relay logs `relay.undelivered_critical` at error level, counts it (`undeliveredCritical`), keeps it and retries (30 s doubling to 5 min) for 2 hours; if it is finally abandoned it logs `relay.critical_dropped` (error) and counts `droppedCritical`. The relay status (counters, last results per destination, no ids) is written to `/var/lib/twins-monitor/alert-relay/alert-relay.json` (`ok:false` while anything is pending or dropped) and is served at `GET /v1/status` (relay token); the host health check raises a CRITICAL `alert.undelivered_critical` reminder from it.
* **Chat setup (owner, once):** create a Telegram group (or channel) for TWINS operational alerts, add the approval bot to it (admin for a channel), send any message there, then on the host run `twins-telegram-resolve-chat.sh --env-file staging.env --bot-env bot.env --title "<part of the chat title>"` (reads `getUpdates` once; writes only the numeric id; refuses to guess when there is not exactly one match) and `compose up -d alert-relay`.
* **Test alert:** `docker compose … --profile ops run --rm --entrypoint node safety-control --import tsx /app/scripts/ops/alert-test.ts [--severity INFO|WARNING|CRITICAL]` sends `alert.test` ("TEST ALERT - no action required") through the real application → relay → destinations path and prints the per-destination result (exit 0 delivered, 1 failed, 2 no destination).
* **Tests:** `tests/integration/alerting/telegram.test.ts` against a mocked Telegram Bot API (format and content, redaction, secrecy of token/chat id, retries and `retry_after`, permanent failures, relay end to end, undelivered/pending/dropped CRITICAL, status, fan-out, test command, chat resolver).

## 2. Payload contract (v1)
```json
{"v":1,"event":"outbox.dead_lettered","severity":"CRITICAL","environment":"staging","service":"worker",
 "timestamp":"2026-10-29T14:47:12.423Z","build":"task5-5683e412","correlationId":"corr_…","code":"INGESTION_FAILED",
 "summary":"An intake message could not be processed and was dead-lettered; operator action required.","details":{"outboxId":"…","attempt":8}}
```
Always present: `event`, `severity` (INFO | WARNING | CRITICAL), `environment`, `service`, `timestamp`, `build` (commit SHA or image tag, `unknown` if not available), `code` (safe machine code), `summary` (fixed template). `correlationId` when the source record has one. `details` is built from an **allow-list** of keys only (`name step failure count attempt maxAttempts outboxId channelId messageType control version previousValue newValue changedBy chain rows ageSeconds bytes sha256 reason action unit kind restarts windowSeconds oldestAgeSeconds firstFailure`).
**Redaction rules** (enforced in TypeScript and, independently, in `twins-alert.sh`): any other key is dropped (message text, payloads, tokens, passwords, stacks, file paths can never travel); any VALUE that looks like a secret is replaced by `[redacted]` even under an allowed key (age/private keys, URLs with credentials, bearer tokens, `password=`/`token=` assignments, Telegram bot tokens, AWS keys, 48+ character opaque strings); `sha256` and `outboxId` must match their exact formats; summaries are printable ASCII ≤ 240 characters from fixed templates; the shell sender rejects (and sends nothing for) arguments with quotes/control characters or secret shapes. Error messages are never included: only fixed codes.

## 3. Severity policy (what raises what)
| Severity | Event | Raised by |
|---|---|---|
| CRITICAL | `backup.failed` (any step) | offhost-backup CLI; legacy `twins-backup.service` via OnFailure |
| CRITICAL | `backup.checksum_mismatch` | off-host post-upload check; weekly local verification (`twins-backup-verify.sh`) |
| CRITICAL | `backup.upload_failed` | off-host upload / re-download check |
| CRITICAL | `backup.verification_failed`, `backup.restore_drill_failed` | weekly verify (local/off-host); monthly drill |
| CRITICAL | `audit.verification_failed` (chain broken/altered/tail deleted/anchor mismatch) | `audit-verify` CLI |
| CRITICAL | `audit.protection_failed` (guard trigger or DDL watch missing) | `audit-verify` CLI |
| CRITICAL | `audit.verification_unavailable` (verifier could not run) | `audit-verify` CLI |
| CRITICAL | `outbox.dead_lettered` | worker, on the dead-letter transition |
| CRITICAL | `outbox.stuck` (rows due > 15 min, or PROCESSING > 3 leases, after a recovery pass) | worker reconciler |
| CRITICAL | `safety.kill_switch_activated`, `safety.trading_enabled` | `safety-control` (the control change itself) |
| CRITICAL | `runtime_state.unavailable` (fail-closed) | any process that cannot read the controls |
| CRITICAL | `process.restart_loop` (3rd start of api/worker within 10 min) | api, worker (Redis start counter) |
| CRITICAL | `migration.failed` | migrate entry point |
| CRITICAL | `job.failed` / `*.failed` for a failed scheduled unit | systemd `OnFailure` |
| WARNING | `backup.delayed` (no successful backup for > 30 h / never) | host health check |
| WARNING | `audit.verification_delayed` (no PASS for > 3 h) | host health check |
| WARNING | `outbox.retry_threshold` (attempt ≥ max-2) | worker |
| WARNING | `outbox.stale_job_recovered` (expired lease reclaimed) | worker reconciler |
| WARNING | `safety.intake_disabled` | `safety-control` |
| WARNING | `ci.failed` (hosted CI failed on main) | `ci-failure-alert.yml` |
| INFO | `safety.kill_switch_cleared`, `alert.test` | `safety-control`, `alert-test` (INFO is delivered only if `TWINS_ALERT_MIN_SEVERITY=INFO`; `alert.test` is always delivered) |
Identical alerts are throttled (10 min in-process, 6 h for the host health reminders, 5 min for OnFailure) and the next one reports `suppressedSinceLast`. `TWINS_ALERT_MIN_SEVERITY` (default WARNING) sets the delivery threshold. **Not raised:** an exit 81/82 at start-up (the process dies before alerting; the restart-loop counter also needs Redis); a crashed container that Docker does not restart (needs a host watcher, not installed).

## 4. Scheduled verification
| Job | Where | Schedule (UTC) | Alert on failure | Status |
|---|---|---|---|---|
| Daily encrypted backup (existing local process, verified decrypt) | VPS `twins-backup.timer` (+ drop-in `OnFailure`) | 02:30 daily | CRITICAL | **installed** |
| Hourly audit-chain verification `--require-ddl-watch --anchor-file --status-file` + health check | VPS `twins-audit-verify.timer` | hourly | CRITICAL (CLI) + reminders (health check) | **installed** |
| Weekly backup checksum verification (all retained local backups + decrypt of the newest) | VPS `twins-backup-verify.timer` | Sundays 04:30 | CRITICAL | **installed** |
| Monthly restore drill (cross-host, GitHub-hosted runner, synthetic `drill` backups only) | `.github/workflows/offhost-drill.yml` `schedule` | 2nd of month 05:00 | CRITICAL (if the webhook secret exists) | active once merged to `main` (schedules run from the default branch) |
| Off-host daily upload, weekly off-host re-checksum | `twins-offhost-backup.timer`, `twins-offhost-verify.timer` | 03:15 daily / Sun 04:00 | CRITICAL | **prepared, NOT installed**: need the production age recipient and R2 credentials (owner) and Node 22 on the host |
| Restore drill on a recovery host | `twins-offhost-drill.timer` | 2nd 05:00 | CRITICAL | prepared for the recovery host only; never on the VPS (needs the private key) |
All schedules are systemd timers / a cron line and are changed with `systemctl edit <timer>` (drop-in) or by editing the workflow. The real staging data is **not** restored by any scheduled job. Each job writes a status file in `/var/lib/twins-monitor` (`backup.json`, `audit/audit-verify.json`, `backup-verify.json`, …) with `ok`, `epoch` and, for the audit and backup statuses, `last_ok_epoch`.

## 5. Status surface
`GET /health/status` (**requires the API key**; `/health` stays minimal and unauthenticated): `status` (ok/degraded), `uptimeSeconds`, `database {ok, latencyMs | code}`, `redis {ok, latencyMs | code}`, `runtimeState {available, TRADING_ENABLED, INTAKE_ENABLED, KILL_SWITCH_ACTIVE}` (when unreadable: `available:false` and the fail-closed values), `outbox {available, pending (PENDING+FAILED), processing, deadLetter, completed}`, `lastSuccessfulBackupAt`, `lastSuccessfulAuditVerificationAt` (the last PASS even if a later run failed). Fixed codes only: no stacks, paths, credentials or message content (tested). The two timestamps come from a minimal export (`ok/epoch/last_ok_epoch`) written by the host health check into `/var/lib/twins-monitor/export`, the only directory mounted (read-only) into the API container.

## 6. Dead-letter operations
`docker compose … --profile ops run --rm outbox-deadletter <command>` (owner credential; no HTTP):
* `list [--limit N]` and `show <id>`: **safe metadata only** (id, channel id, message type, source, attempts, last error code, timestamps, replays recorded). Never payload, text or author.
* `replay --id <one id> --reason "<8-500 chars>" --changed-by operator:<name>`: one row only. In one transaction it inserts a row into the append-only `telegram_intake_outbox_replays` log (who, why, previous attempts/error), writes a chained `audit_events` row `outbox.replayed`, and reopens the row (DEAD_LETTER → PENDING, attempts 0). The database allows that single transition **only** in the same transaction as the replay record (migration 0013); the runtime role cannot insert replay records, so only this owner-run command can. No bulk/all/filter option exists; unknown flags are refused (exit 2). A replayed row goes through the normal reconciler and pipeline, which is idempotent downstream.
Runbook: on `outbox.dead_lettered` → `list` → `show <id>` → investigate the error code and the journal/worker log by correlation id → fix the cause → `replay` that id with a reason → watch `/health/status` (`deadLetter` back to its previous count) and the audit chain.

## 7. Recovery procedures (what to do when an alert fires)
| Alert | First actions |
|---|---|
| `backup.failed` / `upload_failed` | `journalctl -u twins-backup.service`; check disk space and the status file; the artifact is kept in `spool/pending` and retried; run the unit manually after fixing |
| `backup.checksum_mismatch` | treat as corruption: do not delete anything; run `twins-backup-verify.sh` and compare the file with the off-host copy; restore tests from an older backup (OFF_HOST_BACKUP_AND_RECOVERY.md §11) |
| `audit.verification_failed` / `protection_failed` | engage the kill switch (`safety-control set KILL_SWITCH_ACTIVE true …`), preserve the database and the anchor, run `audit:verify` to read the first failure (chain, index, code); never regenerate hashes; restore from the last verified backup if tampering is confirmed |
| `outbox.dead_lettered` / `outbox.stuck` | §6; for `stuck` check the worker is running and Redis is reachable (`/health/status`), then the reconciler log |
| `safety.kill_switch_activated` | confirm it was intended (`safety-control events`); clear only with a reason after the cause is resolved |
| `safety.trading_enabled` | must never happen before the LIVE Gate: verify the change in `system_control_events`; switch it off immediately if unintended |
| `runtime_state.unavailable` | database down or role/grants broken; processes are failing closed (nothing is lost: intake is refused with 503 and retried by senders) |
| `process.restart_loop` | `docker logs` of the service, `docker inspect … RestartCount`; roll back with STAGING_DEPLOYMENT_VERIFICATION.md §7 if the last deploy caused it |
| `migration.failed` | do not start the new services; restore the pre-deploy backup if the schema is half-applied (rollback level 2) |
| `ci.failed` | open the failed run; main is not deployable until fixed |

## 8. Operations quick reference
* Test the delivery path: `TWINS_ALERT_ENV_FILE=/etc/twins-alerts/alert.env /usr/local/sbin/twins-alert.sh --test alert.test INFO twins-host test_event "TEST ALERT - no action required"` (exit 0 delivered, 1 failed, 2 not configured). Application side: `scripts/ops/alert-test.ts`.
* Configure the destination: set `TWINS_ALERT_WEBHOOK_URL` (+ optional `_SECRET`) in `staging.env` and recreate the relay (`compose up -d alert-relay`), and in `/etc/twins-alerts/alert.env` for host jobs. Create a repository secret `TWINS_ALERT_WEBHOOK_URL` (+ `_SECRET`) for the GitHub-side alerts.
* Receivers should verify `x-twins-signature` and treat `event`/`severity` as the routing keys.

## 9. Limits
No alert destination is configured yet (alerts are logged as undelivered until the owner supplies one); one webhook only (no escalation, paging or acknowledgement); alert delivery is best effort (relay unavailable ⇒ undelivered, logged); the alert relay and the status export depend on the host timers; start-up failures (81/82) and a stopped Docker daemon cannot alert; the off-host timers are prepared but not installed; the monthly drill restores synthetic data, not staging data.

## Capture-gap check (host job, D-083)
`infrastructure/staging/twins-capture-gap-check.sh` (installed as `/usr/local/sbin/twins-capture-gap-check`, run every 10 minutes by `twins-capture-gap-check.timer`) raises the existing rule `telegram.capture.gap` -> CRITICAL `telegram.capture_gap` through `twins-alert.sh` and the loopback relay. It is read-only (`docker inspect`, one `SELECT max(received_at)`), exits 0 always, writes `/var/lib/twins-monitor/capture-gap.json` (0600), throttles alerts to one per 6 hours and sends only `ageSeconds`, `windowSeconds` and `reason`.
* **`client_not_running`** (the failure that really happened: the capture client sat stopped 2026-10-24 to 2026-10-31 unnoticed): the capture container is not `running` (exited, dead, created, restarting or missing) for longer than the grace period (`TWINS_CAPTURE_GAP_DOWN_GRACE_SECONDS`, default 900). "Down since" lives in `capture-gap.state`, so a restart is not an alert.
* **`no_capture_in_window`** (a slow safety net): the newest `user_capture` outbox row is older than `TWINS_CAPTURE_GAP_WINDOW_SECONDS` (default 14 days). The channel is quiet by nature (a 9-day silence occurred in October), so tune this to the real cadence in a systemd drop-in; an unreadable database never raises a gap.
Install (host, root): copy the script to `/usr/local/sbin/twins-capture-gap-check` (0750) and the two units to `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now twins-capture-gap-check.timer`. Not part of any image; no service restart.

## Alert delivery evidence (2026-11-03)
`twins-alert.sh` exits successfully when the relay answers **202 accepted**; the relay then delivers to Telegram asynchronously and retries a CRITICAL alert. So "alert.sent" in the host journal proves acceptance, not delivery. The relay container log is the delivery record and is lost whenever the container is recreated (json-file logging). Consequence recorded for the two backup-failure alerts of 2026-11-02 02:31 and 2026-11-03 02:33 UTC: both were accepted by the relay (`alert.sent`, CRITICAL `backup.failed`), but their Telegram delivery cannot be proven from retained logs; the owner confirms by the chat history. Open improvement: send the relay's log to the journal so delivery records survive a recreate.
