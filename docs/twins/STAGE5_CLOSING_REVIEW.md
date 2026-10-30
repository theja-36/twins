# Stage 5 closing review - the research agent engine

> Written 2026-10-30 at the end of Stage 5 (tasks 1-10). Terminology: "Stage 5" here is the **implementation stage** in the staged build (safety core, intake, risk, historical intelligence, then the agent engine) - not the "Stage 5 - TWINS Telegram approval card" product-pipeline stage named in `TWINS_BUILD_AUDIT_REPORT.md`. Everything below is evidence from the repository at the merge of PR #45 (plus this review); nothing in Stage 5 was deployed, and `LIVE_TRADING=false`, `TWINS_BOT_ACTIVE=false` and `TWINS_AGENT_ENGINE_ENABLED=false` remain the defaults. Companion documents: [HARDENING_BACKLOG.md](HARDENING_BACKLOG.md), [STAGE6_PLAN.md](STAGE6_PLAN.md), [AGENT_ENGINE.md](AGENT_ENGINE.md), decisions D-066 .. D-075 in [DECISION_LOG.md](DECISION_LOG.md).

## 1. Verdict
Stage 5 delivered what it was scoped to deliver: a **deterministic, offline, disabled-by-default research engine** that turns a risk decision into an auditable research assessment (six categories, never an approval), halts the worker flow on a blocked / incomplete / adverse assessment, and - since Task 8 - makes approval eligibility, in the application and inside the database function, refuse the same assessments. It is **not ready to be switched on**: no snapshot exporter, no reviewed provider data, no calibrated thresholds, and the owner confirmations listed in section 11 are all outstanding. The engine can be enabled only by an explicit setting, and with the defaults enabling it would make every decision `INCOMPLETE` (fail closed) until twelve snapshot kinds exist.

## 2. The ten tasks
| # | PR | Scope | Migration | Decision |
| --- | --- | --- | --- | --- |
| 1 | #37 | Agent contract (`agent-contract-v1`), registry, orchestrator (parallel levels, timeouts, retries, failure isolation, frozen inputs), append-only hash-chained persistence (6 tables, chains 27-32), pure synthesis, worker hook after source intelligence and before sizing, engine disabled by default | 0025 | D-066 |
| 2 | #38 | `signal-integrity-v1`, `instrument-verification-v1`; text-free `signal_context`; engine clock; hyphenated agent ids | 0026 | D-067 |
| 3 | #39 | `market-calendar-v1`, `macro-global-v1`; holiday / economic calendar and macro providers | - | D-068 |
| 4 | #40 | `news-sentiment-v1`, `index-constituent-impact-v1`; news / sentiment / constituent / market-data providers | - | D-069 |
| 5 | #41 | `technical-structure-v1`, `price-action-v1`; OHLC and last-price providers | - | D-070 |
| 6 | #42 | `liquidity-v1`, `options-risk-v1`; quote / option-quote / option-chain providers | - | D-071 |
| 7 | #43 | `historical-pattern-v1`, `independent-challenger-v1`; pattern / outcome providers; dependency-ordered challenger | - | D-072 |
| 8 | #44 | `research-synthesis-v2` transparency; approval-eligibility re-check of the research assessment (application layer + database function) | 0027 | D-073 |
| 9 | #45 | Bounded, redacted observability; provider snapshot manager and CLI | - | D-074 |
| 10 | (this) | Closing review, hardening backlog, Stage 6 plan | - | D-075 |
Every task was merged by pull request; hosted CI was green on the merge commit of each (PRs #41-#45 had 14/14 checks; the first main run after PR #39 hit a flaky Task 1 test - a random symbol collision - which was re-run green and fixed in PR #40; PRs #37-#38 are as recorded in their task reports). No history was rewritten.

## 3. The engine (Task 1, extended since)
* **Contract** (`contract.ts`): id, name, version, required / optional inputs from a closed set (`risk_decision`, `source_intelligence`, `stop_loss_validation`, `signal_features`, `signal_context`), closed output schema, timeout, retry, weight 0-100, `canBlock`, `advisoryOnly`, `dependsOn`. A BLOCKING verdict from an agent without `canBlock` fails the run (never a silent downgrade). Confidence is `null` unless COMPLETED. Verdicts: SUPPORTIVE, NEUTRAL, CAUTION, ADVERSE, BLOCKING, UNAVAILABLE.
* **Orchestrator**: levels by dependency, default concurrency 4, per-attempt timeout (cooperative: the result of a timed-out attempt is ignored), failure isolation, inputs deep-frozen per agent, the engine clock (`ctx.now`) instead of the system clock, allow-listed events, redaction of agent text.
* **Synthesis** (pure; `research-synthesis-v2`): rule order unchanged since Task 1 - (1) a COMPLETED BLOCKING verdict from a blocking-capable, non-advisory agent -> `RESEARCH_BLOCKED`; (2) a required agent without a COMPLETED result, or no scoring result -> `RESEARCH_INCOMPLETE`; (3) an ADVERSE verdict from a scoring agent of weight >= 50 -> `RESEARCH_ADVERSE`; (4) the weighted mean against +0.35 / -0.15 / -0.5. v2 adds per-agent summaries, reasons by verdict class, the score arithmetic, the ordered rule evaluation with which rule decided, and a halt reason. `grantsApproval` is the literal `false`; a database check keeps it so.
* **Worker hook**: after source intelligence, before sizing; a halting assessment (default BLOCKED, INCOMPLETE, ADVERSE) leaves the decision PENDING so it can never be sized, gated or approved.
* **Idempotency**: the run key hashes decision, version, agent set, configuration and inputs; the same evaluation returns the stored result without re-running agents (tested in every agent task).

## 4. The twelve agents
All twelve are blocking-capable, none advisory, all run in the first parallel level except the challenger. Defaults are in the rule tables of `rules.ts`; the sentence-level verdict rules are in [AGENT_ENGINE.md](AGENT_ENGINE.md).
| Agent | Weight | Judges (evidence only) | Unavailable (never a pass) when |
| --- | --- | --- | --- |
| `signal-integrity-v1` | 60 | mandatory fields, level coherence, stop-loss validity, signal staleness, revision state | context missing |
| `instrument-verification-v1` | 60 | the contract exists and is listed, expiry, lot size, strike / option type | no instrument reference or contract not found in a covering reference |
| `market-calendar-v1` | 50 | weekends, holidays, session, expiry day, scheduled events | calendar not configured / not covering / failing |
| `macro-global-v1` | 50 | index trend, volatility index, one-day move, gap, breadth, global indices, currency, releases | context missing or older than 24 h |
| `news-sentiment-v1` | 50 | recent news by impact, reliability and direction, aggregate sentiment | no news provider / stale |
| `index-constituent-impact-v1` | 50 | weighted constituent move, concentration, constituent news (index signals only; otherwise NEUTRAL, not applicable) | constituents / market data missing for an index signal |
| `technical-structure-v1` | 50 | trend, swing structure, breakout, support / resistance, averages, momentum, regime, price through the stop | no / short / stale / malformed candles |
| `price-action-v1` | 50 | candle patterns, gaps, runs, volatility expansion, critical reversal | same as technical |
| `liquidity-v1` | 50 | spread, depth, volume, open interest, price sanity | no / stale / crossed / malformed quote |
| `options-risk-v1` | 50 | IV level and change, theta, gamma, vega, delta, strike distance, expiry, premium stop (options only; otherwise NEUTRAL, not applicable) | no option quote / no underlying price / stale |
| `historical-pattern-v1` | 50 | exact Stage 4 pattern keys: Wilson-bounded win rate, expectancy, sample, staleness, regime / volatility similarity | no providers, no matching pattern, insufficient sample, stale |
| `independent-challenger-v1` | 30 | contradictions, unsupported claims, direction / stop / reward-risk coherence, data quality, adverse weight - using only recorded results | **skipped** if any dependency did not COMPLETE |
Confidence is a deterministic function of the verdict (100 / 90 / 85 / 90, NEUTRAL 70), not a probability. No agent calls a model, a broker or a network; none reads message text.

## 5. Provider interfaces
All are injected interfaces with an in-memory and a strict file implementation (`twins-*-v1` JSON, safe file reader: regular `.json` only, no symlink, no credential-like name, size cap; strict parsers reject, never repair). A provider that throws, returns nothing or returns malformed data makes the agent UNAVAILABLE, and the provider's own message is never stored. Fifteen snapshot kinds: holiday calendar, economic calendar, macro context, news, sentiment, index constituents, market data, quotes, option quotes, option chain, OHLC, last price, instrument reference, historical patterns, historical outcomes. Adapters over existing data: the instrument reference and OHLC providers can read the imported historical datasets (equity series only, undated). **No live adapter exists for any provider, and none fetches.**

## 6. Configuration
About 240 distinct `TWINS_AGENT_*` / `TWINS_RESEARCH_*` settings (counted from the code), all strict: a malformed value throws at start-up. Families: engine (`ENABLED`, `REQUIRED`, `DISABLED_AGENTS`, `WEIGHTS`, `MAX_CONCURRENCY`, `HALT_ON`), per-agent thresholds and severities (`SIGNAL_*`, calendar / `MACRO_*`, `NEWS_*`, `CONSTITUENT_*`, `OHLC_*`, `TECH_*`, `PA_*`, `QUOTE_*`, `LIQ_*`, `OPT_*`, `HIST_*`, `CHAL_*`), provider sources (`*_PROVIDER` = `none` | `file:<path>`, default `none`), eligibility (`TWINS_RESEARCH_ELIGIBILITY_*`), observability (`TWINS_AGENT_LOG_LEVEL`) and snapshots (`TWINS_AGENT_SNAPSHOT_*`). Defaults are conservative round numbers and **not calibrated** to any market. When `TWINS_AGENT_ENGINE_REQUIRED` is unset and the engine is enabled, all twelve agents are required.

## 7. Persistence and audit
Migration 0025 adds six append-only, hash-chained tables (chains 27-32): `agent_definitions`, `agent_orchestrator_runs`, `agent_runs`, `agent_findings`, `agent_evidence_references`, `agent_orchestrator_syntheses`. A run is written once, complete, in one transaction after the agents run in memory. Updates, deletes and truncates are refused by `ENABLE ALWAYS` triggers; the synthesis `no_approval` check refuses `grants_approval = true`. 0026 relaxes the agent-id pattern (hyphens); 0027 replaces `twins_record_risk_approval` (Task 8). `audit:verify --require-ddl-watch` and `verify-migrations` cover the chains and the 0027 function (28 migrations). Inputs persisted are parsed fields, tiers and numbers; tests assert a marker text planted in the stored messages never reaches an input, output, finding, evidence reference, synthesis, event or log record (every agent task).

## 8. Approval and eligibility behaviour
* An assessment never grants approval and never bypasses sizing, portfolio, market, breaker, expiry, kill-switch or approval gates.
* **Task 8 (closes D-066 a):** eligibility refuses a latest assessment of BLOCKED / INCOMPLETE / ADVERSE (`research_assessment_blocked|_incomplete|_adverse`), refuses a missing one when the engine is enabled (`research_assessment_missing`, configurable) and fails closed if the store is unreadable (`research_assessment_unavailable`). "Latest" is the most recent run among the versions of the same signal / options claim not newer than the decision, because the engine runs on the version before sizing while the approvable version is newer.
* **Two layers:** the application layer (`assessApprovalEligibility`, `createApprovalCard`, a pre-check in `recordRiskApproval`) carries the configurable policy; `twins_record_risk_approval` (migration 0027) refuses a bad latest assessment at the instant an approval is recorded - the path the Telegram approval bot uses. The database floor is not configurable.
* Engine disabled: unchanged behaviour (no assessment, no extra reason) unless `WHEN_ENGINE_DISABLED=REQUIRE`.

## 9. Observability and snapshots (Task 9)
One structured record per engine run at the default level (`summary`), with status counts, verdict distribution, failed attempts, timeouts, the halt reason code and a compact per-agent list; `agents` / `debug` levels add per-agent and per-attempt records; failures and configuration validation failures are always logged; provider availability is logged once at start-up. Records carry ids, fixed-form codes, counts and durations only. The snapshot manager (`npm run agents:snapshots`) lists / validates / installs the fifteen snapshot kinds with freshness, coverage and missing / malformed / unsafe detection; writes are atomic and need a typed confirmation to replace a file. It fetches nothing and schedules nothing.

## 10. Test coverage (at the merge of PR #45; Task 10 adds none)
* Whole repository: **134 unit test files, 2817 tests**; **62 integration files, 871 passed, 4 skipped** against real PostgreSQL; hosted CI 14/14 on PRs #41-#45.
* Agents unit tests (898 tests in `tests/unit/agents`): contract and orchestrator 104, signal integrity 57, instrument verification 60, calendar and macro 165, news and constituents 116, technical / price action / OHLC 105, liquidity / options / quotes 121, historical / challenger 95, synthesis transparency 17, observability and snapshots 58; plus risk eligibility 21.
* Agents integration tests (119 tests, real PostgreSQL): engine 13, each agent pair 11-15, eligibility 19, observability 10 - parallel execution, blocking halts, fail-closed paths, persistence, audit-chain integrity, idempotency, no marker text, no order / fill / position / card writes, no `fetch`.
* Not covered by tests: behaviour with real provider data, real-time performance with many agents, CPU-bound or hostile agent code, process isolation, the Telegram bot's live callback path against the new refusal codes beyond the function-level test, deployment.

## 11. Open decisions (owner confirmation outstanding)
D-066 (a)-(j) (halt policy, empty engine, advisory agents, thresholds +0.35 / -0.15 / -0.5 and veto weight 50, confidence pulling toward neutral); D-067 (a)-(h) (hyphenated ids, `signal_context`, required-by-default, severities, staleness); D-068 (a)-(h) (sessions as configuration, severities, macro thresholds); D-069 (a)-(h) (news / constituent severities, weights 50 / 50, applicability); D-070 (a)-(j) (OHLC providers, lookbacks, severities, weights 50 / 50, critical reversal ADVERSE); D-071 (a)-(j) (quotes, BLOCKING conditions, thresholds); D-072 (a)-(j) (exact-key patterns, minimum sample 30, weights 50 / 30, challenger BLOCKING conditions and its dependency on every agent); D-073 (a)-(j) (**lineage interpretation of "latest assessment for the decision version"**, non-configurable database floor, missing-case in the application layer only, fixed refusal codes); D-074 (a)-(i) (log levels, snapshot kinds, freshness limits, STRICT default, confirmed atomic writes); D-075 (this review: the backlog and Stage 6 plan are proposals). The owner questions that gate real data remain open: Q-004 (market-data vendor / budget), Q-018 / D-042 (alert destination), Q-002 / D-034 (instrument scope).

## 12. Remaining risks (summary; detail and priority in the backlog)
1. **Approval is not bound to a specific assessment run.** A later, more favourable run on a later version replaces an earlier ADVERSE (HB-01, HB-02).
2. **The database cannot know the engine is enabled**, so a missing assessment is refused only by the application layer (HB-03); the role that evaluates eligibility needs SELECT on the agent tables (HB-04).
3. **All-or-nothing activation:** twelve agents are required by default and the challenger depends on all of them; one missing snapshot halts every decision, and disabling any agent requires disabling the challenger (HB-05, HB-06).
4. **Timeouts are cooperative.** A CPU-bound or hostile agent can block the event loop; agent code changes are not detected (HB-07, HB-08).
5. **Thresholds, weights and indicator parameters are uncalibrated** and a single ADVERSE verdict from a weight >= 50 agent halts the flow (HB-09, HB-10).
6. **No data supply:** no exporter, scheduler or live adapter; providers read files named by settings that are separate from the managed snapshot directory (HB-11, HB-12, HB-13).
7. **Model simplifications:** fixed-offset sessions, no time-of-day volume adjustment, no volatility surface or implied-versus-realised comparison, expiry at a configured clock time with no exchange calendar (HB-14 .. HB-17).
8. **Observability stops at the log:** no alert routing for `agent_engine.*` records (HB-18).
9. **Governance:** the independent security review of the safety-critical code (F1) remains unresolved and is not self-certified here.

## 13. Reuse classification (Stage 5 as a whole)
REUSE_AS_IS: runtime safety state, kill switch, immutable audit chains and verifier, structured logger, safe file reader, Stage 4 pattern keys and Wilson interval, risk decision records, approval card / API / bot plumbing. REUSE_WITH_REFACTOR: approval eligibility and the approval function (Task 8), worker risk flow, rule / config loaders. BUILD_NEW: the engine, twelve agents, fifteen provider formats, synthesis, observability, snapshot manager. REPLACE: the worker's per-event log line (Task 9).
