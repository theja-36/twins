# Agent engine: contract, registry and orchestrator (Stage 5 / Task 1)

> Decision [D-066](DECISION_LOG.md); requirement [RE-10](REQUIREMENTS_TRACEABILITY.md) (new), supports [SZ-10](REQUIREMENTS_TRACEABILITY.md). Builds on [SOURCE_INTELLIGENCE_INTEGRATION.md](SOURCE_INTELLIGENCE_INTEGRATION.md), [RISK_DECISIONS.md](RISK_DECISIONS.md), [RISK_APPROVAL_WORKFLOW.md](RISK_APPROVAL_WORKFLOW.md) and [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/agents/` (`contract.ts`, `registry.ts`, `config.ts`, `orchestrator.ts`, `synthesis.ts`, `record.ts`, `sanitize.ts`), the worker hook in `services/worker/src/index.ts`, migration `0025_agent_engine`.

The **production foundation** for TWINS's multi-agent research, validation and capital-protection engine: a strict agent contract, a registry, an orchestrator that runs agents in dependency order and in parallel with timeouts, retries and failure isolation, append-only persistence of every run, and a deterministic synthesis. **No research agent is implemented** (the production registry is empty), **no LLM or other external API is called**, and the engine is **disabled by default**. It places no order, calls no broker, creates no approval, card, fill, position or risk-decision version, and enables nothing live.

## Agent contract (`agent-contract-v1`)
Every agent declares: `agentId` (`lower_snake_case`), `agentName`, `version` (`major.minor.patch`), `requiredInputs` / `optionalInputs` (from the closed set `risk_decision`, `source_intelligence`, `stop_loss_validation`, `signal_features` - **parsed fields only; an agent never receives message text**), an `outputSchema` (a closed set of typed output fields: `string`, `number`, `boolean`, `string[]`, `number[]`), `timeoutMs` (50-120000), `retry` (`maxAttempts` 1-5, `backoffMs`), `weight` (0-100), `canBlock`, `advisoryOnly` (never both: an advisory agent can never block) and `dependsOn`. The contract is validated at registration with a fixed error code per rule.

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

## Future agent roadmap (not in this task)
Each is a separate, reviewed task registering through this contract: data verification, market / news context, strategy applicability and invalidation, cost / spread / liquidity, probability and calibration, independent challenge, adaptive-management proposals (see the phase plans). LLM-based agents, if ever added, would be advisory-first, auditable layers beside the deterministic confidence - never the source of a numeric confidence.
