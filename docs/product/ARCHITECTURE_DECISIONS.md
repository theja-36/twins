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

## ADR-013 (2026-11-09) Stage 04: research package, AI gateway and Market Context
- **Twelve roles are bound, not rebuilt.** `packages/agents/src/research/specMapping.ts` maps each of the twelve specification roles to the existing agent(s); Calendar & Macro is `market-calendar-v1` + `macro-global-v1`, Research Synthesis is the pure `synthesize` function, Market Context is the new `market-context-v1`. `options-risk-v1` stays registered and scored as an extra specialist. `roleCoverage` reports a missing role or an unmapped agent, so a role cannot disappear silently.
- **Market Context is advisory.** It cannot block and is NOT in `DEFAULT_REQUIRED_AGENTS`: with no regime provider wired it reports UNAVAILABLE (INCOMPLETE in the spec vocabulary) instead of failing the engine closed. A fixture-backed regime is capped at NEUTRAL. Making it required is a deliberate later change once a live regime source exists.
- **The research package is evidence, not a decision.** `buildResearchPackage` carries per-agent spec verdicts (via `toSpecVerdict`), evidence references, agent versions, contradictions, role coverage and a hash, with `grantsApproval: false`. The decision engine keeps its own deterministic gates.
- **One research path for both pipelines.** `ResearchCandidate` mirrors `opportunity_candidates`; `candidateToAgentInputs` produces the same inputs the agents already take. The agents package performs no writes (its guard test stands): `runCandidateResearch` takes an injected sink and the database package supplies `storeResearchPackage`. A candidate has no stop-loss validation yet and is given `null`, never an assumed pass.
- **AI gateway fails closed.** `packages/ai/src/gateway`: provider port (no network in this stage; hosted adapters are Stage 10), fixture provider, prompt registry (versioned, hashed, immutable, refuses variables that could carry message text), routing with fallbacks, bounded retry with backoff, abortable timeouts, error classification, a daily budget that blocks before the call (unknown price or unreadable budget = refuse), and a usage record for every attempt (a record that cannot be stored stops the run). Output leaves only through `parseStructured` as advisory. The gateway imports no database, agent, risk or broker code (pinned by a source test).
- **Usage ledger.** Migration 0035 `ai_usage_records`: append-only, shared-or-owner row-level security, no prompt or response text. Budget is summed over the rows visible in the store's scope.

## ADR-014 — Independent Opportunity Engine (Stage 05, Module 16)
- **Separate package, shared contracts.** `packages/opportunity` holds the engine; it reuses the existing breakout/breakdown/pullback generator (`signals/independent.ts`), the OHLC providers, swing/RSI/candle-pattern helpers, the regime object and `runCandidateResearch`. It has no Telegram, broker, network, order or approval code (a static test pins this) and writes the database only through `packages/database/src/stores/opportunityStore.ts`. A scan produces rows of the SAME `opportunity_candidates` table the Telegram pipeline uses (`source = INDEPENDENT`, origin check unchanged).
- **Scan is pure, the cycle is the only writer.** `runOpportunityScan` takes injected providers and returns drafts plus every skip reason. No universe, no provider, or no usable data is FAILED (never an empty success). Missing/unknown/stale regime is recorded as missing evidence and scored zero; HIGH_VOLATILITY / RISK_OFF suppress candidates for that instrument.
- **Rank is a review order, not confidence.** `opportunity-rank-v1`: explicit factors with points; `confidence: null`, `calibrated: false`, `grantsApproval: false`. Nothing ranks into permission.
- **Stop-loss is a proposal.** The setup's stop is stored with `validated: false`; G-18 stands: the Stage 07 qualification path must run the mandatory stop-loss rule. A candidate without an invalidation level can never be revalidated as valid.
- **Lifecycle lives in the database (migration 0036).** States NEW, IN_RESEARCH, READY_FOR_DECISION, EXPIRED, WITHDRAWN, INVALIDATED, SUPERSEDED. Triggers: start NEW; the thesis (instrument, side, entry, stop, targets, invalidation, expiry, identity) never changes; only legal transitions; finished states are final; ending needs a reason; SUPERSEDED names its successor; every state change writes `opportunity_candidate_events` from the database itself. READY_FOR_DECISION means research finished, not that the candidate is recommended: the package assessment travels with it.
- **Idempotency.** Scans are keyed on (kind, slot) and a FAILED or lease-expired slot is retried; candidates carry a unique dedupe key (instrument, setup, side, timeframe, signal bar, detector version); research claims are `FOR UPDATE SKIP LOCKED`, a failed candidate is not re-claimed in the same run, attempts are bounded, a lost lease is recovered, and a worker cannot resurrect a candidate that was ended while it held it.
- **Dispatch is source-agnostic and resolves the dispatch half of G-17.** Any NEW candidate (either source) is researched through `runCandidateResearch`; the runtime safety check runs first and a refusal stops the batch without using an attempt. Telegram claims are still not materialised as candidates (G-19).
- **Wiring.** Scheduler enqueues one `opportunity_queue` job per cron slot (job id = slot); worker consumes it. Both OFF unless `TWINS_OPPORTUNITY_ENABLED=true`. New scheduler effect `research_intake` is gated by the intake control and kill switch (fail closed) but not by TRADING_ENABLED, because research must run while trading is off. The agents' own gating is untouched (a guard test pins that production agents exist only when the agent engine is enabled); the opportunity providers are loaded separately.
- **Honesty.** Only file/in-memory OHLC and last-price snapshots exist, so every scan is labelled FIXTURE unless the operator declares otherwise; live scanning is NOT operational (G-20).
