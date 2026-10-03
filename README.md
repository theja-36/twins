# TWINS

Multi-source AI-assisted market analysis, signal validation, risk management,
and trading execution platform.

The full engineering specification lives in `docs/SPECIFICATION.md` and is the
source of truth for architecture, phase sequencing, and safety rules. If any
code or convenience conflicts with it, stop and flag the conflict rather than
silently deviating.

## Status

Phase 9 (Decision Intelligence Engine) complete. Repository scaffolding
(Phase 1), a PostgreSQL/Drizzle domain model (Phase 2), provider-independent
contracts (Phase 3), an ingestion framework (Phase 4), a deterministic
data-quality engine (Phase 5), a deterministic signal intelligence engine
(Phase 6), a deterministic entity/event intelligence layer (Phase 7), a
Phase 8 orchestrator composing Phase 6+7 into one evidence-backed report,
and now `packages/decision-intelligence` (Phase 9): a fully deterministic
(no AI/LLM) pipeline that validates a signal's own structure, builds an
independent bull thesis and bear thesis from Phase 8's evidence, derives
a counter-thesis, and reaches one of three auditable outcomes -
APPROVE / REJECT / INSUFFICIENT_EVIDENCE - persisted to a new
`signal_validations` table. Confidence is explicitly documented as
"confidence the evidence supports this outcome," never a probability of
profit. Source reliability is always UNKNOWN - no fabricated trust
scores. This produces a candidate decision only: no position sizing, no
orders, no trade direction, no execution. No concrete vendor adapters
are wired in. No Decision/Risk Engine, backtesting, or UI yet.

## Structure

- `apps/web`, `apps/api` — frontend and API
- `services/worker`, `services/scheduler` — background processing
- `packages/*` — shared domain logic (config, types, database, ai, risk, market, analytics)
- `adapters/*` — external provider adapters (broker, market, news, macro, telegram)
- `tests/*` — unit, integration, e2e, adversarial, failure-scenario tests
- `infrastructure/` — deployment/infra config
- `docs/` — architecture and operational documentation

## Safety

`LIVE_TRADING` defaults to `false` and must be explicitly set. See
`packages/config/src/index.ts` and spec sections 40, 60, 61.

## Setup

```
cp .env.example .env.development
npm install
npm run typecheck
```

## Database

PostgreSQL is the source of record (spec section 47); Redis is never used
for durable authoritative state. Schema lives in `packages/database` as
Drizzle ORM table definitions, grouped by domain area under
`packages/database/src/schema/`.

For local development, run a disposable Postgres instance and point
`DATABASE_URL` at it, e.g.:

```
docker run -d --name twins-postgres \
  -e POSTGRES_USER=twins -e POSTGRES_PASSWORD=twins_dev_password \
  -e POSTGRES_DB=twins_dev -p 15432:5432 postgres:16-alpine

export DATABASE_URL=postgresql://twins:twins_dev_password@localhost:15432/twins_dev
```

Common commands (run from `packages/database`):

```
npm run db:generate   # generate a migration from schema changes
npm run db:migrate    # apply pending migrations
npm run db:studio     # inspect the database visually
```

Integration tests exercise the schema against a real database:

```
npm run test:integration
```

## Required Environment Variables

The following environment variables must be set for Phase 1 to operate. Add them to your `.env` (or `.env.development`) file:

- `TWINS_API_KEY` – Bearer token required for operator‑facing API endpoints (e.g., `GET /signals/:id/validation`).
- `TELEGRAM_WEBHOOK_SECRET` – Shared secret token that Telegram includes in the `X-Telegram-Bot-Api-Secret-Token` header. Protects the webhook endpoint.
- `TELEGRAM_SIGNAL_EXCHANGE` – Exchange identifier used when parsing symbols from Telegram messages (default `NSE`).
- `TELEGRAM_SIGNAL_INSTRUMENT_TYPE` – Instrument type for Telegram‑derived signals (`equity`, `futures`, …).
- `MARKET_WATCHLIST` – Comma‑separated list of `SYMBOL:EXCHANGE` pairs the market scheduler will fetch. Example: `RELIANCE.NS:NSE,INFY.NS:NSE,TCS.NS:NSE,^NSEI:INDEX`.
- `MARKET_CRON_EXPRESSION` – Cron expression for the market data scheduler (default `"0 4 * * 1-5"` → 09:30 IST weekdays).
- `MARKET_LOOKBACK_DAYS` – Number of days of historical bars to request (default `7`).
- `MARKET_DATA_PROVIDER` – Name of the market data adapter to use (must match a registered provider, e.g., `yahoo-finance`).
- `MARKET_INSTRUMENT_TYPE` – Instrument type for market data (`equity`, `index`, …).

## Local Development Setup

For a quick local environment spin‑up you can use Docker:

```bash
# PostgreSQL
docker run -d --name twins-postgres \
  -e POSTGRES_USER=twins \
  -e POSTGRES_PASSWORD=twins_dev_password \
  -e POSTGRES_DB=twins_dev \
  -p 15432:5432 postgres:16-alpine

# Redis
docker run -d --name twins-redis \
  -p 6379:6379 redis:7-alpine
```

Export the connection URLs before starting the services:

```bash
export DATABASE_URL=postgresql://twins:twins_dev_password@localhost:15432/twins_dev
export REDIS_URL=redis://localhost:6379
```

Run the database migrations (see `packages/database/README.md` for details):

```bash
cd packages/database
npm run db:migrate
```

## Telegram Bot API Webhook Setup

Create a bot via [@BotFather](https://t.me/BotFather) and obtain its token. Then configure the webhook:

```bash
WEBHOOK_URL="https://your.public.host/webhooks/telegram"
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Telegram will now POST updates to the configured URL, including the `X‑Telegram‑Bot‑Api‑Secret‑Token` header for verification.

## Running the Services

```bash
# Install all workspace dependencies
npm install

# API server (Fastify)
npm run dev --workspace=apps/api

# Worker (BullMQ consumer)
npm run dev --workspace=services/worker

# Scheduler (cron‑based market fetcher)
npm run dev --workspace=services/scheduler
```

All three processes share the same `.env` configuration.

## End‑to‑End Test Flow

1. **Start dependencies** – PostgreSQL, Redis (see above) and run migrations.
2. **Start the services** – API, worker, and scheduler in separate terminals.
3. **Send a test Telegram update** (replace values as needed):
   ```bash
   curl -X POST http://localhost:4000/webhooks/telegram \
     -H "Content-Type: application/json" \
     -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
     -d '{
       "update_id": 1,
       "message": {
         "message_id": 1,
         "date": 1700000000,
         "chat": {"id": -1001234567890, "type": "channel", "username": "test_signals"},
         "text": "BUY RELIANCE @ 2800 SL 2750 TGT 2900"
       }
     }'
   ```
4. **Observe the worker logs** – you should see a `validation complete` entry and a new row in `signal_validations`.
5. **Retrieve the validation result** (replace `<SIGNAL_ID>` with the ID stored in the DB):
   ```bash
   curl -H "Authorization: Bearer ${TWINS_API_KEY}" \
        http://localhost:4000/signals/<SIGNAL_ID>/validation
   ```
   The response contains the persisted validation outcome, thesis, counter‑thesis, and evidence references.

Congratulations! You now have a complete real‑time ingestion pipeline from Telegram → market data → deterministic validation.
