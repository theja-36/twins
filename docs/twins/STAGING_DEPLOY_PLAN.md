# Staging deploy plan: Stages 3-5, P0 hardening and the verifier fix

> **Status: PLAN ONLY. Nothing in this document has been executed.** Written 2026-11-01 against `main` at `ef833e4` (hosted CI green, run 41342324093). Executing any step needs the owner's explicit approval ("approved to execute the staging deploy plan"), and each gate below is a stop point. Facts about the host were read-only observations on 2026-11-01 and must be re-checked in section 2 before executing. Related: [STAGING_DEPLOYMENT_VERIFICATION.md](STAGING_DEPLOYMENT_VERIFICATION.md) (the Stage 2 deployment this plan repeats and extends), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [HARDENING_BACKLOG.md](HARDENING_BACKLOG.md), decisions D-077 / D-078.

## 0. What this deploy does and does not do

**Does:** brings staging from commit `0d333eb7` (Stage 2, migrations 0000-0013) to `main` `ef833e4` (migrations 0000-0028): the risk, historical-intelligence and agent-engine tables and code, the hardened approval function, the runtime-role grants, the fixed audit-chain verifier (which ends the false `anchor_mismatch` failure), and a decision on the approval bot's restart loop.

**Does not:** enable the agent engine (`TWINS_AGENT_ENGINE_ENABLED` stays unset = false, and `agent_engine_state` stays `false`), activate the approval bot, change `LIVE_TRADING` / `TRADING_ENABLED` / `TWINS_BOT_ACTIVE` (all stay false), touch the capture client or the real Telegram channel, merge any Kite branch, install the off-host backup, or start Stage 6.

### Current state vs target (observed read-only, 2026-11-01 06:40 UTC)
| Item | Now | After this deploy |
|---|---|---|
| Migrations recorded | 14 (0000-0013) | 29 (0000-0028) |
| Audit chains | 6 (verifier sees 6) | 32 (verifier expects 32) |
| `api`, `worker`, `alert-relay` image | `twins-staging:tgalert-0d333eb7` | `twins-staging:main-ef833e48` |
| `scheduler` (profile `scheduler`, running) | `main-a0120d75` | same new image, stays off unless the owner wants it (see section 9, Q7) |
| `approval-bot` | `task5-5683e412`, 254 restarts | new image, **stopped** until activation (decision D1 below) |
| `capture` | `capture-2762179-1ad16990`, 0 restarts since 2026-10-31 16:08 | **unchanged** (no capture code changed between `0d333eb7` and `main`) |
| Audit-verify timer | failing hourly since 2026-10-29 15:02 (false positive, D-078) | passes (first run on the new image) |
| Host | disk 76 GB free of 193 GB; RAM about 7.6 GB available | build needs about 1.5 GB RAM and about 2 GB disk |

### Behavior change to understand before approving (not a flag)
The worker's risk flow has **no enable flag**. With the new image, every *newly* processed options claim or signal creates risk-decision rows (PENDING, then sized / gated as far as the configuration allows) and may run the portfolio, market and source-intelligence steps. It never creates an approval card, an approval, an order, a fill or a position (cards need an explicit API call; no execution code exists). Existing messages and claims (50 / 50) are not reprocessed. The agent engine stays off, so no assessment is produced. Whether the first risk decisions fail closed for lack of configuration (capital, portfolio limits) is not proven from code alone; the rehearsal in P7 must show it. See open question Q3.

## 1. Roles, gates and stop rules
* **Operator** (assistant or the owner) executes; **owner** approves each gate G0-G4. No step runs without the previous gate being recorded.
* **Stop rule:** any step whose acceptance criterion is not met stops the deploy. Do not "continue anyway". Choose rollback (section 6) or hold at the current step. Never improvise a repair of audit data or the anchor file.
* **Hard prohibitions throughout:** no edit of the anchor file, no re-anchor, no deletion of rows, no `ALTER ... DISABLE TRIGGER`, no `LIVE_TRADING`/`TRADING_ENABLED`/`TWINS_BOT_ACTIVE` change, no engine enable, no kill-switch change except as a pre-agreed safety action (and then audited).
* **Record everything** in `/opt/twins-staging/deployments.jsonl` (one line: commit, image tag and id, manifest hash, compose hash, pre-deploy backup file, previous tags) and in a deploy report under `docs/twins/`.

| Gate | Meaning |
|---|---|
| G0 | Owner approves this plan and answers section 9 |
| G1 | Pre-deploy checks (section 2) and rehearsal (P7) all pass |
| G2 | Image built and verified (section 3) |
| G3 | Database step done and verified (section 4) |
| G4 | Services up and post-deploy verification passed (section 5): deploy declared successful |

## 2. Pre-deploy checks (no change to staging state, except P7 which uses a scratch database)
Estimated time 45-60 minutes. Downtime: none. Risk: low.

| # | Check | How | PASS | FAIL action |
|---|---|---|---|---|
| P1 | `main` is the intended commit and CI is green | `git rev-parse origin/main`; `gh run list --branch main --workflow ci --limit 1` | head is the approved commit (currently `ef833e48...`); latest `ci` run on exactly that commit concluded success | stop; resolve |
| P2 | Source tree is exactly `main` | `git archive <commit>` on the workstation; compute the SHA-256 manifest; copy to the host; recompute there | manifests byte-identical (same method as Stage 2, section 1 of the verification doc) | stop; re-transfer |
| P3 | Fresh verified backup | run `twins-backup` (the existing job: dump, encrypt, decrypt-compare, `pg_restore --list`); `sha256sum -c` of the `.enc`; copy into `backups/pre-deploy-main-ef833e48/` | `twins-backup --status` ok and younger than 26 h; checksum OK | stop |
| P4 | Audit-chain baseline recorded | `docker compose ... --profile ops run --rm audit-verify --require-ddl-watch` with the **current** image; save the head index and hash of all 6 chains | the only failure is the known `anchor_mismatch` on `signal_validations` (false positive); the other 5 chains match their anchors (compare the 5 anchored hashes read-only, as in the 2026-11-01 investigation) | any other failure: stop, investigate (possible real tampering) |
| P5 | Disk and memory | `df -h /`; `free -m` | disk free over 10 GB; MemAvailable over 3 GB | stop; free space (needs owner approval to delete anything) |
| P6 | Empty-table precondition for 0014 | `select count(*) from risk_decisions` (a baseline-schema table that migration 0014 alters) | exactly **0** (it was 0 on 2026-11-01). Also `decisions` etc. have no dependent rows. | if not 0: stop; 0014 assumes no rows |
| P7 | **Rollback and migration rehearsal on a scratch database** (the only P-step that writes anything: to a throwaway DB) | see section 6.1 | migrations 0014-0028 apply on a restored copy of staging data; `verify-migrations.mjs` passes (29, 32 chains); `audit:verify --require-ddl-watch` PASS twice in a row (proves the verifier fix on real staging data, including an anchor round trip); restore-back from the pre-deploy backup works; elapsed times recorded | stop; the deploy does not proceed |
| P8 | Host environment | `grep` (names only, never values) that `staging.env` has `TWINS_APP_DB_PASSWORD`, `TWINS_IMAGE_TAG`; the capture tag line is understood (see Q6); the owner-held alert destination is configured (relay `status`: `destinations ["telegram"]`) | names present; relay destination present | stop |
| P9 | Quiet window | `telegram_intake_outbox`: no PENDING / FAILED / PROCESSING rows; last capture older than 10 min | outbox idle | wait or reschedule |
| P10 | Alert path proven before relying on it | `alert-test.ts` INFO one-shot (as in Stage 2) and read the last 3 failure-alert deliveries of `twins-alert-on-failure@twins-audit-verify.service` in `journalctl` | test delivered; the host failure path has delivered or its absence is understood (Q5) | do not deploy blind: fix alerting first |

## 3. Build the image from `main` (on the host, as in Stage 2)
Estimated 10-15 minutes. Downtime: none (builds beside the running stack). Risk: low (memory watchdog aborts below 1500 MiB available).

1. Extract the verified `git archive` to `/opt/twins-staging/src-main-ef833e48`; store `source-manifest.main-ef833e48.sha256`.
2. Build with the same script pattern as `build-task5-5683e412.sh` (copy and edit `SHORT`/`FULL`): refuses an existing tag, memory watchdog, `--pull=false`, labels `org.opencontainers.image.revision`, `.source`, `twins.source-manifest-sha256`, Dockerfile `infrastructure/staging/Dockerfile`, tag **`twins-staging:main-ef833e48`**.
3. One image serves `api`, `worker`, `scheduler`, `alert-relay`, `approval-bot`, `migrate` and every ops one-shot. The **capture image is not rebuilt** (the `services/telegram-capture` tree and `Dockerfile.capture` did not change since `0d333eb7`; confirm with `git diff 0d333eb7 ef833e4 -- services/telegram-capture infrastructure/staging/Dockerfile.capture`, expected empty).
4. **G2 acceptance:** build exit 0; `docker image inspect` shows the labels and the expected commit and a new image id; in a throwaway container from the new image with no network and no database, `node --import tsx -e "import('/app/packages/audit-chain/src/index.ts')"` loads and `node --version` matches the Dockerfile base. (Anything that connects to a database waits for section 4.) Existing images stay on the host for rollback.
5. Append the deployment line to `deployments.jsonl` (state `built, not deployed`).

## 4. Database step (the only irreversible-ish step)
Estimated 5-8 minutes of **api/worker downtime** (the stack's other containers and capture stay up). Risk: **medium** (schema change of a protected, hash-chained database; mitigated by P3, P6, P7 and the restore path in section 6).

Order (identical in shape to Stage 2):
| # | Step | Acceptance (PASS) | If FAIL |
|---|---|---|---|
| D0 | Announce; confirm P9 again; take a second quick backup (`twins-backup`) so the restore point is minutes old | status ok, checksum OK | stop |
| D1 | `docker compose -f docker-compose.staging.yml --env-file staging.env stop api worker` (keep `alert-relay`, `postgres`, `redis`, `capture` running; `scheduler` and `approval-bot` stopped if running) | containers stopped; capture still up (its POSTs will get connection errors until D7; see section 7 risk R2) | `start` them again; abort |
| D2 | Put the new compose file and `TWINS_IMAGE_TAG=main-ef833e48` in place (copy the old compose / `staging.env` to `*.pre-main-ef833e48-<stamp>` first, mode 0600). Compose changes vs deployed: new `risk-control` ops service and nothing else material (see D3b) | `docker compose config` valid; diff of compose reviewed | restore the copies |
| D3 | `docker compose ... --profile migrate run --rm migrate` (the guarded one-shot; applies 0014-0028 in order) | log "migrations applied"; `select count(*) from drizzle.__drizzle_migrations` = **29** | do NOT retry blindly: read the error; if a migration partially applied, go to section 6 (Level 2); migrations run inside drizzle's transaction per file, so a failed file leaves the previous files applied |
| D3b | Migration order is the journal order **0014 risk_decisions_foundation, 0015 sizing, 0016 portfolio, 0017 circuit breakers, 0018 market gates, 0019 risk approvals, 0020 historical import, 0021 outcome evaluation, 0022 scorecards, 0023 patterns/confidence, 0024 source intelligence, 0025 agent engine, 0026 agent id hyphen, 0027 research eligibility, 0028 P0 hardening**. No down migrations exist: rollback is restore (6.3). | n/a | n/a |
| D4 | `node scripts/ci/verify-migrations.mjs` inside the new image against staging (read-only) | passes; reports 29 migrations and the 0004-0028 structure checks (32 audit chain heads, `ENABLE ALWAYS` guards, SECURITY DEFINER doors, `agent_engine_state` one row, card columns) | stop; section 6 |
| D5 | Apply `infrastructure/staging/app-role.sql` as the owner (`psql -v app_role=twins_app -f ...`, password not involved) | success; `twins_app` can SELECT `agent_orchestrator_runs`, `agent_orchestrator_syntheses`, `agent_runs`, `agent_evidence_references`, `risk_decisions`, `agent_engine_state`; has **no** INSERT/UPDATE/DELETE on `agent_engine_state`, `risk_approvals`, `system_controls`; no privilege at all on `agent_engine_state_events`, `audit_chain_heads`; EXECUTE on `twins_research_assessment`, `twins_agent_evidence_fp`, `twins_record_risk_approval`. Check with the privilege queries below. | fix grants; do not start services |
| D6 | Apply `approval-bot-role.sql` (the bot gets SELECT on cards and EXECUTE on the three definer functions) | success; bot role still has zero write privileges on audit tables | as D5 |
| D7 | **Audit verification with the new image:** `... --profile ops run --rm audit-verify --require-ddl-watch` (no anchor file), then again **with** `--anchor-file /monitor/audit-anchor.json --status-file /monitor/audit-verify.json` (this is what the hourly timer runs) | both **PASS**; 32 chains reported; the 26 new chains `rows=0 head=0`; DDL watch installed; the anchor round trip does not report `signal_validations`; the five previously anchored chains match | any FAIL: stop, do not start services, section 6; do not touch the anchor |

Privilege check queries (read-only, run as the owner): `has_table_privilege('twins_app', '<table>', '<priv>')` for each relation/privilege above; `has_function_privilege`. Pass criterion is an exact match with the lists in D5; any extra privilege is a FAIL.

## 5. Services and post-deploy verification
Order matters: data first, then consumers, then producers.

| # | Step | Acceptance (PASS) |
|---|---|---|
| S1 | `up -d alert-relay` (recreate on the new image) | healthy; status shows `destinations ["telegram"]`, undelivered critical 0 |
| S2 | `up -d api` | healthy; **start-up probe passes**: no `agent_engine.config.invalid` in logs (engine disabled, grants present); connects as `twins_app` (`pg_stat_activity`); no exit 81 / 82 |
| S3 | `up -d worker` | running; log line `appEnv=staging tradingMode=paper liveTradingEnabled=false`; no exit 81 / 82; `outbox.reconciler` running; no `agent_engine` events (engine off); restarts 0 |
| S4 | `approval-bot`: **decision D1 (section 8)**: recreate on the new image **and leave it stopped** | container exists on the new image, not running; no process restarting every 15 minutes |
| S5 | `capture`: do not touch. Confirm it reconnects to the API after S2 and its next message is accepted | `docker inspect` restart count unchanged (0); next live message creates exactly one outbox row `PENDING -> COMPLETED` (do not inject synthetic traffic into the real channel) |
| S6 | `scheduler`: leave stopped (it was running `main-a0120d75` with an empty watchlist; confirm Q7 first) | decision recorded |

### Post-deploy verification (G4, all must pass)
| # | Check | PASS criterion |
|---|---|---|
| V1 | Migration count | `drizzle.__drizzle_migrations` = **29**; `verify-migrations.mjs` passes |
| V2 | **Audit chain green** | the hourly `twins-audit-verify.service` run after the deploy exits 0 (`systemctl start twins-audit-verify.service` once manually and then confirm the next scheduled run); status file `ok:true`, `last_ok_epoch` fresh; `first_failure` absent; 32 chains |
| V3 | Safety posture unchanged | `safety-control status`: `TRADING_ENABLED=false`, `INTAKE_ENABLED=true`, `KILL_SWITCH_ACTIVE=false`; compose literals `LIVE_TRADING=false`, `TRADING_MODE=paper`; `agent-engine` database flag false (`select enabled from agent_engine_state`); `TWINS_AGENT_ENGINE_ENABLED` unset in the api / worker environment |
| V4 | Health | `GET /health` 200; `GET /health/status` with the key shows database / redis ok, outbox counts, fresh `lastSuccessfulBackupAt` and `lastSuccessfulAuditVerificationAt` |
| V5 | Roles | privilege queries from D5 re-run; `twins_bot` has no write privilege on any protected table |
| V6 | Intake durable path | at least one real captured message flows `PENDING -> COMPLETED`, `dead_letter = 0`, `stuck = 0`; the capture gap 2026-10-24 to 2026-10-31 is a separate decision (Q4) |
| V7 | Worker risk flow does what the rehearsal said | after the first new message, `risk_decisions` rows exist (or the documented fail-closed refusal is logged); **zero** rows in `risk_approval_cards`, `risk_approvals`, `orders`, `fills`, `positions`, `agent_orchestrator_runs` |
| V8 | Alerts | an INFO `alert.test` through the relay delivers to Telegram; the `process.restart_loop` rule is not firing |
| V9 | Timers | `systemctl list-timers` shows backup, audit-verify and backup-verify timers active; `twins-backup.service` last result success |
| V10 | No ghost processes | `docker ps`: only the expected containers; no container restarting |

**Declare success** only when V1-V10 all pass, `deployments.jsonl` has the final line, and a deploy report is committed. Otherwise the deploy is "partially applied" and the owner decides between hold and rollback.

## 6. Rollback

Principles: migrations are forward-only (no down scripts). 0014-0028 are additive except that 0014 alters the baseline `risk_decisions` table (drops two NOT NULLs, adds columns), which old code never used. **Old code runs unchanged on the new schema**, so the cheapest rollback after a database step is code-only (Level 1). A database restore (Level 2) destroys everything written after the restore point and is chosen only for data-integrity doubt or a failed migration.

### 6.1 Rehearsal on a scratch database (P7, mandatory before G1)
1. Restore the P3 backup into a scratch database on the staging Postgres (`createdb twins_rehearsal_<stamp>`; `pg_restore --no-owner` from the decrypted dump; remove the plaintext afterwards with `shred -u`).
2. Run the new image's `migrate` one-shot against the scratch database only (override `DATABASE_URL`/`POSTGRES_DB`; never the live database). Record elapsed time.
3. Run `verify-migrations.mjs` and `audit-verify --require-ddl-watch` against the scratch database twice, the second time with a temporary anchor file in a private directory (so the round trip is proven). PASS = both green.
4. Simulate rollback: restore the same backup into a second scratch database and compare counts (migrations 14, 50 messages, 50 claims) and the six chain heads with the P4 baseline.
5. If the worker's risk flow is to be judged (Q3), start the new worker image against the scratch database with the egress disabled and push one synthetic message through its ingestion test path, then inspect the resulting `risk_decisions` rows and that no card / approval / order exists. If this cannot be done safely, record that V7 is the first real observation.
6. Drop the scratch databases only after the owner approves.

### 6.2 Level 1: code only (database stays at 0028, nothing restored)
When: services fail to start, probe fails, health check fails, the verifier unexpectedly fails and the database is believed intact.
1. Stop `api worker alert-relay` (and the bot if running).
2. Restore `docker-compose.staging.yml` and `staging.env` from the `*.pre-main-ef833e48-*` copies (or set `TWINS_IMAGE_TAG=tgalert-0d333eb7`). The previous images `tgalert-0d333eb7`, `task5-5683e412`, `main-a0120d75` remain on the host.
3. `up -d alert-relay api worker`.
4. **Verify the rollback:** services healthy on the old image (`docker inspect ... .Config.Image`); `safety-control status` unchanged; `GET /health/status` ok; capture accepted a message; `audit-verify` with the **old** image reports the old, known false `anchor_mismatch` and nothing else (the old verifier ignores the new chains), which is the pre-deploy baseline, not a new failure; the new tables are present but unused.

### 6.3 Level 2: database restore from the pre-deploy backup
When: a migration fails midway, the audit verification fails on a real mismatch, or integrity is in doubt. Destroys all writes after the restore point (including messages captured since). Use the backup taken at D0 (minutes old) so the loss window is minutes.
1. Stop `api worker alert-relay approval-bot scheduler` (capture keeps running but its POSTs fail until step 6; it holds and retries per its own policy; check its log).
2. Verify the `.enc` checksum, decrypt with `twinsenc.py decrypt <key path> <file> /root/rollback.dump` (0600) as in the Stage 2 doc (section 7).
3. Restore into a scratch database; check counts (migrations 14, expected message count, chain heads equal to the baseline P4).
4. During the stop: `ALTER DATABASE <db> RENAME TO <db>_post_deploy; ALTER DATABASE twins_rollback RENAME TO <db>;`, re-apply `app-role.sql` and `approval-bot-role.sql` of the **old** commit if the old roles need it (they exist already in the restored database since the backup includes ownership-free objects; re-run the old role scripts to be safe).
5. Apply Level 1 (old compose / env / images), start services.
6. Keep `<db>_post_deploy` until the owner approves dropping it. `shred -u /root/rollback.dump`.
7. **Verify:** counts match the baseline, the old-image `audit-verify` shows the baseline result, the first real message flows to `COMPLETED`, no data after the restore point is claimed.

### 6.4 Rollback decision table
| Symptom | Action |
|---|---|
| Image build or smoke fails | nothing to roll back; fix, rebuild with a new tag |
| `migrate` fails on file N | read error; if the database is consistent at N-1: fix forward only after owner review, else Level 2 |
| `verify-migrations` / D5 grants wrong | do not start services; correct the role scripts only if the correction is a documented script change; else Level 2 |
| D7 audit verify FAIL (not the old false positive) | stop; **do not** edit the anchor; Level 2 if data integrity in doubt; otherwise investigate read-only first |
| Service crash-loops or probe fatal | Level 1 |
| Post-deploy V7 shows an unexpected card / approval / order row | engage the kill switch (audited), stop worker, investigate; Level 2 only if rows prove unsafe |

## 7. Downtime and risk per step
| Step | Est. duration | API / worker downtime | Risk | Main mitigation |
|---|---|---|---|---|
| P1-P6, P8-P10 | 30 min | none | low | read-only |
| P7 rehearsal | 15-30 min | none (scratch DB; some load) | low | scratch DB only |
| Section 3 build | 10-15 min | none | low | memory watchdog, unique tag |
| D0 backup | 2 min | none | low | existing job |
| D1-D2 | 2 min | starts here | low | copies of compose / env |
| D3 migrate | 1-3 min (per rehearsal) | yes | **medium** | rehearsal, backup, per-file transactions |
| D4-D6 verify, roles | 2 min | yes | medium | exact privilege lists |
| D7 audit verify | 1 min | yes | medium | gate before services |
| S1-S6 start | 3 min | ends at S2 / S3 | low | ordered start, health checks |
| V1-V10 | 20-30 min | none | low | all read-only except one INFO alert |
| **Total user-visible** | **about 6-10 minutes** of API and worker downtime; **about 1.5-2 hours** end to end | | | |

Residual risks: **R1** the worker risk flow's real first-message behavior (see section 0); **R2** while the API is down capture POSTs fail: confirm in P7/P9 how the capture client retries, schedule when the channel is quiet, keep D1-S3 under 10 minutes; **R3** images are built on the host and identified by label plus manifest, not by a registry digest or signature; **R4** the pre-deploy backup is local only (off-host backup timers remain disabled, Q8); **R5** the hourly verifier will take the new image only once `staging.env` points `TWINS_IMAGE_TAG` at it, which D2 does.

## 8. Decisions embedded in the plan
**D1 Approval-bot restart loop (recommendation: leave it stopped until activation).** Cause: with `TWINS_BOT_ACTIVE` false, `services/approval-bot/src/index.ts` logs `bot.alert not_active`, holds for `FATAL_HOLD_SECONDS`, returns 3, and `restart: unless-stopped` restarts it (254 restarts in about 9 days; it is "by design" but looks like a crash loop and risks the `process.restart_loop` alert). Options:
* **A (recommended, no code):** recreate the bot container on the new image but do not start it; it is a `bot`-profile service, so `up` does not start it. Start it only under the separate activation approval. Operational risk: none (it is inactive anyway).
* **B (code, later PR):** make the inactive bot idle without exiting, or exit 0 with `restart: on-failure`. Cleaner for activation rehearsals but a code change outside this deploy.
* **C:** keep as is. Rejected: noise, alert-fatigue risk (the audit-verify false positive already showed the cost of tolerated red).
Acceptance for A: `docker ps -a` shows the bot `Exited` and not restarting; restart count frozen.

**D2 Alert routing check.** Before the deploy: P10. After: V8. The audit-verify host failure path (`twins-alert-on-failure@`) must be shown to have delivered at least once, or the gap fixed first (open question Q5). The new application-layer rules (`telegram.capture.gap`, queue exhaustion, `kite.session.invalidated`, outbox dead-letter, etc.) only fire from processes that log them; the engine events (`agent_engine.*`) have no alert route yet (HB-18, P1), which is acceptable only while the engine stays off.

**D3 Deployed compose.** Use `main`'s `infrastructure/staging/docker-compose.staging.yml` (adds `risk-control`). There is no compose service for `agent-engine-control` (the owner CLI added by D-077) or `scripts/ops/agent-snapshots`; they are not needed for this deploy and are required before the engine is ever enabled: record as a follow-up task, not part of this deploy.

## 9. Open questions for the owner (answer before G0)
* **Q1** Maintenance window: a quiet period of about 2 hours (pick when the channel is quietest); who is available to approve gates?
* **Q2** Approve the P7 rehearsal on a scratch database on the staging Postgres (extra load and a few hundred MB of disk, deleted afterwards)?
* **Q3** Accept that the worker will start creating risk-decision rows for new claims after the deploy (no cards, no approvals, no orders, engine off)? If not, the alternative is to deploy everything except the worker (keep the old worker image), which leaves Stage 3 code unexercised.
* **Q4** The capture gap 2026-10-24 to 2026-10-31 (messages not captured while the client was down): backfill now, later, or never? Not part of this deploy.
* **Q5** Were the roughly 60 audit-verify failure alerts delivered? (Checked read-only in P10; if not, fixing alerting comes first.)
* **Q6** `staging.env` references a capture image tag (`a7d15aa0`) that is not on the host while the running capture uses `capture-2762179-1ad16990`: approve aligning the env file to the running tag (a documented, copy-first edit) so a future recreate does not fail?
* **Q7** Should the idle `scheduler` (empty watchlist, no provider keys) stay stopped?
* **Q8** Accept a local-only pre-deploy backup (off-host timers stay disabled until the owner supplies the key / credentials)?
* **Q9** Freeze `main` at `ef833e4` (or name the commit) for the deploy so the archive, manifest and CI evidence refer to the same commit.

## 10. Acceptance summary (what must be true to call the deploy successful)
1. The deployed commit is the approved one, hosted CI green on exactly it, source manifest verified, image labels match.
2. 29 migrations, 32 audit chains, `verify-migrations` passes.
3. `audit-verify --require-ddl-watch --anchor-file` passes on the new image, and the scheduled hourly run passes after the deploy; the old false positive is gone; no anchor was edited.
4. `twins_app` and `twins_bot` privileges match the lists exactly; no write path to approvals, audit tables or `agent_engine_state` for the runtime role.
5. `LIVE_TRADING=false`, `TRADING_ENABLED=false`, `TWINS_BOT_ACTIVE=false`, engine flag false, engine environment variable unset, kill switch unchanged.
6. API, worker, alert relay healthy; capture untouched and accepted a message; bot stopped and no restart loop.
7. Zero approval cards, approvals, orders, fills, positions and agent runs created.
8. Backups and the three timers healthy; an alert test delivered.
9. `deployments.jsonl` and a deploy report committed; rollback copies retained; rollback rehearsal evidence recorded.
