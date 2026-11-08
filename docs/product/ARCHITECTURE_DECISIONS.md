# Architecture decisions (Master Build)

Format: ID, date, decision, reason, consequences. Changes to an accepted decision need a new entry, not an edit.

## ADR-001 (2026-11-08) The Master Specification is the product source of truth
Module numbering follows `docs/product/TWINS_MASTER_SPEC.md`. The Phase 00 audit is a baseline only; the repository wins on any difference (see BASELINE_PRESERVATION_MAP.md).

## ADR-002 Extend, do not duplicate
New concepts reuse existing tables where they fit (`risk_decisions`, `paper_*`, `users`, `accounts`, `broker_connections`, `orders`, `fills`, `positions`). A new table needs a recorded reason in DATABASE_CHANGE_LOG.md.

## ADR-003 Authentication and authorisation
- **Identity:** `users` (existing). Passwords hashed with Node's built-in `scrypt` (no new dependency). Sessions are opaque random tokens stored only as SHA-256 hashes (`user_sessions`), short-lived, revocable.
- **Principals:** a request carries a `Principal`: `user` (id + roles `ADMIN` | `TRADER`) or `system` (named service). The existing shared bearer key becomes the `system` principal used by the frontend proxy only until Stage 09 moves it to user sessions.
- **Roles:** `TRADER` owns private data. `ADMIN` can manage users and read audit but is explicitly DENIED private capital, broker details, orders and positions of other users (Part 4 of the spec).
- **Three enforcement layers:** API (a principal is required on every route), service (`authorize()` / `requireOwner()` from `@twins/types`), and database (row-level security on user-private tables keyed by `current_setting('twins.user_id')`, forced for the runtime role). The frontend is never the only barrier.
- **System actors** (worker, scheduler, approval bot) use separate DB roles; they act for a user only through an explicit `userId` on the job envelope.

## ADR-004 Execution modes and safety boundaries
Three separate modes: `PAPER`, `ASSISTED_LIVE`, `CONTROLLED_AUTO`. Live modes are denied unless every one of: the operator-level live switch (default off, and the existing `LIVE_TRADING` guard still refuses any live configuration), the user's own permission for that mode, a valid per-order user confirmation (assisted) or a policy reference (auto), no active kill switch, and a fresh risk re-check. This is a pure function (`checkExecutionGate`) so it can be tested exhaustively. Nothing in the master build enables live trading.

## ADR-005 AI layer
`AIProvider` stays the vendor-neutral contract. Model output is `Untrusted` and can only enter the system through a structured-output validator; it can never reach sizing, risk limits, permissions or execution. Usage, cost and provenance are recorded per call. No LLM provider is connected before the integrations stage.

## ADR-006 Events and jobs
Every domain event uses one envelope (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`, `userId | null`). `userId` is `null` only for shared platform intelligence. Delivery uses the existing durable outbox and BullMQ queues; jobs carry the same correlation id and an idempotency key built from the event.

## ADR-007 Development fixtures
Until integrations, simulated data comes only from clearly named fixture providers that report `source: "FIXTURE"`; results derived from fixtures are labelled and never mixed into real or live performance. A fixture provider is never a production default.

## ADR-008 Migrations without a local database
Migrations are hand-written SQL plus the drizzle journal, additive only (no drops or rewrites of existing data). With no Postgres available locally they cannot be applied here; they stay IMPLEMENTED, never VERIFIED, until the integration suite runs against them in CI.

## ADR-009 Decision vocabulary
Decision outcome (assessment) and workflow state (lifecycle) are separate columns/concepts, per the spec. Legacy `risk_decisions.status` values map onto workflow states (`APPROVED_FOR_REVIEW` -> `PENDING` with an eligibility flag; `APPROVED` exists only once a human approval is recorded).

## ADR-010 (2026-11-08) Safety allow-list extension for the decision vocabulary
`tests/unit/safety/stopLossCoverage.test.ts` allow-lists every file that names an approval-class state. Two new master-build files name QUALIFIED: `packages/types/src/platform/decision.ts` (vocabulary and state machine only) and `packages/types/src/platform/execution.ts` (the gate only consumes the outcome). Both were added to the allow-list with their reasons. They produce no decision and approve nothing. The producer remains `decide.ts` behind `assertStopLossAllowsEligibility`; when the Stage 07 engine begins to emit QUALIFIED it must route through the same mandatory-stop rule and extend the database invariant first, as the test instructs. Flagged for owner review because it touches a safety test.
(ADR-010 addendum, 2026-11-08) `packages/database/src/schema/userDecisions.ts` is also allow-listed: it holds the CHECK vocabulary for `user_decisions.outcome` and the constraint `APPROVED => QUALIFIED`.

## ADR-011 (2026-11-08) Per-user decisions beside the immutable chain
`risk_decisions` is hash-chained and immutable, so the spec's outcome (QUALIFIED/WAIT/REJECT/EVALUATION_ONLY/NO_TRADE) and workflow state live in a NEW table `user_decisions` (private, row-level secured), linked to the chained row through `risk_decision_id` when a decision came through the existing flow. The chain, its triggers and its API are untouched. Existing `orders/fills/positions` already hang off `accounts` (which pin user and trading mode) and are reused unchanged in Stage 02; their row-level policies need an account join and are scheduled for Stage 07.

## ADR-012 (2026-11-08) Database-level execution lock
`user_execution_permissions` has a CHECK that refuses to record `ASSISTED_LIVE` or `CONTROLLED_AUTO` as enabled. This is defence in depth beside `checkExecutionGate`. Lifting it needs a deliberate new migration after the broker, security, legal and regulatory gates are verified; nothing in the master build does that.

(ADR-011 addendum, 2026-11-08) Review hardening: `user_decisions` is guarded by a trigger and owner-tied foreign keys; a QUALIFIED row cannot be created for a candidate without a positive stop-loss (a floor beneath, not instead of, the `@twins/stop-loss` rule). `tests/unit/safety/qualifiedProducers.test.ts` proves the three ADR-010 files cannot produce a QUALIFIED decision.
