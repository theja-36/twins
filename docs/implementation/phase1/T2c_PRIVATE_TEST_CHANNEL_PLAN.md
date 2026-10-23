# T2c - Private test channel setup and bounded capture test (PLAN ONLY; nothing here has been executed; every step needs the approval listed in section 9)

Placeholders: `<TEST_CHANNEL_ID>` (the owner's private test channel, the `-100...` form) and `<M1>`, `<M2>` (server message ids of the test posts). The real channel id lives ONLY in the VPS `staging.env`; it is never written into the repository, docs or examples.
Owner-provided reference: the channel already contains one message with id 2 (written before capture). Live capture never reads history, so message 2 must NOT appear in the database; seeing it would mean something read history and is a stop condition.

## 1. Allowlist change (one variable, three consumers)
`TWINS_TELEGRAM_ALLOWED_CHAT_IDS` is a single variable in `staging.env` that the compose file passes to the **api**, the **worker** and the **capture** client (all use `${TWINS_TELEGRAM_ALLOWED_CHAT_IDS:-}`). Today the line is absent (= empty = nothing approved).
Change: append exactly one line to `staging.env` (mode 0600, after a hashed backup): `TWINS_TELEGRAM_ALLOWED_CHAT_IDS=<TEST_CHANNEL_ID>`. One id, no list, no name, no wildcard. The capture client (1-5 numeric `-100...` ids), the API and the worker (canonical integers) all validate it at start-up and refuse to start on a malformed value. `TWINS_TELEGRAM_OPTIONS_ONLY` stays the literal `"true"` in compose.
Consequence of options-only (important for the test): a post that is not an options-style message is **not stored at all**. Test posts must therefore be options-style (section 7); a plain "hello" is the deliberate negative case.

## 2. Containers that must be recreated for the change to take effect
Environment is fixed when a container is created, so:
| Container | Recreate? | Why |
|---|---|---|
| api | yes | reads the allowlist at start; the internal route's chat gate needs it |
| worker | yes | enforces the allowlist again on every job |
| capture | yes (re-`create`, never started before) | its created container holds the OLD empty environment; use `create --force-recreate` |
| postgres, redis | no | untouched |
Order: backup -> edit `staging.env` -> recreate api and worker (`up -d --no-deps --force-recreate --pull never api worker`) -> `--profile capture create --force-recreate capture`. The one-off login container (section 5) is created fresh from the same service definition, so it also sees the new environment.

## 3. Egress for the capture container
Today capture sits only on `twins_data`, which is `internal: true` (no route out), so it cannot reach Telegram. Proposed compose change (separate approval; shown for review):
```
  capture:
    networks: [twins_data, twins_egress]
networks:
  twins_egress:                 # ordinary outbound (NAT) for the capture client ONLY
    ipam:
      config:
        - subnet: 10.0.24.0/24  # free on the host (existing bridges use 10.0.0.0/24 .. 10.0.23.0/24); verify again at deploy time
```
Scope and honesty about what this is:
- **This is ordinary outbound connectivity, NOT a Telegram-only restriction.** A container on a normal Docker bridge can open connections to any internet host and port through the host's NAT. This change alone does **not** limit it to Telegram.
- What does limit it today, in depth but not by the network: the client code contains no network code except the configured internal ingest URL (validated as an internal host) and TDLib itself (static tests enforce this); the container is non-root, has all capabilities dropped, a read-only root filesystem, no published ports (no inbound), `no-new-privileges`, and `restart: "no"`.
- `twins_data` has no gateway, so the default route goes via `twins_egress`; the API stays reachable by its container name on `twins_data`. IPv4 only (the network has no IPv6).
- **Telegram-only enforcement** would need host firewall rules (a separate, explicitly approved firewall change, which the previous tasks forbade): in the `DOCKER-USER` chain, accept traffic from `10.0.24.0/24` only to Telegram's published datacenter ranges on the ports TDLib uses (443, and possibly 80/5222), accept established/related replies, allow DNS only if shown to be needed, and DROP everything else from that subnet; rules must persist across reboot and must not disturb Coolify/Traefik/other tenants. The CIDR list must be taken from Telegram's official `https://core.telegram.org/resources/cidr.txt` at approval time; I have **not** fetched or verified it here and will not claim enforcement until those rules exist and are tested (a negative test: the container cannot reach an arbitrary host). Whether TDLib needs any non-Telegram destination (for example a DNS-over-HTTPS fallback when direct connections fail) is **unverified**.
- Recommendation: do the test with the ordinary egress network (the risk is bounded by the container hardening above and a 30-minute window), and decide on the firewall rules before any capture of the real channel.

## 4. Owner-only credential entry (the assistant never sees these)
Run in YOUR OWN SSH session on the VPS as root. Values are typed at silent prompts, written with shell built-ins (never in a command argument, never echoed, never in shell history); only lengths are printed.
```
set +o history; umask 077
cd /opt/twins-staging/infrastructure/staging
cp -p staging.env staging.env.pre-capture-creds-$(date -u +%Y%m%dT%H%M%SZ)
grep -qE '^TWINS_TELEGRAM_(API_ID|API_HASH|SESSION_DB_KEY)=' staging.env && echo "already present - stop" || {
  read -rs -p "api_id: " V; echo; printf 'TWINS_TELEGRAM_API_ID=%s\n' "$V" >> staging.env; unset V
  read -rs -p "api_hash: " V; echo; printf 'TWINS_TELEGRAM_API_HASH=%s\n' "$V" >> staging.env; unset V
  printf 'TWINS_TELEGRAM_SESSION_DB_KEY=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> staging.env   # generated here, never shown
}
chmod 600 staging.env; set -o history
awk -F= '/^TWINS_TELEGRAM_(API_ID|API_HASH|SESSION_DB_KEY)=/{print $1, "length", length($2)}' staging.env   # expect: 1-12, 32, 64
```
api_id and api_hash are the application identifiers you already have from my.telegram.org (the T1 values may be reused). The session key encrypts the TDLib database; the only copy is in `staging.env` (not in any backup), so keep your own copy in a password manager - without it a saved session is unreadable and a new login is the only recovery.
The allowlist line (section 1) is added in the approved step, not here. Verification afterwards without exposing values: the one-off `check-config` run prints only `ok` or the failed rule.

## 5. The one-off interactive login (NOT executed; you run it in your own terminal)
Prerequisites: credentials in `staging.env`, allowlist line, egress network deployed, api/worker/capture recreated, your account is a member of the private channel. Confirm the image first: `docker image inspect twins-staging:capture-8cb22f9 --format '{{.Id}}'` must print `sha256:a2d93e6d5fe244ccd4446869d1ca15b1ea1920cc4abebdf92aa385dee22a93ae`.
```
cd /opt/twins-staging/infrastructure/staging
docker compose -f docker-compose.staging.yml --env-file staging.env --profile capture run --rm --no-deps -it capture \
  python3 -E -s -B /app/services/telegram-capture/main.py login
```
What this uses: the pinned image tag from `staging.env`, uid/gid 1000:1000, the existing `twins_capture_session` and `twins_capture_state` volumes, a read-only root filesystem, no published ports, and (after the egress change) the two networks. You type the phone number, the login code and, if set, the 2FA password at the tool's own prompts (code and password are hidden; one attempt each). On success it verifies the pinned TDLib, your membership of the channel and the protected-content flag, prints `capture.login_ok` and exits 0; Telegram shows a "TWINS capture" device in Settings > Devices.

## 6. Start/stop commands for the test
Start (detached, no restart policy): `docker compose -f docker-compose.staging.yml --env-file staging.env --profile capture up -d --no-deps capture`. Watch: `docker logs -f twins-staging-capture-1`. Stop at any time: `docker stop twins-staging-capture-1`.

## 7. Bounded test plan (maximum 30 minutes, hypothetical text only)
Proposed posts (each verified locally with the repository parser: all classify as options claims; the plain text and the equity text do not):
- `M1`: `BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM` -> edit to `BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 125 SL 95 TGT 160 PREMIUM`
- `M2`: `BUY BANKNIFTY 52000 PE 29 OCT 2026 ABOVE 200 SL 150 TGT 280 PREMIUM`
- negative `N1`: `hello this is a plain test message` (expected: not stored, blocked by options-only)
(Use an expiry date still in the future on the day of the test.)
| Step | Owner action | Expected log (content-free) | Expected database evidence |
|---|---|---|---|
| T0 | none | `capture.library_verified`, `capture.started count=1`, `capture.connection tdlib_state=connectionStateReady` | baseline: no `telegram_sources` row for the test channel; message 2 absent |
| T1 new | post M1 | `capture.delivered kind=message status=202` within ~60 s | one `telegram_messages` row: `external_message_id=<M1>`, `origin_message_id=<M1>`, `capture_method=api_live`, `observed_at` set, `imported_at` NULL, `first_seen_edited=false`, raw text exact; one `seen` event with `content_sha256` = sha256 of that text; one options claim with `approval_possible=false`; no signal row; no market-data call |
| T2 edit | edit M1 | `capture.delivered kind=edited` | a NEW row `external_message_id=<M1>_edit_<edit_date>_<hash12>`, `origin_message_id=<M1>`, `edit_date` set; the original M1 row byte-identical (compare a row fingerprint taken before/after); one `edited_observed` event with the new hash |
| T3 delete | delete M1, then post and delete M2 (or delete both) | `capture.delivered kind=deleted` | `deleted_observed` events for each id; every raw row still present and unchanged |
| T4 negative | post N1 | `capture.delivered kind=message status=202`, then worker `non_options_blocked` | no new message row, no event for N1 |
| T5 scope | none | none | exactly one new `telegram_sources` row (the test channel); message 2 absent; no row for any other chat |
Evidence queries (read-only, run by the assistant under the same approval; they print ids, counts, flags and hash comparisons, never the text):
`telegram_messages` joined to `telegram_sources` on `channel_identifier = 'tg_chat_<TEST_CHANNEL_ID>'`: `external_message_id, origin_message_id, edit_date, capture_method, observed_at is not null, imported_at is not null, first_seen_edited, md5(raw_text)`; `telegram_message_events`: `event_type, external_message_id, telegram_message_id is not null, capture_method, content_sha256 = encode(sha256(convert_to(m.raw_text,'UTF8')),'hex')`; `options_claims`: `count(*), bool_or(approval_possible)`; counts of `signals`. Also grep the capture, api and worker container logs for the test phrases: must be zero matches.
**Stop conditions** (stop capture immediately, preserve logs, report, no retry): any `capture.alert` (flood_wait, login_required/session_ended, protected_content, not_a_member, ingest_*), capture container exit or restart, `capture.queue_overflow`, `capture.delivery_retry` for more than 5 minutes, any API 5xx or OOM kill, any database row for a chat other than the test channel or for message 2, any test text found in a log, a mismatch in the evidence above, or reaching 30 minutes.
After the test: `docker stop` capture; keep or remove the allowlist line (decision at the end); the real channel is a separate approval.

## 8. Rollback
1. `docker stop twins-staging-capture-1` (and `docker rm` it).
2. Invalidate the Telegram session: run `main.py logout` as a one-off (same command shape as the login, last word `logout`), or end "TWINS capture" in Settings > Devices; then remove the volume `twins-staging_twins_capture_session` only after logout or revocation.
3. Restore `staging.env` and the compose file from the hashed backups (removes credentials, allowlist and the egress network); recreate api and worker with an empty allowlist; remove the now-unused network.
4. Database: test rows stay (raw rows and events are immutable by design). If they must disappear, the only way is restoring the pre-test dump taken at the start; the test data is hypothetical and carries its own source row.
5. Verify the previous healthy state: `/health` 200 with `liveTradingEnabled:false`, webhook 503, allowlist empty, capture container absent.

## 9. Approvals still required (each separate)
1. This plan (documentation commit/push, optional).
2. Compose change adding `twins_egress` (and its commit).
3. Firewall rules for Telegram-only egress (optional, strongly recommended before the real channel; explicitly approved firewall work).
4. Owner credential entry (owner action) - the assistant then only verifies lengths and `check-config`.
5. Allowlist line + backup + recreate api/worker/capture (section 1-2).
6. Owner login (owner action; the assistant must not run it).
7. Start capture for the 30-minute test and run the read-only evidence queries.
8. Stop, clean-up or rollback, and the decision on the allowlist.
9. Later and separate: enabling the real channel, history import, T1-D cleanup confirmation.

## 10. Outcome of the bounded test (2026-10-23, staging; owner-posted messages in `<TEST_CHANNEL_ID>`)
Capture ran about 8 minutes (stopped on completion; session volume kept). TDLib 1.8.68 verified, connection ready, one channel configured, 0 restarts, no OOM, no API 5xx, no `capture.alert`.
- T1 new `<M1>`: 1 raw row (`api_live`, `observed_at` set, `imported_at` NULL, `first_seen_edited=false`), 1 `seen` event whose hash matched the row, 1 options claim with `approval_possible=false`, no signal.
- T2 edit: 1 revision row (`<M1>_edit_<edit_date>_<hash12>`, origin id `<M1>`), 1 `edited_observed` event (hash matched the revision). The original row was never updated: the table counters show 0 updates and 0 deletes, and its current hash equals the `seen` hash. (No before-edit fingerprint was taken; the proof is the counters plus the hash.)
- T3 delete: 1 `deleted_observed` event linked to the stored row, content-free; all raw rows still present.
- T4 plain text: delivered by the client, blocked by the worker (`non_options_blocked`); no row, no event.
- Scope: message 2 absent; no row or event for any other chat (the one pre-existing row of another source was unchanged); the real signal channel was not touched.
- Logs: no message text in the capture, api or worker logs (the only "premium" matches in the worker log are reason-code tokens).
Not yet verified: restart/network-drop behaviour, flood-wait/revocation/protected-content paths on real Telegram, edits made while capture is offline, history import, and Telegram-only egress (the egress network is ordinary outbound NAT). The test rows remain in the staging database by design.

## 11. Restart and gap test (2026-10-23, staging, test channel only, behind the Telegram-only egress firewall)
Sequence: capture started (`connectionStateReady` about 1 s later, existing session reused, no login prompt) -> owner posted `<M2>` -> captured -> capture stopped -> owner posted `<M3>` while capture was stopped -> capture restarted (the gap before the restart was about 7.6 hours; the planned 2 minutes was exceeded because `<M3>` was posted much later than the stop) -> stopped.
- `<M2>`: 1 raw row (`api_live`, provenance set, `first_seen_edited=false`) + 1 `seen` event whose hash matched the row; options claim `approval_possible=false`.
- **Finding - the expected gap did NOT occur for `<M3>`.** One second after the restart TDLib caught up on the update it had missed and delivered `<M3>` as an ordinary new message: 1 raw row (`api_live`, `imported_at` NULL) + 1 `seen` event, `observed_at` about 193 s after the message timestamp. Consequences: (a) short gaps are recovered by TDLib's own update catch-up as long as its saved update state is intact; (b) the row is labelled `api_live` although it was seen late - the only trace is `observed_at` minus the message timestamp (no explicit catch-up flag exists); (c) this is NOT a guarantee: catch-up can be skipped after a long outage or a lost state, so the approved history import remains the only reliable gap recovery; (d) edits and deletions made while offline were not tested.
- Session survival: no login request, no alert, 0 restarts, no OOM, no API 5xx; the firewall counters showed only Telegram-range traffic accepted and no new drops.
- Tooling: the first watcher block-buffered its output (`cut` at the end of the pipeline), so a captured message was not reported for about 12 minutes. Fixed in `scripts/ops/capture-watch.sh` (every stage line-buffered; a test proves events stream before the source ends and fails if a block-buffering stage is reintroduced).
Still unverified: catch-up after outages of days, crash with queued events, offline edits/deletes, flood-wait and revocation on real Telegram.
