# Agent engine: contract, registry and orchestrator (Stage 5 / Task 1)

> Decisions [D-066](DECISION_LOG.md) (engine) and [D-067](DECISION_LOG.md) (first two agents); requirements [RE-10](REQUIREMENTS_TRACEABILITY.md), [RE-11](REQUIREMENTS_TRACEABILITY.md) (new), supports [SZ-10](REQUIREMENTS_TRACEABILITY.md). Builds on [SOURCE_INTELLIGENCE_INTEGRATION.md](SOURCE_INTELLIGENCE_INTEGRATION.md), [RISK_DECISIONS.md](RISK_DECISIONS.md), [RISK_APPROVAL_WORKFLOW.md](RISK_APPROVAL_WORKFLOW.md) and [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/agents/` (`contract.ts`, `registry.ts`, `config.ts`, `orchestrator.ts`, `synthesis.ts`, `record.ts`, `sanitize.ts`), the worker hook in `services/worker/src/index.ts`, migrations `0025_agent_engine`, `0026_agent_id_hyphen`; agents in `packages/agents/src/agents/`.

The **production foundation** for TWINS's multi-agent research, validation and capital-protection engine: a strict agent contract, a registry, an orchestrator that runs agents in dependency order and in parallel with timeouts, retries and failure isolation, append-only persistence of every run, and a deterministic synthesis. **No research agent is implemented** (the production registry is empty), **no LLM or other external API is called**, and the engine is **disabled by default**. It places no order, calls no broker, creates no approval, card, fill, position or risk-decision version, and enables nothing live.

## Agent contract (`agent-contract-v1`)
Every agent declares: `agentId` (lower-case letters, digits, `_` or `-`; e.g. `signal-integrity-v1`), `agentName`, `version` (`major.minor.patch`), `requiredInputs` / `optionalInputs` (from the closed set `risk_decision`, `source_intelligence`, `stop_loss_validation`, `signal_features`, `signal_context` - **parsed fields only; an agent never receives message text**), an `outputSchema` (a closed set of typed output fields: `string`, `number`, `boolean`, `string[]`, `number[]`), `timeoutMs` (50-120000), `retry` (`maxAttempts` 1-5, `backoffMs`), `weight` (0-100), `canBlock`, `advisoryOnly` (never both: an advisory agent can never block) and `dependsOn`. The contract is validated at registration with a fixed error code per rule.

An agent run returns `{ verdict, confidence 0-100, findings, evidence, output }`, which is validated and **sanitized into a new object** (the agent's own object is never kept): findings (`CODE`, severity `INFO..CRITICAL`, summary <= 280 chars, flat scalar detail), evidence references (`kind`, a safe space-free `ref`, optional sha256), an output snapshot restricted to the declared fields (<= 8 KB), secret-shaped text redacted. `BLOCKING` is a contract violation unless the agent `canBlock`. The orchestrator turns this into the recorded **run result**:

| Field | Meaning |
| --- | --- |
| `status` | `COMPLETED`, `FAILED` (error or contract violation after retries), `TIMEOUT` (every attempt timed out), `SKIPPED` (a required input or a dependency was not available - the agent is never run on a guess), `UNAVAILABLE` (the agent said it cannot evaluate) |
| `verdict` | `SUPPORTIVE`, `NEUTRAL`, `CAUTION`, `ADVERSE`, `BLOCKING`; `UNAVAILABLE` for every non-COMPLETED status |
| `confidence` | 0-100 for COMPLETED, otherwise null (an unevaluated run has no confidence) |
| also | `agentId`, `agentVersion`, findings, evidence references, `inputSnapshotRef` (sha256 of the canonical inputs the agent was given), input and output snapshots, `startedAt`, `completedAt`, `durationMs`, `attempts`, `errorCode` / sanitized `errorMessage` |

## Registry
Registers validated agents by id; **one definition per id** (a second registration of the same id - any version - is `DUPLICATE_AGENT_ID`); stored contracts are frozen copies. `resolve(config)` applies the enable / disable configuration and returns a deterministic **dependency ordering** as levels (agents in one level are independent and may run in parallel; ties are ordered by id, independent of registration order). A cycle, a missing dependency or a dependency on a disabled agent throws (`DEPENDENCY_CYCLE`, `DEPENDENCY_NOT_REGISTERED`, `DEPENDENCY_DISABLED`): a mis-wired engine does not run. Required agents that are unregistered or disabled are reported and become `SKIPPED` runs, so the synthesis sees them.

## Orchestrator
Builds each agent's inputs from the risk-decision context, runs agents as soon as their dependencies finish (bounded by `maxConcurrency`), and returns every run plus the synthesis. **Isolation:** each agent runs in its own try/catch on frozen copies of its declared inputs and of its dependencies' results; a throwing, hanging, mutating or misbehaving agent cannot change another agent's result (tested). **Timeouts:** each attempt races a timer; on timeout the attempt's `AbortSignal` is raised and its late result is ignored. **Retries:** failures and timeouts are retried up to `maxAttempts` with linear backoff; a contract violation or an "unavailable" agent is not retried. **Events:** structured, allow-listed (`orchestrator.started`, `agent.started`, `agent.attempt_failed`, `agent.finished`, `agent.skipped`, `orchestrator.finished`) carrying identifiers, codes and numbers only; a failing event sink never breaks a run. The orchestrator performs no I/O; persistence is `record.ts`.

## Persistence (append-only, hash-chained; chains 27-32)
`agent_definitions` (registry snapshot per agent id / version / contract hash), `agent_orchestrator_runs` (risk-decision reference and version, trigger and context, agent set and versions, configuration snapshot + hash, input snapshot + hash, status, timestamps), `agent_runs`, `agent_findings`, `agent_evidence_references`, `agent_orchestrator_syntheses` (assessment, score, the **synthesis input** and its hash, the full result). A run is written **once, complete, in one transaction** after the agents have run in memory. Run identity = hash(decision version, agent set + contract hashes, configuration, inputs): the same evaluation returns the existing run **without re-running any agent**; a new decision version, agent version, configuration or input is a new run. Database checks: a synthesis can never `grants_approval`; a COMPLETED run needs a real verdict and a confidence, every other status has verdict `UNAVAILABLE` and a non-COMPLETED/UNAVAILABLE run needs an error code; sizes and codes are bounded.

## Synthesis (`research-synthesis-v1`)
A pure function of the agent results and the configuration; **timestamps and durations are not part of its input**, so identical results synthesize identically. Verdict scores: SUPPORTIVE +1, NEUTRAL 0, CAUTION -0.5, ADVERSE -1. Rules, in order:
1. a COMPLETED `BLOCKING` verdict from an agent that can block (not advisory) -> **RESEARCH_BLOCKED** (evidence of a block wins over missing data);
2. a required agent without a COMPLETED result, or no scoring result at all (including an engine with no agents) -> **RESEARCH_INCOMPLETE** (fail closed);
3. a COMPLETED ADVERSE verdict from a scoring agent with weight >= `adverseVetoWeight` (default 50) -> **RESEARCH_ADVERSE**;
4. otherwise the weighted mean `sum(weight x confidence/100 x score) / sum(weight)` against the thresholds (>= +0.35 **SUPPORTIVE**, >= -0.15 **NEUTRAL**, >= -0.5 **CAUTION**, below **ADVERSE**; low confidence pulls an agent toward neutral).
Advisory-only agents are reported but never scored and never block; zero-weight agents do not score; a failed *optional* agent is listed as unavailable and does not make the run incomplete. The result carries the literal `grantsApproval: false`. **It never creates `APPROVED_FOR_REVIEW` and bypasses no sizing, portfolio, market, breaker, expiry, kill-switch or approval gate** (a source test asserts no code under `packages/agents` mentions the status).

## Configuration (strict: a malformed value throws at start-up)
`TWINS_AGENT_ENGINE_ENABLED` (default **false**), `TWINS_AGENT_ENGINE_REQUIRED` (agent ids whose COMPLETED result is mandatory), `TWINS_AGENT_ENGINE_DISABLED_AGENTS`, `TWINS_AGENT_ENGINE_WEIGHTS` (JSON overrides, 0-100), `TWINS_AGENT_ENGINE_MAX_CONCURRENCY` (1-16, default 4), `TWINS_AGENT_ENGINE_HALT_ON` (default `RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE`). Thresholds are in `DEFAULT_THRESHOLDS`.

## Risk-flow integration point
In the worker, **after source intelligence and before sizing** (so before every later gate and approval eligibility): `runAgentEngine(db, latestDecisionId, ...)`.
* **Disabled (default):** returns immediately - no database read, no runtime-state read, no log line; the flow is exactly as before (the existing end-to-end tests pass unchanged).
* **Enabled:** the runtime state is checked first (kill switch, disabled intake or an unreadable state refuse before anything is read or written); the run is recorded; if the assessment is in `halt-on set` (default BLOCKED / INCOMPLETE / ADVERSE) the worker **stops there**: the decision stays PENDING and can never be sized, gated or approved. A missing required agent result is INCOMPLETE, so it fails closed. A database error propagates (the job fails and is retried).
* The assessment is evidence for later gates; it does not alter the risk decision and grants nothing. A supportive assessment does **not** advance a decision by itself: sizing, portfolio, market, breaker, expiry, kill-switch and approval gates all still run.

## Safety and privacy
No message text is read (inputs are parsed fields, tiers and numbers); agent text is redacted (bot tokens, private-key blocks, AWS keys, bearer tokens, long hex / base64, e-mail) and bounded before it is logged or stored; events and log fields are allow-listed; no network, LLM or broker code is imported (source tests). The engine writes only its six tables and never updates or deletes.

## Limits and remaining risks
* The enforcement of a halting assessment is in the worker flow; **approval eligibility does not re-check the research assessment** (a future task should add it once real agents exist, as Task 5 did for source intelligence).
* Enabling the engine with no registered agents halts every decision (INCOMPLETE) - by design; keep it disabled until agents exist.
* Agents get frozen copies, not process isolation: a buggy agent can still consume CPU until its timeout.
* Agent independence is not assumed or estimated: weights are configuration, not learned (RE-09).
* Registry snapshots record contracts, not agent code; a code change without a version bump is not detected.

## The first two research agents (Stage 5 / Task 2)

Both are **production agents**, registered **only when the engine is explicitly enabled** (`TWINS_AGENT_ENGINE_ENABLED=true`; otherwise the worker uses the empty registry and loads nothing). When enabled and `TWINS_AGENT_ENGINE_REQUIRED` is not set, **both are required** (a missing result is `RESEARCH_INCOMPLETE` and halts - set it to an empty value to make them optional). They are independent (no `dependsOn`), so they run in parallel in one level. Both can block, neither is advisory, default weight 60 (override with `TWINS_AGENT_ENGINE_WEIGHTS`, switch off with `TWINS_AGENT_ENGINE_DISABLED_AGENTS`). A BLOCKING verdict yields `RESEARCH_BLOCKED`, which stops the worker at the existing halt point; **approval eligibility is unchanged** and nothing here grants approval.

**Inputs are sanitized parsed fields only.** `signal_context` is new: the signal time and the revision state of its message (`current` / `superseded` / `ambiguous`, other-version count, whether earlier versions had different levels), computed from stored rows with the existing revision classifier (`classifyRevisions`); messages are read by an explicit metadata-only column list. No message text, raw payload or author reaches an agent, an event or a table (asserted by source tests and by a marker-text integration test over all six agent tables). Agents get the engine's clock (`ctx.now`) and never read the system clock.

### `signal-integrity-v1` - Signal Integrity Agent
Inputs: required `risk_decision`, `stop_loss_validation`, `signal_features`, `signal_context`; optional `source_intelligence`. Timeout 5 s, one attempt (pure). It **never guesses a missing value**; each check reports a code. Verdict = the worst finding; confidence 100 (BLOCKING), 90 (ADVERSE / SUPPORTIVE), 85 (CAUTION).

| Check | Finding -> level |
| --- | --- |
| mandatory fields | market, instrument type, underlying, side, entry (> 0), stop-loss (> 0), and the stop-loss validation evidence being `VALID` -> **BLOCKING** (`MARKET_MISSING`, `INSTRUMENT_TYPE_UNSUPPORTED`, `SIDE_INVALID`, `ENTRY_MISSING`, `STOP_LOSS_VALIDATION_FAILED`, ...) |
| derivatives | missing / non-real-date expiry (futures, options); option strike <= 0 or missing; option type not CE / PE -> **BLOCKING**. A strike on a non-option -> ADVERSE |
| level coherence | stop-loss on the wrong side of the entry; a target not on the profit side -> **BLOCKING**. Targets out of order (`strict` ordering also rejects equal targets) -> **ADVERSE** by default (`TWINS_AGENT_TARGET_ORDER_VIOLATION`). No targets -> CAUTION |
| consistency | derived features disagree with the decision's own market / side -> ADVERSE |
| staleness | age > 10 min CAUTION, > 30 min ADVERSE, > 120 min BLOCKING (`TWINS_AGENT_SIGNAL_STALE_*_MINUTES`); a signal time beyond the 5-minute future tolerance -> BLOCKING (impossible); unknown time -> CAUTION |
| revisions | superseded message -> **BLOCKING**; ambiguous revision or ambiguous sibling -> BLOCKING by default (`TWINS_AGENT_REVISION_AMBIGUOUS`); an earlier version with different levels -> CAUTION (a normal edit); conflicting revisions that are not the current one -> ADVERSE; message not linked -> CAUTION |
| source intelligence | not recorded / unavailable -> CAUTION; "valid" but with an unknown trust or confidence tier, or dated after the signal -> ADVERSE |
| quality warnings | stop under 1% or 10%+ from the entry; first target under 1R -> CAUTION |

### `instrument-verification-v1` - Instrument Verification Agent
Inputs: required `risk_decision`; optional `signal_features`, `signal_context`. Timeout 5 s, two attempts (reference lookups can fail transiently). Uses an **injected instrument reference** (`InstrumentReference`: `supportsMarket`, `underlyingKnown`, `lookup`, `listedExpiries`, plus `asOf`); **no live API or broker is integrated**. Shipped implementations: an in-memory one (tests), a **file-based** one over a pre-exported `twins-instrument-reference-v1` JSON (strict: unknown types, bad dates, non-positive lot sizes, duplicates, strikes on non-options are rejected; the file goes through the same safety checks as historical datasets), and an optional **historical reference** (`contractSeen` over imported historical datasets - supporting INFO evidence only, never a verdict change).

| Check | Finding -> level |
| --- | --- |
| market | missing; not supported by the reference -> **BLOCKING** (no further lookups are guessed) |
| instrument type / underlying | unsupported type; underlying missing or not recognized in that market; malformed equity symbol -> **BLOCKING** |
| expiry (derivatives) | missing; invalid format or impossible date; **in the past** (evaluated in the market's local day: NSE / BSE / NFO / BFO +05:30) -> **BLOCKING**; today -> CAUTION; beyond `TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS` (90) -> **ADVERSE** by default (`TWINS_AGENT_EXPIRY_BEYOND_HORIZON`) |
| option | strike <= 0 / missing; type not CE / PE -> BLOCKING |
| the contract | not found: `EXPIRY_NOT_LISTED`, `STRIKE_NOT_LISTED`, `CONTRACT_NOT_FOUND`, `INSTRUMENT_NOT_FOUND`; marked inactive -> **BLOCKING** |
| sizing data | option without a lot size; future with neither a multiplier nor a lot size -> **BLOCKING** by default (`TWINS_AGENT_MISSING_LOT_SIZE`: ADVERSE or BLOCKING). A future with only a lot size is noted (INFO). Equities need none (sizing defaults them to 1) |
| the reference | snapshot older than `TWINS_AGENT_REFERENCE_MAX_AGE_DAYS` (30) or undated -> CAUTION |
| failures | **no reference configured** -> `UNAVAILABLE` (never a pass); a failing reference is retried, then `FAILED` with the fixed code `INSTRUMENT_REFERENCE_ERROR` (the provider's own message is never stored). Because both agents are required, either outcome is `RESEARCH_INCOMPLETE` and halts |

### Configuration summary
Engine: `TWINS_AGENT_ENGINE_ENABLED`, `_REQUIRED`, `_DISABLED_AGENTS`, `_WEIGHTS`, `_MAX_CONCURRENCY`, `_HALT_ON`. Agents: `TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES` / `_ADVERSE_` / `_BLOCK_`, `TWINS_AGENT_SIGNAL_FUTURE_TOLERANCE_MINUTES`, `TWINS_AGENT_TARGET_ORDERING` (`strict` | `non_strict`), `TWINS_AGENT_TARGET_ORDER_VIOLATION`, `TWINS_AGENT_REVISION_AMBIGUOUS`, `TWINS_AGENT_INSTRUMENT_REFERENCE` (`none` | `file:<path>`), `TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS`, `TWINS_AGENT_EXPIRY_BEYOND_HORIZON`, `TWINS_AGENT_MISSING_LOT_SIZE`, `TWINS_AGENT_REFERENCE_MAX_AGE_DAYS`. Defaults are conservative; a malformed value throws at start-up; an unreadable reference file throws at start-up.

### Limitations of these two agents
* **With the engine enabled and no instrument reference, every decision halts** (`UNAVAILABLE` -> `INCOMPLETE`). A real, reviewed reference snapshot must exist before enabling.
* They verify **structure and consistency**, not correctness of the signal's call, and not whether a contract is liquid or tradable *today* (market calendar, liquidity and options agents are separate tasks). "Tradable in principle" means listed and active in the reference.
* Staleness is measured at the time the engine runs; because a run is identified by its inputs, re-running the same decision version returns the stored result (it does not re-measure age).
* Live signals carry a single entry price; the entry is treated as a level entry (no breakout / pullback distinction).
* The reference is only as good as its snapshot; the historical-dataset adapter only shows that a contract appeared in imported data.
* A supportive result from both agents does not make a decision eligible: every later gate still runs.

## Future agent roadmap (not in this task)
Each is a separate, reviewed task registering through this contract: data verification, market / news context, strategy applicability and invalidation, cost / spread / liquidity, probability and calibration, independent challenge, adaptive-management proposals (see the phase plans). LLM-based agents, if ever added, would be advisory-first, auditable layers beside the deterministic confidence - never the source of a numeric confidence.
