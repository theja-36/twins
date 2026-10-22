# Telegram intake guards - staging deployment plan (PREPARED ONLY, nothing executed)

Status 2026-10-22: local preparation done. No VPS access, build, pull, recreation, Telegram call, registration, migration, commit or push has happened. Every step below needs its own approval. `LIVE_TRADING=false`; F1/R0B open; backups paused.

## 1. What is being deployed
Local code + config (all tested: unit 679+, integration 170 passed / 5 skipped against the guarded local rehearsal target):
- API and worker enforce `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` (empty = no chat approved) and options-only mode (`TWINS_TELEGRAM_OPTIONS_ONLY`).
- `infrastructure/staging/docker-compose.staging.yml`: both variables passed explicitly to **api and worker only**; allowlist `${...:-}` (empty by default), options-only the literal `"true"`; build context `../../src`; all four app services use `twins-staging:${TWINS_IMAGE_TAG:-local}`.
- Preserved and covered by tests: API's unique `twins-staging-postgres-1`/`twins-staging-redis-1` hostnames; only the API joins `coolify`; Traefik routes `Path(/health)` only (no webhook, no bearer route); loopback publish `127.0.0.1:${TWINS_API_HOST_PORT:-4110}`.
- No schema change, **no migration** (7 migrations; the staging database is already at 7).

## 2. Working-tree build vs Git checkpoint (important)
- HEAD is `b2ad592`. It does **not** contain what is deployed: 38 files in the build set are modified-tracked and 38 are **untracked but required** (`modified-tracked-files.txt`, `untracked-required-files.txt` in this folder; e.g. `adapters/telegram/src/intakePolicy.ts`, `services/worker/src/{correlationLog,jobErrors,jobTimestamp}.ts`, `packages/database` additions, `scripts/options-*.ts`).
- The image would therefore be built from the **working tree**, identified only by `source-manifest.20261022.sha256` (195 files; manifest sha256 `1495a3ba42dfb6e83831ca6d1478dcace12f28ebe49b9c7d9b6c867c08737559`). Any later edit changes this identity - regenerate the manifest and repeat verification.
- Reproducibility improves only after a **Git checkpoint** (a commit, and ideally a tag, of exactly these files): a separate approval; it is not done here. Until then, "what is running" = this manifest, not a commit.
- Manifest contents: the exact set the Dockerfile copies (`apps services packages adapters scripts`, `package.json`, `package-lock.json`, `tsconfig*.json`) plus `.dockerignore` and `infrastructure/staging/Dockerfile`. Excluded: `node_modules`, `dist`, `*.tsbuildinfo`, logs, `.DS_Store`, any `.env*`/`*.env`, `data`, `docs`, `tests`. It contains no secret-like file names (checked).

## 3. Downloads and pulls the build will need (none done yet)
- **Base image: no pull needed** if `node:22-bookworm-slim@sha256:c3de60bf2f9d...` is still in the host's image store (it was pulled there on 2026-10-21). Pre-check read-only: `docker image inspect <that digest>`. Build with `--pull=false`; if the check fails, stop and ask (a pull would be a new approval).
- **npm registry access: required** by `npm ci --include=dev` (424 packages per `package-lock.json`, deterministic from the lockfile). The build container needs outbound HTTPS to the npm registry; the running stack does not.
- postgres/redis images are unchanged and digest-pinned; not touched.

## 4. Unique tag, nothing overwritten
`TAG=tg-intake-1495a3ba4` (= `twins-staging:tg-intake-1495a3ba4`, from the first 9 hex of the manifest hash). The running image `twins-staging:local` keeps its tag and content; it is the rollback target. Compose has `pull_policy: never`, so a mistyped/missing tag fails instead of pulling.

## 5. Later steps (each separately approved)
0. **Read-only VPS inspection**: current `src` state, free disk (>= 3 GB), base image present, running image id of `twins-staging:local`, queues idle, DB checkpoint recorded, migration count 7.
1. **Ship source** from the Mac: `COPYFILE_DISABLE=1 tar -czf - -T <(awk '{print $2}' source-manifest.20261022.sha256) | ssh <alias> 'mkdir -p /opt/twins-staging/src-$TAG && tar -xzf - -C /opt/twins-staging/src-$TAG'`, copy the manifest alongside, then on the host `cd src-$TAG && sha256sum -c source-manifest.20261022.sha256` (195 OK, nothing extra). Never overwrite the existing `src` directory.
2. **Build** (needs approval for registry access): `cd /opt/twins-staging/src-$TAG && docker build --pull=false -f infrastructure/staging/Dockerfile -t twins-staging:$TAG .`. Then read-only image checks (`docker image inspect`, file presence). Optional smoke: `docker run --rm --network none ... node --import tsx -e '<load policy with allowlist "*">'` must throw (a throwaway container, own approval).
3. **Config**: back up (unique names) `docker-compose.staging.yml`, `staging-config.sha256`, `staging.env`; install the new compose file; add the non-secret line `TWINS_IMAGE_TAG=$TAG` to `staging.env` (so later compose runs keep using it); refresh the config hash manifest; `docker compose config -q` with output suppressed. `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` is **not** added: empty by default.
4. **Apply**: confirm queues idle, then `docker compose ... up -d --no-deps --no-build --pull never api worker` (redis/postgres untouched; no migrate/scheduler). Expected downtime: seconds.
5. **Verify**: both containers run image `twins-staging:$TAG`; in both, `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` empty and `TWINS_TELEGRAM_OPTIONS_ONLY=true`, `LIVE_TRADING=false`; API on the unique hostnames and connected to the TWINS destinations only; no auth/restart errors; loopback /health 200, no/wrong token 401, retained-message lookup 200, unknown id 404; database checkpoint and queue counts unchanged; Mac-origin HTTPS /health 200 with a valid certificate, HTTP 301, every other path 503. An optional loopback POST of an update from an unapproved chat (expects HTTP 200 `ignored`, no job) needs the webhook secret and its own approval.
6. **Rollback** (any failure or on request): set `TWINS_IMAGE_TAG=local` (or remove the line), restore the backed-up compose file and hash manifest, `up -d --no-deps --no-build --pull never api worker`. `twins-staging:local` is still present, no data was changed, no migration to reverse. Do not delete the new image or `src-$TAG` until told.

## 6. Still NOT part of this plan (separate approvals, in order)
approved numeric test-chat id into `staging.env` (+ recreate api/worker); Traefik route for `POST /webhooks/telegram` only (rate limit, body cap, IP allowlist question); webhook secret handoff; bot creation/registration by the owner; Git checkpoint; compose build-context use on the host (until then builds are done by hand as in step 2).
