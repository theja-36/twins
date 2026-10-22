# TWINS staging image: ONE image used by api, worker, scheduler and the one-shot migrate job (different commands).
#
# Why tsx at runtime: workspace packages expose TypeScript sources ("main": "src/index.ts") with extensionless imports,
# so `node dist/index.js` does not run outside the repo (verified locally: ERR_MODULE_NOT_FOUND). The project is tested and
# run through tsx, so the image installs ALL dependencies (tsx is a devDependency) and starts services with
# `node --import tsx` (node stays PID 1's child via compose `init: true`, so SIGTERM reaches the service's own handler).
#
# Node 22: CI tests Node 20 and 22 (engines ">=20"). Pinned by digest (resolved 2026-10-21 by pulling node:22-bookworm-slim on the staging host;
# Node v22.23.3, image created 2026-10-06). Build (needs registry + npm access, so it is NOT run in this task):
#   docker build -f infrastructure/staging/Dockerfile -t twins-staging:local .
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages
COPY adapters ./adapters
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json ./

# Reproducible install from the lockfile. devDependencies are kept on purpose (tsx).
RUN npm ci --include=dev

# Non-root runtime; code is read-only to the service user.
RUN chown -R root:root /app && chmod -R a-w /app
USER node

# No CMD: compose supplies the command per service, so the image cannot start a service by accident.
