# Staging deploy plan: Stages 3-5, P0 hardening and the verifier fix

> **Status (updated 2026-11-03): two parts.** **Part A (sections 0-10)** is the plan for the first deployment, which was **executed on 2026-11-01** (staging runs `main-ef833e48`, 29 migrations; the evidence is in the deploy report and `deployments.jsonl`; deviations are listed in section 12). **Part B (section 11, below) is the plan for the NEXT deployment, a delta to `main` `aa3093b`**: migration 0029 (30 in total), the Kite read-only code in the image, and the follow-ups found since. Part B is **PLAN ONLY: nothing in it has been executed.** Executing any step needs the owner's explicit approval ("approved to execute deploy 2"), and each gate is a stop point. Host facts were read-only observations on 2026-11-03 and must be re-checked in the pre-deploy checks.

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
| D3b | Migration order is the journal order **0014 risk_decisions_foundation, 0015 sizing, 0016 portfolio, 0017 circuit breakers, 0018 market gates, 0019 risk approvals, 0020 historical import, 0021 outcome evaluation, 0022 scorecards, 0023 patterns/confidence, 0024 source intelligence, 0025 agent engine, 0026 agent id hyphen, 0027 research eligibility, 0028 P0 hardening, 0029 revoke runtime writes on orders / fills / positions (added after this plan was first written; applied in Deploy 2)**. No down migrations exist: rollback is restore (6.3). | n/a | n/a |
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

---

# Part B: Deploy 2, the delta from `main-ef833e48` to `main` `aa3093b` (PLAN ONLY, nothing executed)

## 11. Deploy 2

### 11.1 Starting point (read-only observations, 2026-11-03 06:00 UTC)
| Item | Observed |
|---|---|
| Image on `api`, `worker`, `alert-relay` | `twins-staging:main-ef833e48` (deployed 2026-11-01), restarts 0 |
| `approval-bot` | created on `main-ef833e48`, **stopped** (no restart loop); `scheduler` stopped; `capture` on `capture-2762179-1ad16990`, running since 2026-11-01 21:40, restarts 0 |
| Migrations | **29** (0000-0028) |
| Audit verification | scheduled run green, `ok:true` (32 chains) |
| Data | 72 messages and 72 options claims; `risk_decisions` 38; `risk_approval_cards`, `risk_approvals`, `orders`, `fills`, `positions`, `agent_orchestrator_runs` all **0** |
| Intake outbox | 46 COMPLETED, **1 DEAD_LETTER** (see K1 in 11.8); 22 live messages arrived on 2026-11-02 and 11-03 and flowed through the new code, which also closes the live-capture variant of V6 |
| Host alert path | `twins-alert.sh`, the compose file and `alert.env` were installed from PR #50's branch on 2026-11-01; `main` now contains the same content (verify by hash in PB3) |

### 11.2 What changes between `ef833e4` and `aa3093b` (from `git diff --stat`, 79 files; runtime-relevant ones)
* **Migration 0029** (`0029_p1_revoke_runtime_execution_writes.sql`): one `DO` block that REVOKEs INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER on `orders`, `fills`, `positions` from `twins_app` and `twins_bot` if they exist. Metadata only; no table is rewritten, no data changes; journal total **30**; audit chains stay **32** (no new chain).
* `infrastructure/staging/app-role.sql`: `orders`, `fills`, `positions` join the read-only list (so a re-run never grants them back). `scripts/ci/verify-migrations.mjs`: new check that no runtime role can write them; the expected count is 30.
* `packages/alerting`: `detectCaptureGap` and three new alert rules (`telegram.capture.gap`, `kite.session.invalidated`, exhausted `worker.queue.job_failed`). The rules only fire when a process logs those events; **nothing schedules or logs `telegram.capture.gap` yet**, and no queue is configured to emit the others at staging, so there is no new alert noise.
* `packages/agents`: shared snapshot-generation publisher and small provider changes. The engine stays disabled, so this is inert.
* `packages/kite` (new): the read-only Kite code (section 11.3). `apps/*`, `services/*`, the Dockerfiles and the entrypoints are **unchanged**.
* `docker-compose.staging.yml` (+3 lines, relay on `127.0.0.1:8099`), `twins-alert.sh`, `alert.env.example`: already live on the host from PR #50; unchanged by Deploy 2 except for the tag.
* Not changed: `services/telegram-capture` (so the capture image stays), the audit verifier (the fix shipped in Deploy 1).

### 11.3 Kite code in the image: dormant by construction
* `COPY packages ./packages` puts `packages/kite` into the image. **Nothing imports it**: `grep -rl "@twins/kite\|packages/kite" apps services scripts adapters` returns nothing (re-run in PB4). No service, job, timer or compose profile starts Kite code.
* No Kite variable exists in `docker-compose.staging.yml` or (by name) in `staging.env`; the code reads `TWINS_KITE_API_KEY`, `TWINS_KITE_API_SECRET`, `TWINS_KITE_ACCESS_TOKEN` and the `TWINS_KITE_*` wiring names, none of which is set on staging. `api` and `worker` run on the `internal` network `twins_data`, so they could not reach `api.kite.trade` anyway.
* **Plan gate, corrected statement.** The gate is real (`packages/kite/src/plans.ts`): the plan is an **option** of `KiteClient` and `KiteTicker` and defaults to `"personal"`, which refuses market data, historical candles and the WebSocket locally with `PLAN_RESTRICTED` before anything is sent; account reads work on either plan. **There is no `TWINS_KITE_PLAN` environment variable or loader in the code**: earlier text (a comment in `plans.ts` and the sentence "TWINS_KITE_PLAN=connect" in `KITE_INTEGRATION.md`) said otherwise and has been corrected. A plan loader is a prerequisite of the future task that wires Kite, not of this deploy; with nothing constructing a client, the default cannot be bypassed.
* All order, GTT, position, holdings-authorisation, mutual-fund and logout paths are refused for every method; Kite has no write method on its client class.

### 11.4 Pre-deploy checks (PB; no change to staging except the scratch database in PB8)
| # | Check | PASS |
|---|---|---|
| PB1 | `main` is the approved commit (default `aa3093b`, or the commit that carries the K1 fix if the owner chooses to include it) and its hosted `ci` run is green | commit and run match |
| PB2 | Source tree: `git archive` of that commit, manifest computed on the workstation and on the host (use `git archive --format=tar.gz`, never a macOS `tar`, which adds `._*` files) | manifests byte-identical |
| PB3 | Host alert files equal `main`: `sha256sum` of `/usr/local/sbin/twins-alert.sh` and the deployed compose against `git show <commit>:infrastructure/staging/...` (the compose will differ only if the host copy was edited) | identical, or the difference is understood before replacing |
| PB4 | Kite is dormant: the import grep above is empty on the extracted tree; `staging.env` has no `TWINS_KITE_` names | true |
| PB5 | Fresh verified backup (`twins-backup`, `--status` ok, checksum OK), pinned in `backups/pre-deploy-main-<sha8>/` | true |
| PB6 | Audit baseline: `audit-verify --require-ddl-watch --anchor-file` PASS with the current image; record head indexes | PASS, 32 chains |
| PB7 | Disk over 10 GB, MemAvailable over 3 GB, intake outbox idle (no PENDING / FAILED / PROCESSING), `risk_decisions` count recorded | true |
| PB8 | **Rehearsal of 0029 on a scratch copy** (restore the PB5 backup into `twins_rehearsal_a`, apply the new image's `migrate`, `verify-migrations`, `app-role.sql` + `approval-bot-role.sql`, privilege checks, `audit-verify` twice with a copy of the real anchor, then the rollback swap as in 6.1) | migration applies; `verify-migrations` passes with 30; `twins_app` has SELECT and nothing else on the three tables; audit PASS; swap restores 29 and the counts |
| PB9 | K1 decision (11.8) recorded | decided |
| PB10 | Alert path: a host `twins-alert.sh --test` INFO is forwarded by the relay | delivered |

### 11.5 Build
Same procedure as section 3 with tag `twins-staging:main-<sha8>` (for `aa3093b`: `main-aa3093ba`): extract the verified archive to `/opt/twins-staging/src-main-<sha8>`, build with a copy of `build-main-ef833e48.sh` (refuses an existing tag, memory watchdog, labels for revision and manifest), smoke test with no network and no database (module load; `node -e` import of `@twins/audit-chain` and `@twins/kite`). Previous images stay for rollback. Estimated 5 minutes, no downtime, risk low. The capture image is **not** rebuilt.

### 11.6 Execution steps
| # | Step | PASS |
|---|---|---|
| E0 | Backup again (`twins-backup`) and pin it; announce | status ok |
| E1 | `stop api worker` (relay, postgres, redis, capture keep running; scheduler and bot stay stopped) | stopped |
| E2 | Copy `staging.env` to `*.pre-main-<sha8>-<stamp>`; set `TWINS_IMAGE_TAG` and `TWINS_BOT_IMAGE_TAG` to the new tag; leave `TWINS_CAPTURE_IMAGE_TAG=capture-2762179-1ad16990`; compose file only if PB3 showed a difference | `compose config` valid |
| E3 | `... --profile migrate run --rm migrate` | "migrations applied"; count **30** (it applies only 0029; under 1 second of work) |
| E4 | `verify-migrations.mjs` in the new image | passes; includes the 0029 check |
| E5 | Re-apply `app-role.sql` and `approval-bot-role.sql` as the owner | success; exact privileges: `twins_app` SELECT true and INSERT / UPDATE / DELETE false on `orders`, `fills`, `positions`; all Deploy 1 expectations unchanged (agent tables read-only, `agent_engine_state` select only, no access to `agent_engine_state_events` and `audit_chain_heads`, no INSERT on `risk_approvals`, EXECUTE on the research functions and the approval door); `twins_bot` no privilege on the three tables |
| E6 | `audit-verify --require-ddl-watch`, then the scheduled unit (`systemctl start twins-audit-verify.service`) | PASS, 32 chains, status file `ok:true` |
| E7 | `up -d --no-deps alert-relay`, then `api`, then `worker`; `--profile bot create approval-bot` (created, not started) | relay and api healthy; worker running; no `agent_engine.config.invalid`; restarts 0; no exit 81 / 82 |

Downtime for `api` and `worker`: about 2-4 minutes (they were stopped for about 70 seconds in Deploy 1). Risk: low (a metadata-only migration; the previous image and a minutes-old backup are at hand).

### 11.7 Post-deploy verification (all must pass)
| # | Check | PASS |
|---|---|---|
| V1 | Migrations | **30**; `verify-migrations` passes |
| V2 | Audit chain | scheduled unit run exits 0, `ok:true`, `first_failure` null, 32 chains; the next hourly run also passes |
| V3 | Safety posture | `TRADING_ENABLED=false`, kill switch false, intake true; `LIVE_TRADING=false`, `TRADING_MODE=paper` in api / worker; `agent_engine_state.enabled=false`; `TWINS_AGENT_ENGINE_ENABLED` unset; `TWINS_BOT_ACTIVE` not true |
| V4 | Health | `/health` 200; `/health/status` ok with fresh backup and audit-verify timestamps |
| V5 | Roles | E5 privilege list re-run; plus a rolled-back probe as `twins_app`: `insert into orders default values` fails with SQLSTATE 42501 (and the same for `fills`, `positions`; `select` succeeds) |
| V6 | Intake | a new live message goes PENDING -> COMPLETED on the new image, dead-letter count unchanged (see K1: the existing dead letter stays until replayed) |
| V7 | Nothing forbidden created | `risk_approval_cards`, `risk_approvals`, `orders`, `fills`, `positions`, `agent_orchestrator_runs` all 0 (`risk_decisions` may grow with new messages) |
| V8 | Alerts | host `--test` INFO delivered through the relay; no restart-loop alert |
| V9 | Timers | backup, audit-verify, backup-verify timers active; no failed unit |
| V10 | Containers | api, worker, relay on the new tag; bot created, not running; scheduler stopped; capture unchanged (restarts 0, same image) |
| V11 | **Kite refused by default** | (a) the tree and `staging.env` checks from PB4 re-run on the deployed image / file; (b) a throwaway container from the new image with `--network none`, `--read-only`, no database and no Kite variable runs the probe below and prints the exact results: market data on the default plan refused with `PLAN_RESTRICTED`, order / GTT / holdings-authorise paths refused with `NOT_ALLOWED`, the fake `fetch` call count stays 0 for every refused call, a `connect` plan still refuses order paths |

Probe for V11(b) (nothing here can reach the network: the transport is a counting stub):
```
node --import tsx -e '
import { KiteClient, Session, RateLimiter } from "/app/packages/kite/src/index.ts";
let calls = 0; const fake = async () => { calls += 1; return new Response("{}"); };
const mk = (plan) => { const s = new Session(); s.setToken("probe_token_0123456789abcdef"); return new KiteClient({ apiKey: "probekey1234", session: s, fetch: fake, ...(plan ? { plan } : {}) }); };
const code = async (f) => { try { await f(); return "ok"; } catch (e) { return e.code ?? e.name; } };
const dflt = mk(), conn = mk("connect");
console.log(JSON.stringify({
  default_quote: await code(() => dflt.getJson("/quote/ltp", { i: "NSE:INFY" })),
  default_historical: await code(() => dflt.getJson("/instruments/historical/1/day")),
  order_path: await code(() => conn.getAccountJson("/orders/regular")),
  gtt_write_path: await code(() => conn.getJson("/gtt/triggers")),
  holdings_authorise: await code(() => conn.getAccountJson("/portfolio/holdings/authorise")),
  fake_fetch_calls_after_refusals: calls }));'
```
(Expected: `PLAN_RESTRICTED`, `PLAN_RESTRICTED`, `NOT_ALLOWED`, `NOT_ALLOWED`, `NOT_ALLOWED`, `0`. The probe is part of the plan, not a repository file; if its output differs the deploy is not declared successful.)

### 11.8 Known issues to decide before executing
* **K1 (FIXED in code, D-081; ships with Deploy 2): a live message dead-lettered in the new risk flow.** *Status 2026-11-03: `positiveOrNull` in `packages/risk/src/pending.ts` records a non-positive level as absent and keeps the decision PENDING; regression tests added; Deploy 2 is built from a commit that contains the fix, and the PB8 rehearsal must prove it (11.12). Original finding:* Evidence (read-only, 2026-11-03): outbox row for source message 29089 reached `DEAD_LETTER` at 05:31 UTC after 8 attempts, each failing in the worker with `RiskDecisionError` (`invalid_input`). The message itself was ingested (attempt 1: `inserted 1`) and its options claim was stored. The claim's stop-loss was parsed as **0**, so the stop-loss validation is `INVALID` / `INVALID_STOP_LOSS`; `packages/risk/src/pending.ts` passes the claim's own `stopLoss` (0) to the decision input when the validation is not VALID (lines for the claim path and the signal path), and `riskDecisions.ts` rejects a non-positive stop-loss. The result is a thrown error that is retried instead of a recorded PENDING decision. **Safety was not affected** (fail closed: no decision, card or approval), but each such message costs 8 retries, a dead letter and a CRITICAL alert. Recommendation: fix first (treat a non-positive stop-loss as absent, record the PENDING decision with the invalid-stop reason, add a regression test), merge, and build Deploy 2 from the fix commit; then replay the dead letter once with `outbox-deadletter replay --id <outbox-id> --reason "..." --changed-by operator:<name>` (owner credential; it re-opens exactly that row, and downstream processing is idempotent). Without the fix Deploy 2 is still safe, but the same defect will dead-letter every message with a zero or negative stop-loss.
* **K2:** the capture-gap detector exists (code) but no host job runs it: a silent capture client is still not alerted. Out of scope for Deploy 2; schedule it in a later task.
* **K3:** the Kite plan has no environment loader (11.3). Documentation corrected; implement the loader in the wiring task.
* **K4:** the approval bot stays stopped; its restart-loop decision (D1) is unchanged.

### 11.9 Rollback for Deploy 2
Migration 0029 has no down script and needs none: it only removes privileges, old code never wrote the execution tables, and the schema is otherwise identical to 29 migrations.
* **Level 1, code only (preferred).** Stop `api worker alert-relay`; restore `staging.env` from the `*.pre-main-<sha8>-*` copy (tags back to `main-ef833e48`); `up -d alert-relay api worker`. The previous image `main-ef833e48` stays on the host. **Verify:** images are the old tag; `/health/status` ok; safety state unchanged; a probe as `twins_app` still cannot insert into `orders` (0029 stays applied, which is the safer state); the old image's `audit-verify` PASS (it contains the verifier fix); `verify-migrations` of the **old** image must be pointed at expectation 29 and would report 30 recorded: that mismatch is expected and is not a failure of the rollback.
* **Level 2, restore.** Only for data-integrity doubt: restore the E0 backup (minutes old) into a scratch database, check counts (29 migrations, expected message count, chain heads equal to PB6), then the rename swap of section 6.3, then Level 1. After the swap the migration count is 29 and 0029 is gone together with its privilege change; re-run the **old** `app-role.sql` is NOT needed (the restored database carries its grants, which then include the old, wider ones: re-apply the new `app-role.sql` to keep the execution tables read-only).
* **Decision table additions:** 0029 fails (it cannot, apart from a lost connection): the transaction rolls back, count stays 29, start the old services again. E5 shows `twins_app` still writable: re-run `app-role.sql` and the migration's `DO` block is not repeatable by hand, so re-run the migration command; if it still fails, do not start the services. V11 output differs: hold; do not declare success.

### 11.10 Acceptance
Deploy 2 is successful only if: the deployed commit is the approved one with green hosted CI and a verified manifest; 30 migrations and `verify-migrations` pass; the scheduled audit run passes with 32 chains; `twins_app` and `twins_bot` cannot write `orders`, `fills`, `positions`; all other privileges equal the Deploy 1 list; safety flags and engine flag unchanged; services healthy on the new tag and capture untouched; zero cards, approvals, orders, fills, positions and agent runs; V11 shows Kite refused by default; alert delivery proven; `deployments.jsonl` and a deploy report committed. Estimated total 1-1.5 hours, user-visible downtime 2-4 minutes, overall risk low (medium only if the K1 fix ships in the same deploy, because it is code that touches the live risk flow).

### 11.11 Questions for the owner
* **QB1** Ship the K1 fix first (recommended) or deploy 0029 and Kite now and fix K1 afterwards?
* **QB2** Maintenance window (the channel is quiet; the last live traffic was 2026-11-03 05:20 UTC).
* **QB3** After the fix, replay the one dead-lettered message?
* **QB4** Approve PB8 (a second scratch-database rehearsal on the staging Postgres)?

## 12. Deploy 1 (executed 2026-11-01): deviations from Part A
* A scratch-database rehearsal (P7) was run first: migrations 0014-0028 applied in 8 seconds, verifier and role checks passed, the fail-closed worker behaviour and both rollback levels were exercised.
* Host alerting had no destination (found in P10): fixed first through the loopback relay (PR #50), `alert.env` gained the relay URL and bearer; delivery proven with INFO and CRITICAL tests.
* `staging.env`: the capture tag was aligned to the running image, the app and bot tags were set to `main-ef833e48`.
* The scheduler had been started during the P0 recovery and was stopped as part of the deploy; the approval bot was recreated on the new image and left stopped (decision D1 option A).
* Measured: migrations 8 s, api / worker downtime about 70 s, every V check passed; V6 (live capture) was first closed on the history path and later on live traffic.
* The `risk-control` compose service was added; no `agent-engine-control` service exists yet.

### 11.12 Rehearsal additions for the K1 fix (PB8)
In addition to the 0029 checks, the scratch rehearsal restores the **current** staging backup (which already holds the dead-lettered message and its claim) and, with the new image against the scratch copy: (1) replays the dead-lettered row's decision path (`createPendingRiskDecisionForOptionsClaim` for that claim, as `twins_app`) and shows a PENDING decision with `stop_loss_invalid` and no thrown error; (2) runs the old image's code path (the `main-ef833e48` image) for the same claim to show it still throws (control); (3) repeats the earlier fail-closed replay over all stored claims and confirms zero cards, approvals, orders, fills, positions and agent runs. The real replay of the dead letter happens only after the real deploy (`outbox-deadletter replay --id ... --reason ... --changed-by operator:<name>`).

## 13. Deploy 3 (executed 2026-11-03): replay job-id fix, no migration
Source `7913f3d` (image `main-7913f3d7`), no schema change (30 migrations before and after). Order: real-queue verification of the fix on the NEW image against a scratch database and a throwaway Redis (first run -> dead letter -> replay -> job id `outbox-<id>-r1-0` -> COMPLETED; the old job `-0` stayed in the completed set and did not collide), fresh verified backup (the fixed script), `staging.env` tags, then `worker`, `api`, `alert-relay` recreated one after the other (about 45 seconds in total; capture untouched; bot created, not started). V1-V11 as in 11.7 plus the capture-gap timer and the relay journal records: all passed. The replay of a dead letter now needs no manual queue cleanup (HB-23 closed in production by this deploy).

## 14. Deploy 4 (PREPARED 2026-11-04, NOT executed): the Kite feed code
Prepared, not deployed: image `twins-staging:main-91f9b75f` (source `91f9b75`, manifest verified, built on the host; smoke-tested with no network: `kite-ticker check-config` exits 4 with no token, `kite-login status` says missing, `LIVE_TRADING=true` is refused with exit 81). Host prerequisites done: `/var/lib/twins-kite` and `/var/lib/twins-snapshots` (uid 1000, 0700); `kite.env` (0600) holding only `TWINS_KITE_PLAN=connect`; egress allow-list applied and accepted (KITE_EGRESS_ALLOWLIST_DESIGN.md section 8). The compose file to install differs from the host's by exactly the `kite-login` and `kite-ticker` services and the `twins_kite_egress` network.
Execution (needs the owner's go-ahead): backup; install the compose file; set `TWINS_IMAGE_TAG` and `TWINS_BOT_IMAGE_TAG` to `main-91f9b75f`; recreate `worker`, `api`, `alert-relay` (no migration; about 45 s as in Deploy 3); bot stays created-not-started; neither Kite service is started; V1-V11 and V12/V13 as in Deploy 3, plus: `docker compose ... --profile ops run --rm kite-login status` reports a missing token and makes no network call. The owner adds `TWINS_KITE_API_KEY` / `TWINS_KITE_API_SECRET` to `kite.env` privately (hidden input on the host). The first login (`kite-login url`, then `exchange` with the request token on stdin = ONE live call) and the first bounded feed run are separate go-aheads.


## 15. Post-feed-run additions (2026-11-05): ticker stop, health probe, V6/V12/V13
* **Exit 137 of the first good feed run (root cause).** SIGTERM only set a flag; the loop checks it between cycles, and the inter-cycle sleep was one plain timer of the whole export interval (60 s). `docker stop` waits 20 s (`stop_grace_period`), so a stop in the middle of an interval was killed (137); the earlier run exited 0 only because the signal happened to land near a cycle boundary. A cycle itself (publish) is never interrupted: a stop arriving during a publish waits for that publish, which is bounded and all-or-nothing. **Fix:** `sleepUnlessStopped` (polls the stop flag every 250 ms) replaces the plain timer; the process now exits within a fraction of a second of an idle SIGTERM, or after the cycle in flight. A `ticker.summary` line (the stats, counts only) is logged on exit and `ticker.ticks_accepted` (count only) every 100 accepted ticks.
* **Health probe "Node fetch error" (environmental, not a code fault).** The probe in the run report targeted port 3000; the API listens on **4000** (`PORT=4000`), so the connection was refused. `GET /health` on 4000 returns 200 (`liveTradingEnabled:false`); `GET /health/status` returns 401 without the API key, as designed. Use `docker exec twins-staging-api-1 node -e "fetch('http://127.0.0.1:4000/health')..."`.
* **V6, V12 and V13 as read-only checks** (V12 and V13 were only named, never defined, in Part B):

| ID | Check | Pass criteria |
|---|---|---|
| V6 | Intake outbox (read-only form of the live-message check) | `telegram_intake_outbox`: no `PENDING`, `PROCESSING` (none locked > 10 min), `FAILED` or `DEAD_LETTER` rows; `max(completed_at)` is later than the deploy time (a live message completed on the new image) |
| V12 | Kite isolation while the feed is OFF | no Kite container running; token file mode 0600, regular file, owned by uid 1000, directory 0700; the access token appears in 0 journal lines (last 3 h), 0 container logs and 0 snapshot files; `twins-kite-egress.sh status` OK; no `TWINS_AGENT_ENGINE_ENABLED` line in `staging.env`; API `/health` reports `liveTradingEnabled:false` |
| V13 | Snapshot generation integrity | `.snapshot-generation.json` has `status: complete`; all six kinds (`instrument-reference`, `ohlc`, `last-price`, `quotes`, `option-quotes`, `option-chain`) present, valid JSON, mode 0600; no lock files in the snapshot directory |

Results on 2026-11-05 after the feed run (image `main-f1b3c22b`): V6 pass (91 COMPLETED, 0 other, last completion 06:08Z, after the deploy); V12 pass (all items); V13 pass (generation `kite-20261105055750`, complete, 6 kinds, 0600, no lock). V11 (probe on the previous image) passed earlier the same day.
