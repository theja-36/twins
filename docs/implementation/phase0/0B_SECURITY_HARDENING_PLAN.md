# Phase 0B - Security hardening plan (PLAN ONLY; nothing in this document has been executed)

Evidence labels: [V] verified read-only on 2026-10-22; [I] inference; [A] assumption to confirm. Every change below needs its own explicit approval; each lists a rollback. Host changes affect a SHARED host (other tenants: users `orangeslice`, `orangeslice-review`, `agentops`; about 80 other containers) - the host owner must agree before 1, 2 and 3.

## 1. Disable password SSH, keep key access
**Cause [V]:** `/etc/ssh/sshd_config.d/50-cloud-init.conf` sets `PasswordAuthentication yes` and sorts BEFORE `60-cloudimg-settings.conf` (`no`). sshd keeps the first value, so passwords are enabled. Also `PermitRootLogin yes`, `MaxAuthTries 6`, `X11Forwarding yes`, `KbdInteractiveAuthentication no`. Three ed25519 keys are authorised for root (fingerprints `SHA256:MhrM0k...`, `SHA256:+jdGWh...`, `SHA256:8+EP6f...`). fail2ban/crowdsec are not running. Only 1 failed login appeared in the last 24 h [V].
**Pre-checks (read-only):** (a) you confirm which of the 3 key fingerprints are yours/expected; (b) `last -n 30` to see whether any other user logs in with a password (`agentops` accepted the password method when I tried [V], so a password may exist); (c) confirm out-of-band access (Hostinger hPanel browser console) works [A]; (d) a second terminal stays logged in during the change.
**Change (one file, sorted first so it wins):** `/etc/ssh/sshd_config.d/00-twins-hardening.conf`
```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
```
**Apply:** `sshd -t` (must print nothing) -> `sshd -T | grep -E 'passwordauthentication|permitrootlogin'` shows `no` / `without-password` -> `systemctl reload ssh` (not restart; existing sessions survive).
**Verify:** new key login works; `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password root@host` is refused; other tenants' key logins still work.
**Rollback:** delete the drop-in, `systemctl reload ssh` (or use the console). `PermitRootLogin` is tightened to `no` only after step 2 is verified.
Optional (separate approval): `ufw limit 22/tcp` (rate-limit instead of plain allow) or install fail2ban.

## 2. Least-privilege non-root deployment user
Do NOT put the user in the `docker` group (docker access is root-equivalent) and do not reuse `agentops` (purpose unknown [V]).
- **User:** `twins-deploy`, no password, shell bash, home `/home/twins-deploy`, a NEW ed25519 key generated on your Mac (private key never leaves it). `authorized_keys` entry prefixed with `restrict`.
- **Single privileged entry point:** `/usr/local/sbin/twins-deploy` (root:root 0755, reviewed, `set -euo pipefail`, no `eval`, no shell interpolation of arguments). Sudoers (`/etc/sudoers.d/twins-deploy`, validated with `visudo -cf`): `twins-deploy ALL=(root) NOPASSWD: /usr/local/sbin/twins-deploy`.
- **Verbs it accepts (fixed list):** `status`, `ps`, `logs api|worker [--since N]`, `health`, `stage-source <tarball>` (verifies the bundled manifest with `sha256sum -c`, extracts to a NEW `/opt/twins-staging/src-<tag>`; refuses to overwrite), `recreate api worker --tag <tag>` (tag must match `^[a-z0-9][a-z0-9._-]{0,63}$` and the image must already exist locally; runs only `up -d --no-deps --no-build --pull never` for project `twins-staging`), `backup-now`.
- It cannot: edit firewall/SSH, touch other tenants' containers, read `staging.env`, pull or build.
- **Verify:** `sudo -l` shows only the wrapper; each verb with bad arguments is refused; `docker ps` as the user fails.
- **Rollback:** `userdel -r twins-deploy`; remove the sudoers file and the wrapper.
- **Then:** set `PermitRootLogin no` (second drop-in change), after you confirm deploys work as `twins-deploy`.
Limit: the wrapper is root-run code and must be independently reviewed (same standard as F1).

## 3. Ollama
**Facts [V]:** `ollama.service` (user `ollama`) runs with `OLLAMA_HOST=0.0.0.0:11434`, one model (`qwen2.5-coder:3b`); no live connections now; no container environment mentions it; no consumer lines in the last 24 h of its journal; blocked from the internet by INPUT DROP (external probe closed, IPv4); reachable from the Docker bridges (`ufw allow from 10.0.0.0/16`, a broad rule needed for Traefik -> host services). TWINS does not use it. Ollama has no built-in authentication.
**Recommended (A):** bind to loopback. systemd drop-in `/etc/systemd/system/ollama.service.d/override.conf` with `[Service]` / `Environment="OLLAMA_HOST=127.0.0.1:11434"`; `systemctl daemon-reload && systemctl restart ollama`. Observe 24-48 h first (`ss -tnp | grep 11434`, journal) and ask the host owner who uses it; anything on the host reaching it via 127.0.0.1 keeps working; anything via the public IP or bridge IP breaks.
**If a container consumer exists (B):** bind to that one network's gateway address and add a UFW rule limited to that subnet; the broad `10.0.0.0/16` allow cannot be removed without breaking Traefik.
**Authentication (C):** only needed if remote use is wanted: keep the loopback bind and publish through an authenticated reverse proxy (long random token + IP allowlist). Not recommended now.
**Rollback:** delete the override, `daemon-reload`, `restart`. Brief interruption of the service only.

## 4. Static bearer token (`TWINS_API_KEY`) rotation
**Consumers:** `staging.env` (canonical), the API container (restart needed), the read-only viewer (you type it per request, never stored), any curl/scripts you keep, protected backups of `staging.env` (old values). Not used by the worker.
**Procedure (about 10 s of API unavailability):** (1) confirm the queue is idle; (2) back up `staging.env` (unique name, root, 0600); (3) generate a new 48-hex value on the server with `openssl rand -hex 24` into a file, never printed; (4) replace only the `TWINS_API_KEY=` line; (5) `up -d --no-deps --no-build --pull never api`; (6) verify new -> 200, old -> 401, none -> 401, `/health` 200, no error logs; (7) store the new value in your password manager. **Rollback:** do not restore the old value; if the new one fails, generate another.
**Cadence/triggers:** every 90 days, on suspected exposure, or when a person with access leaves.
**Code improvement (later phase, needs build approval):** accept `TWINS_API_KEY` and `TWINS_API_KEY_PREVIOUS` during an overlap window, log a short hash prefix of the token used (never the token), separate read-only and admin tokens when more routes exist.

## 5. Dependency scanning
[V] CI has no audit step; the image sets `NPM_CONFIG_AUDIT=false`; the lockfile has 424 packages, all from `registry.npmjs.org`, 6 with install scripts (esbuild x4, msgpackr-extract, fsevents).
1. **CI gate (on every push):** `npm ci` then `npm audit --omit=dev --audit-level=high` (fails on high/critical). Contacts the npm registry.
2. **Lockfile advisory scan:** OSV-Scanner on `package-lock.json` (Google OSV database).
3. **Image scan before each deploy:** Trivy or Grype on `twins-staging:<tag>` (OS packages + Node deps), results archived next to the build log.
4. **Updates:** Dependabot/Renovate weekly PRs once a private remote exists; security updates auto-opened.
5. **Install scripts:** evaluate `npm ci --ignore-scripts` plus an explicit allowlist for esbuild/msgpackr in the rehearsal environment; adopt only if tests stay green.
6. **SBOM:** `npm sbom --sbom-format cyclonedx` stored per release; base image stays digest-pinned.
7. **Policy:** exploitable high/critical -> fix within 7 days or document an accepted risk; moderate -> next release.
**First run (needs approval because it contacts external services):** `npm audit --omit=dev --json` and one image scan; report only, no automatic fixes.

## 6. Reduce `jobs.error` retention without losing debugging value
**Facts [V/R]:** `runIngestionJob` stores the full `error.message` in `jobs.error` and in `provider_health.last_error_message`, and stores the entire job payload (`jobs.payload` = job data, including the message `rawText` and `rawPayload`). BullMQ keeps failed reasons; no `removeOnFail`/`removeOnComplete` is set.
**Plan:**
1. A tested `safeErrorSummary(err)` returns `{class, code, truncated message <= 200 chars}` with connection strings, URLs with credentials, bearer/hex tokens, emails and quoted values redacted. Written to `jobs.error` (and the provider-health message) in the form `[Class:CODE] summary`, with the correlation id kept in the job record.
2. Full detail (stack, original message) goes only to the structured log with the same correlation id; Docker `json-file` rotation (3 x 10 MB) bounds it. Increase to 5 x 20 MB if 30 days of debugging history is wanted.
3. Minimise `jobs.payload` to `{jobType, channelIdentifier, externalMessageId, correlationId}`; the raw text already lives in the immutable `telegram_messages`.
4. Retention job (scheduled SQL, own approval): set `jobs.error` and `jobs.payload` to NULL for rows older than 30 days (rows themselves are kept).
5. BullMQ: `removeOnComplete {age: 86400, count: 1000}`, `removeOnFail {age: 604800}` so failed reasons expire.
No migration needed for 1-2 (text format); 3-4 touch behaviour, not schema; structured `error_class/error_code` columns would be a later migration.
**Tests:** unit redaction fixtures (connection URL, bearer, 48-hex secret, email, 5 KB message), length bound, idempotent; integration: a forced failure leaves no secret in `jobs`, `provider_health` or the queue. **Rollback:** code revert; existing rows unchanged. **Risk:** less detail in the database -> mitigated by correlation id and log retention.
