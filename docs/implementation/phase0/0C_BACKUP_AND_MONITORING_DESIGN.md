# Phase 0C - Backup and monitoring design (DESIGN ONLY; no schedule, upload or monitor has been created)

Backups remain paused. Evidence: [V] verified 2026-10-22; [I] inference.

## 1. Current state [V]
- Scripts exist and were drilled on 2026-10-21: `backup-postgres.sh --yes` (custom-format dump + sha256, run via `docker compose exec`), `restore-check-postgres.sh --yes` (restores only into scratch DB `twins_restore_check`), `/opt/twins-staging/offsite/twinsenc.py` (AES-256-GCM, whole-file, key from a 0600 hex file in `/root/twins-offsite-keys/`, header `TWINSENC1`, refuses to overwrite).
- Host has `gpg`, `openssl`, `python3` (+ `cryptography`), `zstd`, `jq`; it does NOT have `age`, `rclone`, `restic`, `borg`, or `pg_dump` on the host (pg_dump runs inside the postgres container) [V].
- The existing "off-site" directory is on the same server. Nothing is off-host. No TWINS timer exists (only the OS dpkg timer).
- Data: DB 9 MB today (test data) -> trivial now; size will grow with the archive (Phase 1) and market data (Phase 2).

## 2. Daily encrypted PostgreSQL backup
**Mechanism:** a root systemd service + timer (not cron), `twins-backup.timer` at 02:30 UTC daily, `Persistent=true`, `RandomizedDelaySec=300`. The service runs `/usr/local/sbin/twins-backup` (root:root 0750) which:
1. refuses to run if another backup holds the lock (`flock`) or disk free < 5 GB;
2. `pg_dump -Fc` inside the postgres container (as the existing script does) -> `/opt/twins-staging/backups/twins-staging-<UTC>.dump`, mode 0600;
3. writes `.sha256`; 4. encrypts with the existing AES-256-GCM tool -> `.dump.enc` (+ `.sha256`);
5. **verifies before declaring success:** decrypt to a temp file, compare sha256 with the plain dump, `pg_restore --list` (inside a container) succeeds, plain temp files shredded/removed;
6. uploads the encrypted file off-host (section 4), verifies the remote size/checksum;
7. writes a status file `/var/lib/twins-monitor/backup.json` and, only on full success, pings the Uptime Kuma push monitor (section 5);
8. applies retention only after success.
Limit: the current tool reads the whole file into memory; fine up to a few hundred MB. Beyond that switch to a streaming format (e.g. `age`, needs installation) - a design decision at Phase 1/2 sizing.
**Key custody:** the AES key lives in `/root/twins-offsite-keys/` on the same host as the data; a host compromise exposes both. Mitigation: you keep an offline copy of the key (password manager or printed) - without it Drive backups are unreadable. Decision needed; the key must never be uploaded next to the backups.
**Targets:** RPO 24 h, RTO about 1 h at current size.

## 3. Retention and restore tests
- **Local (on host):** keep 7 daily encrypted dumps + the latest plain dump only until verification passes.
- **Off-host:** 7 daily, 4 weekly (Sunday), 6 monthly (first of month). Pruning is destructive -> enabled only after a separate approval, with a dry-run listing first and a floor of "never delete the newest 3".
- **Weekly automated restore test (host, local copy):** decrypt latest -> restore into `twins_restore_check` -> compare table row counts and migration count (7) with the live DB, plus the existing 54-line checkpoint comparison -> drop the scratch DB -> push result to a Kuma push monitor.
- **Monthly full drill from the OFF-HOST copy:** download, decrypt with the offline key copy, restore into a throwaway database, compare checkpoint; record results in `docs/implementation/`. This proves the off-host copy and the key are usable.
- **After any schema migration:** one extra backup before and verify restore of the migrated backup.

## 4. Off-host destination: Google Drive
Options and my assessment (you have Drive storage; capacity not verified):
| Option | How | Credentials on the server | Verdict |
|---|---|---|---|
| **A (recommended)** | `rclone` with its own OAuth client limited to scope `drive.file`, uploads ONLY already-encrypted files into one dedicated folder | an OAuth refresh token for that app, in `/root/.config/rclone/rclone.conf` (0600), usable only for files this app created (not the rest of your Drive) | best balance: automated, least-privilege, ciphertext only |
| B | Pull model: your Mac fetches the encrypted files over SSH (launchd/cron or manual) and you place them in Drive via the Drive app | none on the server | safest for credentials; depends on the Mac being on; manual unless scheduled |
| C | Service account to Drive | key file with broad API identity | not suitable for a personal Drive (no storage quota unless a Shared Drive/Workspace) |
| D | Using this assistant's Google Drive connector | n/a | not appropriate: it is a chat connector, not a backup channel, and it would route backup data through a third-party session |
Design points for A: client-side encryption first (Drive only ever sees `TWINSENC1` blobs and sha256 files); a dedicated folder; Google Cloud project + OAuth consent screen in "testing" mode owned by you (token may expire after 7 days in testing mode unless the app is set to production/internal - to be verified at setup [I]); `rclone` single static binary installed after verifying its published checksum; token generated on your Mac with `rclone authorize` and copied to the server (no browser on the server); revoke at any time from your Google account security page. Residual risk: whoever steals the token can delete the files this app created -> keep the monthly copy also pulled to your Mac (option B) and rely on Drive's 30-day trash.
**Approvals needed (in order):** (1) you create the Google Cloud project/OAuth client and choose the folder; (2) approve installing `rclone` (download + checksum verification); (3) approve placing the token file; (4) approve a first upload test with a harmless encrypted dummy file; (5) approve the first real upload; (6) approve the timer; (7) approve retention pruning.

## 5. Monitoring with the existing Uptime Kuma (no new tool)
**Existing [V]:** `monitoring-uptime-kuma-1` (`louislam/uptime-kuma:1`, healthy, 3 days), listening on `127.0.0.1:3004` of the host, on network `monitoring_monitoring`, data volume only (no Docker socket, so Kuma cannot inspect containers). I did not look inside it (no credentials): existing monitors and notification channels are unknown. Kuma v1 has no official REST API, so monitors are created in its UI (by you) from the table below; I only prepare the host-side checker.
**Host checker:** `twins-monitor.service` + timer every 60 s, root, one script that performs the checks below and calls the matching Kuma **push URL** (`http://127.0.0.1:3004/api/push/<token>?status=up|down&msg=...`) - local, no firewall change. Push tokens are kept in `/etc/twins-monitor/tokens` (0600). State in `/var/lib/twins-monitor/`.
| Alert | Check | Monitor type / threshold |
|---|---|---|
| API down | public `https://twins.theja.tech/health`, keyword `"status":"ok"` AND `"liveTradingEnabled":false`; plus local `127.0.0.1:4110/health` in the host checker | Kuma HTTP(s)-keyword, 60 s, 2 retries; cert-expiry alert (14 days) |
| Worker down | container running and its start time unchanged AND the BullMQ stalled-check key exists in Redis (set by the worker's stalled checker; observed with a TTL on 2026-10-21 [V]; confirm before relying on it [I]) | Push, 60 s, down after 3 misses |
| PostgreSQL / Redis down | container Health = healthy; `pg_isready` and authenticated `redis-cli ping` inside the containers | Push, 60 s |
| Backup failure | backup script pings ONLY after a verified success; a missing heartbeat is the alert (dead-man switch) | Push, heartbeat 26 h, retries 0 |
| Restore-test failure | weekly test pings on success | Push, heartbeat 8 days |
| Stale market data | `max(observed_at)` of `market_observations` older than the expected cadence per instrument | **Prepared but disabled** until Phase 2 (table is empty today; enabling now would only create false alarms) |
| Telegram ingestion failure | BullMQ `signal_queue:failed` count > 0 or `jobs.status='failed'` in the last 15 min; later also `webhook.intake.rejected` spikes from logs | Push, 60 s. A quiet channel is NOT an error; "no message in N hours" is not alerted. Registration health (`getWebhookInfo`) needs the bot token, which is deliberately not on the server - owner-side check |
| Unexpected restart / OOM | per container: `RestartCount`, `State.StartedAt`, `OOMKilled` compared with the last recorded state; changes without a deploy marker file written by the approved deploy command -> alert; kernel OOM lines in `journalctl -k` | Push, 60 s |
| Disk / memory | root fs > 85%, MemAvailable < 1.5 GiB | Push |
| Queue health | waiting jobs > 100 or oldest waiting job > 10 min | Push |
**Notifications:** reuse whatever channel your Kuma already uses (I will not create or connect any Telegram bot for TWINS in Phase 0). Please tell me which channel it is and test it yourself.
**Rollback:** disable/remove the timer and the Kuma monitors; no data is modified by the checker (read-only checks plus push calls).
**Approvals needed:** (1) you create the monitors and give me the push tokens through a root-only file you place or I generate-and-you-copy; (2) approve installing the checker script and timer; (3) a controlled failure test (e.g. stop sending a heartbeat) agreed in advance - I will not stop services.

## 8. As built: local daily encrypted backup is SCHEDULED (2026-10-24) - backups are no longer "paused"
Done (host, owner-approved "resume scheduled backups now that real signal data is stored"): `/usr/local/sbin/twins-backup` (root:root 0750; repo copy `infrastructure/staging/twins-backup.sh`), `twins-backup.service` (oneshot, after Docker) and `twins-backup.timer` (daily 02:30 UTC, `Persistent=true`, `RandomizedDelaySec=300`; enabled and active; first scheduled run Sunday 2026-10-25 about 02:34Z). Each run: lock, free-space check (>= 5 GiB), `pg_dump -Fc` inside the Postgres container, plaintext sha256, AES-256-GCM encryption with the existing `twinsenc.py` and key, then VERIFICATION (decrypt, compare with the plaintext hash, `pg_restore --list` must show the message and migration tables) before the plaintext is removed; only then it prunes THIS job's own `twins-staging-daily-*.dump.enc` files beyond the newest 7 (never below 3; manual `pre-*` dumps and everything else are never touched) and writes `/var/lib/twins-monitor/backup.json` (`twins-backup --status` exits 0 only for a successful run younger than 26 h). Any failed step removes plaintext and partial files and writes a failed status (a handler bug that skipped this was found by the tests and fixed before deployment).
Proof on 2026-10-24: one backup through the service path (111,912 bytes encrypted, 210 TOC entries); then an independent restore: decrypt -> plaintext hash equals the recorded one -> `pg_restore` into a fresh scratch database exit 0 -> table counts, a fingerprint of every column of every message and event row, both append-only triggers and the 32 real-channel rows all equal to the live database; scratch database dropped, temporary plaintext shredded.
NOT done (needs the owner): (1) the OFF-HOST copy (Drive/OAuth, section 4) - until then every copy is on the same server, so a lost host loses the data AND the backups; (2) Uptime Kuma push monitors (section 5) - there is no alert if a run fails or does not happen, only the status file and the journal; (3) the weekly automated restore test and the monthly off-host drill (section 3); (4) the owner's OFFLINE copy of the encryption key (`/root/twins-offsite-keys/`): without it the encrypted backups are unreadable if the key file is lost. The scratch database name `twins_restore_check` is disposable by design (it is dropped and recreated by the restore checks).
