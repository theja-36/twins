# TWINS

Multi-source AI-assisted market analysis, signal validation, risk management,
and trading execution platform.

The full engineering specification lives in `docs/SPECIFICATION.md` and is the
source of truth for architecture, phase sequencing, and safety rules. If any
code or convenience conflicts with it, stop and flag the conflict rather than
silently deviating.

## Status

Phase 8 (Signal Intelligence Engine) complete. Repository scaffolding
(Phase 1), a PostgreSQL/Drizzle domain model (Phase 2), provider-independent
contracts (Phase 3), an ingestion framework (Phase 4), a deterministic
data-quality engine (Phase 5), a deterministic signal intelligence engine
(Phase 6), a deterministic entity/event intelligence layer (Phase 7), and
now a Phase 8 orchestrator (`assembleSignalIntelligence`) that composes
Phase 6 + Phase 7 into one structured, evidence-backed report: a context
window bounding every domain to the signal's own timestamp (no-look-ahead
enforced for market/macro/news, not just events), uniform evidence
normalization across market/macro/news/telegram/event evidence, and
explicit cross-source conflict + staleness surfacing drawn from Phase 5's
quality assessments. No LLM anywhere in this layer, and it makes no
trading decisions - it is an evidence object, not a decision. No concrete
vendor adapters are wired in. No AI reasoning, counter-thesis, decision/
risk engines, execution, backtesting, or UI yet.

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
