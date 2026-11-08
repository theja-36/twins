# Stage 00 — Baseline verification and preservation map

Verified 2026-11-08 against the working tree at `main` `507c6f5` (branch `feat/master-build`). The actual repository is the source of truth.

## Verification of the Phase 00 audit
| Audit statement | Verified? | Notes |
|---|---|---|
| 81 tables, 33 migrations (0000-0032) | Yes | 81 distinct `CREATE TABLE`, no `DROP TABLE`; `packages/database/drizzle` holds 33 SQL files |
| 30 API routes + webhook + internal ingest, one shared bearer key | Yes | `apps/api/src/*Api.ts`, `checkBearerToken` in `index.ts`; no rate-limit/CORS code |
| 12 deterministic agents, no LLM | Yes | `PRODUCTION_AGENT_IDS` in `packages/agents/src/agents/index.ts`; `packages/ai` is a registry only |
| Early-skeleton execution tables unused | **Partly** | `users`, `accounts`, `broker_connections`, `orders`, `fills`, `positions`, `portfolio_snapshots` are referenced only by `tests/integration/database.schema.test.ts`. **Correction:** `decisions` IS used (`packages/decision-intelligence`, integration tests), so it is not dead |
| Unit suite 197 files / 3,451 tests pass | Yes (re-run 2026-11-08) | |
| No concrete broker order adapter | Yes | `adapters/broker` = guard wrapper + read-only ports; Kite allow-list is read-only |
| Spec path `docs/product/TWINS_MASTER_SPEC.md` | **Did not exist** | The spec was an untracked file at the repository root; it is now copied to `docs/product/` (root copy untouched) |
| Module numbering | Differs | The spec numbers agents as Module 04 and market intelligence as Module 05; this tracker uses the spec's numbering |

## Preservation map (classification: REUSE / EXTEND / REPLACE (justified) / MISSING)
| Component | Location | Class | Plan |
|---|---|---|---|
| Telegram capture, intake outbox, dedupe, revisions | `services/telegram-capture`, `packages/ingestion`, `adapters/telegram` | REUSE | add channel-management read model (M01) |
| Signal parser v3, options claims | `packages/signals`, `options_claims` | EXTEND | add classification layer (M02) |
| Evidence ledger and audit chains | `packages/audit-chain`, `audit_events`, `signal_evidence` | REUSE | extend evidence kinds for opportunities |
| Historical import, outcomes, scorecards, patterns | `packages/historical`, `historical_*` | EXTEND | feed playbooks and calibration (M03, M06, M07) |
| 12 agents and orchestrator, synthesis, debate, decision card | `packages/agents` | EXTEND | map to spec contracts; add Market Context agent; keep `options-risk-v1` |
| AI layer | `packages/ai`, `packages/types/src/providers/ai.ts` | EXTEND | routing, usage, provenance, structured output (P12) |
| Risk engine (sizing, breakers, correlation, drawdown, exposure, liquidity, market gates, regime, stress, expiry) | `packages/risk` | EXTEND | per-user policies, charges, simulator (M08-M11) |
| Decisions | `risk_decisions`, `packages/risk`, legacy `decisions` | EXTEND | add outcome vocabulary and workflow states; legacy `decisions` stays for `decision-intelligence` |
| Approval bot and cards | `services/approval-bot`, `risk_approval*` | REUSE | add watch action (M13) |
| Paper engine | `packages/paper`, `paper_*` | EXTEND | per-user, mode separation (M13, M14) |
| Kite read-only layer, egress controls | `packages/kite`, `adapters/broker`, `infrastructure/staging` | REUSE | execution adapter only in the integrations stage |
| Runtime state, kill switch, live guard | `packages/runtime-state` | REUSE | add per-market/source/strategy switches (M10) |
| API and OpenAPI | `apps/api` | EXTEND | principals and per-user routes (Stage 01-02) |
| Early-skeleton tables `users`, `accounts`, `broker_connections`, `orders`, `fills`, `positions`, `portfolio_snapshots` | `packages/database/src/schema` | EXTEND | become the per-user spine in Stage 02 (no duplicates) |
| Frontend | separate repo `twins-frontend` | EXTEND | Stage 09 (studio prototype exists, uncommitted) |
| `TWINS_Planning_Pack/` | repo root, untracked | PRESERVE | not touched |

## Unverified / blocked in this environment
- No Postgres or Docker is available locally, so migrations cannot be applied or integration tests run here; CI (on push) is the only verifier, and pushing needs approval.
- Deployed staging state is taken from documents and earlier sessions (no host access used).
