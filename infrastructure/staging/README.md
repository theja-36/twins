# TWINS staging packaging (local, prepared only)

Nothing here has been built, pulled, started, deployed or scheduled. `LIVE_TRADING=false` is a literal in the compose file.

## Contents
| File | Purpose |
|---|---|
| `Dockerfile` | One image for api / worker / scheduler / migrate (run through `tsx`; see header for why `node dist` does not work) |
| `docker-compose.staging.yml` | Separate project `twins-staging`: PostgreSQL 16, Redis 7, api, worker, scheduler (profile), migrate (profile) |
| `staging.env.example` | Placeholders only |
| `backup-postgres.sh`, `restore-check-postgres.sh` | Prepared, unscheduled, require `--yes` |
| `../../.dockerignore` | Keeps `.git`, `data/`, `docs/`, env files, tests out of the build context |

## Design facts
- **Isolation:** own project name, own named volumes (`twins_pgdata`, `twins_redisdata`), own PostgreSQL and Redis. `twins_data` is an `internal` network (no internet, no other stacks). Only the API also joins `twins_edge`, solely so Docker can publish `127.0.0.1:${TWINS_API_HOST_PORT:-4110}`. No database/Redis ports are published. Port 4110 was free in the 2026-10-21 listener inventory; re-check before use.
- **Versions:** PostgreSQL 16 / Redis 7 = what CI (`.github/workflows/ci.yml`) and `infrastructure/docker/docker-compose.test.yml` test against. Node 22 (CI matrix 20 and 22). Tags are not digest-pinned.
- **Providers off:** no market/news/macro/broker/AI keys, no `TELEGRAM_BOT_TOKEN`, no webhook registration, `TWINS_OPTIONS_*` unset (no contract master). The worker is on the internal network only, so it cannot reach the internet. The scheduler is a profile that is OFF by default and has `MARKET_WATCHLIST` forced empty (unset would default to a Yahoo watchlist).
- **Migrations:** a one-shot `migrate` service in a profile; never run on `up`. Run only deliberately, after a backup: `docker compose -f infrastructure/staging/docker-compose.staging.yml --env-file infrastructure/staging/staging.env --profile migrate run --rm migrate`. Note: the application services do NOT check the schema version at startup, so starting them before migrating gives runtime errors, not a clear refusal (gap).
- **Limits (assumptions, not measured):** postgres 768 MB/1 CPU, redis 192 MB/0.5, api 384 MB/0.75, worker 512 MB/1, migrate 384 MB/0.5 (transient), scheduler 192 MB/0.25 (off). Default stack caps at about 1.9 GB RAM; typical use is expected well below. Logs: json-file 10 MB x 3 per container. `stop_grace_period` 30 s (60 s for PostgreSQL, SIGINT fast shutdown). Containers run read-only, `cap_drop: ALL`, `no-new-privileges`, non-root user for the app image.
- **Health checks:** postgres (`pg_isready`), redis (`PING` with auth), api (`GET /health`). The worker and scheduler have no HTTP surface and therefore no health check (gap).

## Validation performed locally (no pull, no start, no network)
`docker compose -f infrastructure/staging/docker-compose.staging.yml --env-file infrastructure/staging/staging.env.example config -q` succeeds; omitting a required secret variable makes it fail. The Dockerfile has NOT been built (a build needs the registry and npm).

## Backup and restore (prepared, not scheduled, not executed)
- `bash infrastructure/staging/backup-postgres.sh --yes [dir]` writes a custom-format dump plus `.sha256` into a mode-700 directory.
- `bash infrastructure/staging/restore-check-postgres.sh --yes <dump>` restores into the scratch database `twins_restore_check` only (never the live database) and reports table and migration counts.
- **A backup on the same server is not off-site protection.** Server or disk loss destroys the database and its copy together. No off-site destination exists or is chosen. A restore test has never been run.
- Redis holds queue transport only; it is not backed up.

## Required approvals before any use (none granted)
1. Build the image (registry + npm access) and pin base image digests.
2. Create `staging.env` on the server with new random secrets (never in Git).
3. Start PostgreSQL/Redis, then the explicit one-shot migration.
4. Start api/worker; decide whether and how the loopback API is exposed (Traefik route, domain, DNS).
5. Backup schedule, off-site destination, and a first restore drill.
6. Any provider, Telegram registration, scheduler watchlist or contract-master snapshot.

## Open questions (unresolved)
- **Non-root access:** the `hostinger-agentops` SSH alias was refused (publickey) on 2026-10-21; only the root alias worked. Future actions must not silently fall back to root; a working non-root deploy user (docker group) is needed or root use must be explicitly approved per task.
- **Ollama exposure:** the host inventory showed a listener on `*:11434`. Whether it is reachable from the internet (UFW default policy was not displayed, and `DOCKER-USER` rules do not cover host services) is unverified and should be checked before relying on host firewall assumptions.

## Telegram intake guards (prepared, not deployed)
`TWINS_TELEGRAM_ALLOWED_CHAT_IDS` (empty = approve no chat) and `TWINS_TELEGRAM_OPTIONS_ONLY` (literal `true`) are passed to the API and the worker only. The approved numeric test-chat id is added to `staging.env` later, under separate approval. The `api` build context is `../../src` (host layout `/opt/twins-staging/{infrastructure/staging,src}`); app images are selected by `TWINS_IMAGE_TAG` (default `local`). See `docs/implementation/staging/TELEGRAM_INTAKE_DEPLOYMENT_PLAN.md`.
