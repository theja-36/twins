# Phase 0D - Deploy the Telegram intake guards (PLAN; NOTHING BELOW HAS BEEN EXECUTED)

Supersedes steps 1-2 of `docs/implementation/staging/TELEGRAM_INTAKE_DEPLOYMENT_PLAN.md`: the source now comes from a Git commit, not the working tree.

## 1. What changes at runtime
Exact patch of the build set (baseline `dda8596` -> candidate `1ccfc35`): `INTAKE_GUARDS_BUILD_SET.diff` in this folder (7 files, +244/-21). Behaviour after deployment:
- API and worker read `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` (compose passes `${...:-}` = **empty** => no chat approved) and `TWINS_TELEGRAM_OPTIONS_ONLY` (compose literal `"true"`). A malformed allowlist makes either process refuse to start.
- Webhook (still NOT routed publicly): after the secret check, before normalisation/enqueue, an update from a chat that is not approved gets HTTP 200 `{"status":"ignored","reason":"not accepted"}`, creates no job, and logs only reason/update kind/chat type/chat id.
- Worker: gate 1 (approved chat) before any database access; gate 2 (options-only) classifies the text first and blocks non-options messages before ingestion; a defensive post-check blocks an existing equity signal. Rejected jobs complete (no retry) with no records.
- Unchanged: loopback API auth, `/health`, networks, the unique database/Redis hostnames, the Traefik route (`GET /health` only), no bot, no webhook registration, `LIVE_TRADING=false`, no migration.
Tests behind it (2026-10-22): unit 685/685; integration 170 passed / 5 skipped by design (6 new intake-policy tests ran against the real worker path and database); packaging tests mutation-checked.

## 2. Steps and approvals (each bullet group = one approval request)
**A. Read-only preflight (no approval beyond this plan).** Services healthy, queues idle, record image IDs (api/worker currently `sha256:e41f6a71...`), `twins-staging:tg-intake-1495a3ba4` absent, free disk >= 3 GB, RAM, no other build running.
**B. Restore the pinned base image - needs approval (external download).** `docker pull node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` from Docker Hub (about 75 MB compressed [I]). A digest-addressed pull is content-verified. Confirm afterwards with `docker image inspect` that the digest matches. Nothing else is pulled.
**C. Deliver source from the commit - needs approval (writes a new directory).** On the Mac: `git archive --format=tar 1ccfc354... -- <the 195 manifest paths>` piped over the pinned SSH connection into a NEW directory `/opt/twins-staging/src-tg-intake-1495a3ba4/` (never `/opt/twins-staging/src`); copy the manifest next to it; on the VPS `sha256sum -c` must report 195 OK and the listing must contain nothing else; the manifest's own sha256 must equal `1495a3ba42dfb6e83831ca6d1478dcace12f28ebe49b9c7d9b6c867c08737559`. No `.env`, no `data/`, no `docs/`, no `tests/` enter the context (`.dockerignore` re-checked).
**D. Build - needs approval (npm registry downloads of the 424 locked packages; install scripts of esbuild/msgpackr-extract run; no secrets, SSH keys or tokens are provided to the build).** Run the reviewed watchdog pattern used by the previous build (abort if MemAvailable < 1.5 GiB; 20-minute timeout), but with ONLY the candidate tag:
`docker build --progress=plain --pull=false --ulimit nofile=4096:4096 --label twins.source-manifest-sha256=1495a3ba... --label twins.git-commit=1ccfc354... --label twins.base-image=node@sha256:c3de... -f infrastructure/staging/Dockerfile -t twins-staging:tg-intake-1495a3ba4 .`
**The previous `build.sh` also tagged `twins-staging:local`; this build must not.** Verify afterwards: `twins-staging:local` still `sha256:e41f6a71...`; candidate image id recorded in full; labels present; required runtime files are checked WITHOUT creating or starting a container: `docker save twins-staging:tg-intake-1495a3ba4 | tar -xO` of the layer holding `/app` (or, if you approve a created-but-never-started container, `docker create` + `docker cp`); `intakePolicy.ts`, `correlationLog.ts`, `jobErrors.ts` and `jobTimestamp.ts` hashes equal the manifest.
**E. Install deployment config - needs approval (changes running-service configuration).** Back up (unique names, root 0600): `docker-compose.staging.yml`, `staging-config.sha256`, `staging.env`. Install the compose file from commit `ba6c5fb`/`1ccfc35`; add the non-secret line `TWINS_IMAGE_TAG=tg-intake-1495a3ba4` to `staging.env`; do NOT add `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` (empty by default). Refresh the config hash manifest. `docker compose config -q` with output suppressed.
**F. Recreate API and worker only - needs approval (brief outage, about 10-20 s).** Confirm queues idle, record the database checkpoint, then `docker compose ... up -d --no-deps --no-build --pull never api worker`. PostgreSQL and Redis are not touched; no `migrate`, no `scheduler`.
**G. Verify (read-only plus one loopback request).**
1. Both containers run the candidate image id; env inside them: `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` empty, `TWINS_TELEGRAM_OPTIONS_ONLY=true`, `LIVE_TRADING=false`, `TRADING_MODE=paper`.
2. API/worker connect only to the TWINS Redis/Postgres addresses; no auth errors, 0 restarts; Postgres/Redis unchanged (same container ids and start times).
3. Loopback `GET /health` 200; no/wrong bearer 401; retained-message lookup 200; unknown id 404.
4. **Unauthorized chat IDs rejected:** one loopback `POST 127.0.0.1:4110/webhooks/telegram` with the real webhook secret supplied from `staging.env` via stdin (never printed) and a synthetic update from a clearly fake unapproved chat id (e.g. `-1000000000001`, harmless text). Expected: HTTP 200 `ignored / not accepted`, one `webhook.intake.chat_rejected` log line with that chat id, and NO change in queue counts or database checkpoint. A second request without the secret: 403. These two requests are the only webhook traffic; no valid message is submitted.
5. Optional (separate approval): throwaway container with `--network none` proving a malformed allowlist (`*`) makes the policy loader throw.
6. Database checkpoint (54 lines) identical; queue counts unchanged.
7. Mac-origin, certificate validation ON: `https://twins.theja.tech/health` 200; HTTP -> 301; `/webhooks/telegram` and every other path 503 (still unrouted); no bot or webhook registered (no Telegram call is made by anyone).
**Rollback (any failure, or on request):** set `TWINS_IMAGE_TAG=local` (or remove the line), restore the backed-up compose file and hash manifest, `up -d --no-deps --no-build --pull never api worker`. `twins-staging:local` still exists; no data or schema was changed. The new image and `src-tg-intake-1495a3ba4` are kept (no cleanup) until you say otherwise. If the base-image pull or build fails, nothing running has changed.

## 3. Risks and limits
- Registry or Docker Hub unavailability blocks B/D; the plan stops there.
- npm install scripts run in the build (esbuild, msgpackr-extract verify their prebuilt binaries; a missing prebuilt would fail the build loudly rather than download anything outside the npm registry).
- The image is built from a Git commit but is not independently reviewed code: F1 stays open.
- Verification of the worker gate on the VPS is by the already-run integration tests, not by enqueueing a job there.
- Docker log lines of the 2 test requests remain in container logs (rotated, local).
