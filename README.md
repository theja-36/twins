# TWINS

Multi-source AI-assisted market analysis, signal validation, risk management,
and trading execution platform.

The full engineering specification lives in `docs/SPECIFICATION.md` and is the
source of truth for architecture, phase sequencing, and safety rules. If any
code or convenience conflicts with it, stop and flag the conflict rather than
silently deviating.

## Status

Phase 1 (Foundation) — repository scaffolding only. No data ingestion, no AI
integration, no broker connectivity, no trading logic yet.

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
