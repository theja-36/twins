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

Both are **production agents**, registered **only when the engine is explicitly enabled** (`TWINS_AGENT_ENGINE_ENABLED=true`; otherwise the worker uses the empty registry and loads nothing). When enabled and `TWINS_AGENT_ENGINE_REQUIRED` is not set, **both are required** (since Stage 5 / Task 3 the default required set is all four production agents) (a missing result is `RESEARCH_INCOMPLETE` and halts - set it to an empty value to make them optional). They are independent (no `dependsOn`), so they run in parallel in one level. Both can block, neither is advisory, default weight 60 (override with `TWINS_AGENT_ENGINE_WEIGHTS`, switch off with `TWINS_AGENT_ENGINE_DISABLED_AGENTS`). A BLOCKING verdict yields `RESEARCH_BLOCKED`, which stops the worker at the existing halt point; **approval eligibility is unchanged** and nothing here grants approval.

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

## The calendar and macro agents (Stage 5 / Task 3)
Two more production agents, registered (with the Task 2 agents) only when the engine is explicitly enabled and required by default, so a missing result fails closed. They run in the same parallel level, receive parsed fields and the engine clock only (never message text), use **injected providers** (no external API, no model), never write anything but their own run records and never grant approval. A BLOCKING verdict halts at the existing worker halt point; approval eligibility is unchanged. Both read the engine clock (`ctx.now`), never the system clock.

### Provider interfaces (`packages/agents/src/agents/calendarProviders.ts`, `macroProvider.ts`)
| Interface | Contract | Shipped implementations |
| --- | --- | --- |
| `HolidayCalendarProvider` | `day(market, date)` -> `{ date, holiday, holidayName, earlyCloseLocal }` or `null` when the market / date is not covered; `asOf` | in-memory (tests); file `twins-holiday-calendar-v1` (per market a covered range and the exceptional days: holidays and early closes) |
| `EconomicCalendarProvider` | `coverage {from,to}`, `events({from,to})` -> `{ id, name, at (ISO with offset), impact LOW/MEDIUM/HIGH/CRITICAL, markets[] ("ALL" = every market) }`; `asOf` | in-memory; file `twins-economic-calendar-v1` |
| `MacroContextProvider` | `context({ market, underlying })` -> snapshot `{ asOf, index {level, previousClose, open, recentCloses[]}, breadth, volatilityIndex, currency, global[], releases[] }` or `null` | in-memory; file `twins-macro-context-v1` (keys `MARKET:UNDERLYING` or `MARKET:*`) |
Files are read with the historical import safety checks (regular file, no credential-like name, no binary, size cap), validated strictly (malformed data is rejected, nothing is repaired) and an unreadable or invalid file stops the worker at start-up. A provider returns `null` for what it does not cover and throws on failure; the agents re-validate whatever a provider returns.

### `market-calendar-v1` - Market Calendar Agent (weight 50, can block)
Inputs: `risk_decision`, `signal_context` (required), the holiday and economic calendars, the market session configuration, the engine clock.
| Check | Result |
| --- | --- |
| market | missing or not in the session configuration -> **BLOCKING** (`MARKET_MISSING`, `MARKET_UNKNOWN`). Defaults: NSE, BSE, NFO, BFO 09:15-15:30 IST, Monday-Friday (`TWINS_AGENT_CALENDAR_SESSIONS` overrides) |
| session at the engine clock | weekend, holiday, before the open, at or after the close -> **BLOCKING** (`MARKET_WEEKEND`, `MARKET_HOLIDAY`, `MARKET_NOT_OPEN`, `MARKET_CLOSED`). An early close (from the holiday calendar) moves the close: `EARLY_CLOSE_SESSION` -> CAUTION; closing within `TWINS_AGENT_NEAR_CLOSE_MINUTES` (15) -> CAUTION |
| signal time | sent outside trading hours -> `TWINS_AGENT_SIGNAL_OUTSIDE_SESSION` (default CAUTION); unknown time / uncovered day -> CAUTION |
| expiry (derivatives) | already expired -> **BLOCKING** `EXPIRY_PASSED`; expiry day -> `TWINS_AGENT_EXPIRY_DAY_SEVERITY` (CAUTION); within `TWINS_AGENT_EXPIRY_APPROACHING_DAYS` (2) -> `..._APPROACHING_SEVERITY` (INFO); expiry on a weekend / holiday -> CAUTION. Judged in the market's local calendar |
| scheduled events (relative to the engine clock, for the market or `ALL`) | CRITICAL inside the blackout (`60` min before / `30` after) -> **BLOCKING** (`TWINS_AGENT_CRITICAL_EVENT_BLACKOUT`: BLOCKING or ADVERSE); CRITICAL later inside the look-ahead (240 min) -> ADVERSE; HIGH inside its window (120 before / 30 after) -> ADVERSE, later in the look-ahead -> CAUTION; MEDIUM in the look-ahead -> CAUTION; LOW -> INFO |
| the calendars | snapshot older than `TWINS_AGENT_CALENDAR_MAX_AGE_DAYS` (30) or undated -> CAUTION; economic coverage ending before the look-ahead -> CAUTION |
| failures | no holiday / economic calendar configured, a provider that throws, a date not covered by the holiday calendar, an economic calendar not covering the current time, malformed data -> **UNAVAILABLE** (never a pass; fixed error codes, the provider's message is never stored) |
Verdict = the worst level; a clean calendar = SUPPORTIVE. "Near the signal time": the agent runs when the decision is made, so events are judged against the engine clock; the signal's own time is checked against the session separately.

### `macro-global-v1` - Macro / Global Market Agent (weight 50, can block)
Inputs: `risk_decision` (required), `signal_features`, `source_intelligence` (optional; only its status is recorded), the macro provider, the engine clock. Deterministic thresholds only; findings state what the data shows and do not infer causation.
Signal direction is derived from the signal's own fields: BUY equity / future / CE and SELL PE are BULLISH exposure; SELL equity / future / CE and BUY PE are BEARISH (an unknown side or option type -> CAUTION `DIRECTION_UNKNOWN`, alignment not assessed).
| Check | Result |
| --- | --- |
| required context | no provider, no context for the market, no index level, fewer closes than the trend lookback, malformed data, a context from the future or older than `TWINS_AGENT_MACRO_STALE_UNAVAILABLE_MINUTES` (1440), a provider that throws -> **UNAVAILABLE** (never a pass) |
| staleness | older than `TWINS_AGENT_MACRO_STALE_CAUTION_MINUTES` (60) -> CAUTION |
| trend alignment (over `TWINS_AGENT_MACRO_TREND_LOOKBACK_SESSIONS`, default 5) | against the direction by >= 2% -> ADVERSE; >= 0.75% -> CAUTION; aligned by >= 0.5% -> INFO `TREND_ALIGNED` (the only way to be SUPPORTIVE) |
| one-day index move (absolute) | >= 7% -> **BLOCKING**; >= 3% -> ADVERSE; >= 1.5% -> CAUTION |
| gap (open vs previous close, absolute) | >= 2% -> ADVERSE; >= 1% -> CAUTION |
| volatility index | level >= 40 -> **BLOCKING**; >= 25 -> ADVERSE; >= 20 -> CAUTION; one-day rise >= 15% -> ADVERSE |
| risk-off / risk-on | advancing share <= 0.3 (or a volatility spike with a falling index) against a bullish signal -> CAUTION, ADVERSE together with a spike; share >= 0.7 against a bearish signal -> CAUTION |
| global indices | a one-day move against the direction >= 2% -> ADVERSE; >= 1% -> CAUTION |
| currency | absolute one-day move >= 1% -> CAUTION |
| macro releases (market or `ALL`) | CRITICAL inside the window (60 min before / 15 after) -> `TWINS_AGENT_MACRO_CRITICAL_RELEASE` (BLOCKING); HIGH -> ADVERSE; MEDIUM -> CAUTION |
| completeness | missing optional sections are noted (INFO); all four missing -> CAUTION `CONTEXT_THIN` |
Verdict = the worst level; with nothing adverse the verdict is **SUPPORTIVE** if the trend is aligned and **NEUTRAL** (confidence 70) otherwise.

### Configuration (Tasks 3)
Providers: `TWINS_AGENT_HOLIDAY_CALENDAR`, `TWINS_AGENT_ECONOMIC_CALENDAR`, `TWINS_AGENT_MACRO_PROVIDER` (`none` | `file:<path>`, default `none`). Sessions, look-ahead, blackout / high-event windows, severities, expiry, near-close and calendar-age settings: `TWINS_AGENT_CALENDAR_*`, `TWINS_AGENT_CRITICAL_*`, `TWINS_AGENT_HIGH_EVENT_*`, `TWINS_AGENT_SIGNAL_OUTSIDE_SESSION`, `TWINS_AGENT_EXPIRY_*`, `TWINS_AGENT_NEAR_CLOSE_MINUTES`. Macro thresholds: `TWINS_AGENT_MACRO_*` (lookback, trend, volatility, move, gap, breadth, global, currency, staleness, release window, critical-release severity). Enable / disable and weights use the engine settings. Every setting is listed in `rules.ts`; defaults are conservative and a malformed value throws at start-up. Note: disabling a default-required agent requires an explicit `TWINS_AGENT_ENGINE_REQUIRED` (otherwise start-up fails).

### Limitations of these two agents
* **With the engine enabled, all four required agents need their providers**: with no holiday calendar, economic calendar or macro context every decision is `INCOMPLETE` and halts. Reviewed, regularly refreshed snapshot files (or a future live adapter, a separate task) must exist before enabling.
* They describe session, calendar and market conditions; they do not predict, do not know the signal's merit, and the macro agent infers no cause. Index, breadth, volatility and global data are only as good (and as fresh) as the provider's snapshot; staleness is flagged, not repaired.
* Time zones: sessions use fixed UTC offsets per market (no daylight-saving rules); a market that observes DST needs its offset kept current in `TWINS_AGENT_CALENDAR_SESSIONS`. Weekend days are Saturday and Sunday. Holiday and early-close data come only from the holiday calendar.
* The economic calendar's `markets` are matched by code; the holiday calendar must use the same market code as the signal (e.g. `NSE`).
* Events are judged against the engine clock; a re-run of the same decision version returns the stored result and does not re-measure.
* A supportive result from the agents does not make a decision eligible: every later gate still runs, and eligibility does not yet re-check the research assessment.

## The news and index-constituent agents (Stage 5 / Task 4)
Two more production agents, registered with the earlier ones only when the engine is explicitly enabled and **required by default** (the default required set is now all six production agents, so a missing result fails closed). They run in the same parallel level (default concurrency limit 4), receive parsed fields and the engine clock only, use **injected providers** (no external API, no model), write only their own run records and never grant approval. A BLOCKING verdict halts at the existing worker halt point; approval eligibility is unchanged. **News input is structured provider records only; raw Telegram message text is never a news input.** Findings never repeat headline text (only item ids, impact, category, source label, ages and numbers).

### Provider interfaces (`newsProviders.ts`, `constituentProviders.ts`)
| Interface | Contract | Shipped implementations |
| --- | --- | --- |
| `NewsProvider` | `items({from,to,market,symbols})` -> items `{ id, publishedAt (ISO with offset), sourceLabel, headline (safe summary), symbols[] ("*" = market-wide), markets[] ("ALL"), sentimentLabel POSITIVE/NEGATIVE/NEUTRAL/MIXED, sentimentScore -1..1 or null, impact LOW/MEDIUM/HIGH/CRITICAL, category, reference (safe id or null), sourceReliability 0..1 or null }`; `asOf` | in-memory; file `twins-news-v1` |
| `SentimentProvider` | `sentiment({market,symbol})` -> `{ score -1..1, label, sampleSize, asOf }` or `null` | in-memory; file `twins-sentiment-v1` (keys `MARKET:SYMBOL`) |
| `ConstituentProvider` | `knowsIndex(index)`, `constituents(index)` -> `{ index, asOf, constituents[{ symbol, index, weight %, sector, recentChangePct|null, dataAsOf, newsRefs[] }] }` or `null` | in-memory; file `twins-index-constituents-v1` |
| `MarketDataProvider` | `quotes({market,symbols})` -> `{ SYMBOL: { changePct1d, asOf } }` (absent = no quote) | in-memory; file `twins-market-quotes-v1` (keys `MARKET:SYMBOL`) |
Files get the same safety checks and strict validation as the earlier provider files (malformed data is rejected, nothing repaired; an invalid file stops the worker at start-up). Providers return empty / `null` for what they do not cover and throw on failure; the agents re-validate whatever a provider returns.

### `news-sentiment-v1` - News / Sentiment Agent (weight 50, can block)
Inputs: `risk_decision` (required); `signal_context`, `signal_features`, `source_intelligence` (optional; only its status is recorded); the news provider (required) and sentiment provider (optional); the engine clock. Direction is derived from side and option type exactly as in `macro-global-v1`.
| Check | Result |
| --- | --- |
| required data | no news provider, a provider that throws, malformed items, a feed snapshot older than `TWINS_AGENT_NEWS_STALE_UNAVAILABLE_MINUTES` (1440) or dated in the future, a missing market / underlying -> **UNAVAILABLE** (never a pass) |
| relevance | items for the underlying or market-wide (`*`), for the market or `ALL`, inside `TWINS_AGENT_NEWS_LOOKBACK_MINUTES` (1440); future-dated items are ignored (CAUTION); more than `TWINS_AGENT_NEWS_MAX_ITEMS` (500) -> the most recent are assessed (CAUTION) |
| duplicates | the same id, or the same source and normalised headline, counts once (INFO) |
| stance | the item's score (or +/-1 for a POSITIVE / NEGATIVE label) times the direction; beyond `TWINS_AGENT_NEWS_SENTIMENT_THRESHOLD` (0.3) it is adverse or supportive; MIXED is never a direction |
| adverse items | CRITICAL inside the near-term window (`TWINS_AGENT_NEWS_NEAR_TERM_MINUTES`, 120) -> **BLOCKING** (`TWINS_AGENT_NEWS_CRITICAL_ADVERSE`: BLOCKING or ADVERSE); CRITICAL older -> ADVERSE; HIGH -> ADVERSE; MEDIUM -> CAUTION; LOW -> INFO. A source with reliability below `TWINS_AGENT_NEWS_MIN_RELIABILITY` (0.5) is downgraded one level |
| conflict | adverse and supportive items of at least medium impact -> CAUTION; HIGH or CRITICAL on both sides -> ADVERSE |
| event proximity | HIGH / CRITICAL items in the near term with no clear direction (neutral / mixed) -> CAUTION |
| aggregate sentiment | against the direction by >= 0.5 with >= 5 samples -> ADVERSE (fewer samples -> CAUTION); >= 0.2 -> CAUTION; stale -> CAUTION; in the direction -> supportive evidence; none / not configured -> INFO |
| feed freshness | older than `TWINS_AGENT_NEWS_STALE_CAUTION_MINUTES` (120) or undated -> CAUTION |
Verdict = the worst level. With nothing adverse: **SUPPORTIVE** if there is supportive evidence (a supportive item of at least medium impact or a supportive aggregate), otherwise **NEUTRAL** (confidence 70; this includes "no recent news").

### `index-constituent-impact-v1` - Index-Constituent Impact Agent (weight 50, can block)
Applies to **index signals only**: the underlying must be in `TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS` (default BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTY, SENSEX). For any other underlying the agent is not applicable: NEUTRAL, `applicable: false`, providers untouched. Inputs: `risk_decision` (required), the constituent provider (required for index signals), a market-data provider and the news provider (optional), the engine clock.
| Check | Result |
| --- | --- |
| required data | no constituent provider, an index it does not cover, **index / underlying mismatch** (set or record for another index), malformed data (duplicate symbols, bad weights, total above 100.5%), covered weight below `..._MIN_COVERED_WEIGHT` (60%), usable (present, fresh) change data for less than `..._MIN_USABLE_SHARE` (70%) of the top constituents' weight, a throwing provider -> **UNAVAILABLE** (never a pass) |
| top constituents | the heaviest `..._TOP_COUNT` (10) with weight >= `..._MIN_WEIGHT` (1%). A market-data quote takes precedence over the record's own change; a change older than `..._STALE_UNAVAILABLE_MINUTES` (1440) is unusable, older than `..._STALE_CAUTION_MINUTES` (60) is stale (CAUTION); some unusable -> CAUTION |
| weighted impact | the weight-averaged move of the usable constituents times the direction: <= -0.75% -> ADVERSE, <= -0.3% -> CAUTION, >= +0.3% -> supportive evidence |
| breadth | >= 60% of the weight moving against by >= `..._MOVE_CAUTION` (1%) -> CAUTION; sizeable weight (>= 35%) on both sides -> CAUTION (mixed) |
| single constituents | one contributing (weight x move) against by >= 0.4 index percent -> ADVERSE; a constituent with weight >= `..._CRITICAL_WEIGHT` (5%) moving >= 10% -> ADVERSE, or >= 2% against -> CAUTION |
| sector concentration | a sector holding >= 50% of the considered weight: INFO, or CAUTION when it moved against the direction |
| constituent news (same classification as the news agent, for the top constituents) | CRITICAL adverse near term: heavy constituent -> `..._CRITICAL_EVENT` (BLOCKING), lighter -> ADVERSE; HIGH adverse: heavy -> ADVERSE, lighter -> CAUTION; MEDIUM adverse on a heavy constituent -> CAUTION; supportive HIGH+ on heavy constituents -> supportive evidence; both sides -> CAUTION |
Verdict = the worst level; with nothing adverse it is **SUPPORTIVE** if the weighted move (or heavy-constituent news) is in the direction, otherwise **NEUTRAL**.

### Configuration (Task 4)
Providers: `TWINS_AGENT_NEWS_PROVIDER`, `TWINS_AGENT_SENTIMENT_PROVIDER`, `TWINS_AGENT_CONSTITUENT_PROVIDER`, `TWINS_AGENT_MARKET_DATA_PROVIDER` (`none` | `file:<path>`, default `none`). News windows, thresholds and staleness: `TWINS_AGENT_NEWS_*`, `TWINS_AGENT_SENTIMENT_*`. Constituent count, weight, move, impact, staleness, news and blocking settings: `TWINS_AGENT_CONSTITUENT_*` (including `INDEX_UNDERLYINGS` and `QUOTE_MARKET`, the cash-market code used for quotes and news, default `NSE`). Enable / disable and weights use the engine settings. All settings are listed in `rules.ts`; defaults are conservative; a malformed value throws at start-up.

### Limitations of these two agents
* **With the engine enabled, all six required agents need their providers.** Without a news provider, or without constituent data for an index signal, every such decision is `INCOMPLETE` and halts. Reviewed, regularly refreshed snapshot files (or a future live adapter, a separate task) must exist before enabling; non-index signals do not need constituent data.
* Sentiment labels and scores are the provider's: the agents do not classify text, do not weigh sources beyond the optional reliability field and infer no cause. A news item's headline is used only for duplicate detection.
* Constituent weights and sectors come from the snapshot and are only as current as it is; the weighted move covers the heaviest constituents, not the whole index, and is not the index's own move.
* The index-underlying list is configuration, not discovery: an index missing from it is treated as not applicable (the instrument agent still verifies the underlying).
* Events are judged against the engine clock; a re-run of the same decision version returns the stored result. A supportive result does not make a decision eligible: every later gate still runs, and eligibility does not yet re-check the research assessment.

## The technical-structure and price-action agents (Stage 5 / Task 5)
Two more production agents, registered with the earlier ones only when the engine is explicitly enabled and **required by default** (the default required set is now all eight production agents - ten after Task 6 - so a missing result fails closed). They run in the same parallel level (default concurrency limit 4), receive parsed fields and the engine clock only, use **injected OHLC / last-price providers** (no external API, no model), write only their own run records and never grant approval. A BLOCKING verdict halts at the existing worker halt point; approval eligibility is unchanged. Both judge the **underlying's** candles (for an option, the underlying's series) with the direction derived from side and option type as in `macro-global-v1`. Findings state what the series shows; they do not predict or infer cause.

### Provider interfaces (`ohlcProviders.ts`, `ohlcCommon.ts`)
| Interface | Contract | Shipped implementations |
| --- | --- | --- |
| `OhlcProvider` | `candles({market,symbol,limit,to})` -> `{ symbol, intervalSeconds, bars[{ t (ISO with offset), open, high, low, close, volume|null }] }` oldest first, or `null`; `asOf` | in-memory; file `twins-ohlc-v1` (keys `MARKET:SYMBOL`); a read-only adapter over the imported historical datasets (`equity_price` series; undated snapshot, so it is a CAUTION) |
| `LastPriceProvider` (optional) | `price({market,symbol})` -> `{ price, asOf }` or `null` | in-memory; file `twins-last-price-v1` |
Candles are validated at file load and again by the agents (positive finite prices, high >= low, open / close inside the range, strictly increasing offset-bearing times, non-negative volume); nothing is repaired. Candle queries use `TWINS_AGENT_OHLC_MARKET` (default `NSE`, the cash-market code).

Shared data rules (`loadMarketBars`): no provider, a throwing provider, no candles, a symbol mismatch, malformed candles, fewer bars than the agent's `MIN_BARS`, a snapshot older than `TWINS_AGENT_OHLC_STALE_UNAVAILABLE_MINUTES` (1440) or dated in the future, a latest candle older than `TWINS_AGENT_OHLC_MAX_BAR_AGE_DAYS` (5) or in the future -> **UNAVAILABLE** (never a pass). A snapshot older than `..._STALE_CAUTION_MINUTES` (120) or undated -> CAUTION. The reference price is the last-price provider's price when present and fresh (stale -> CAUTION, unusable -> falls back with CAUTION, differing from the latest close by more than `..._PRICE_DISCONNECT_PCT` (5) -> CAUTION), otherwise the latest close.

### `technical-structure-v1` - Technical Structure Agent (weight 50, can block)
Inputs: `risk_decision` (required); `signal_context`, `signal_features`, `source_intelligence` (optional; only its status is recorded); OHLC provider (required), last-price provider (optional); the engine clock.
| Check | Result |
| --- | --- |
| trend over `TWINS_AGENT_TECH_LONG_LOOKBACK` (30 bars) | against the direction by >= `TREND_ADVERSE_PCT` (4%) -> ADVERSE; >= `TREND_CAUTION_PCT` (1%) -> CAUTION; aligned by >= 1% -> supportive evidence. The short lookback (10) disagreeing with the long one by >= 1% each way -> CAUTION |
| swing structure (`SWING_STRENGTH` 2) | the last two swing highs and lows: lower highs and lower lows against a long (or the mirror) -> CAUTION; aligned -> supportive evidence |
| break of the prior `BREAKOUT_LOOKBACK` (20) bars | a break in the signal direction -> supportive evidence; a break against it -> `TECH_BREAKDOWN_AGAINST` (ADVERSE, configurable BLOCKING) |
| support / resistance | a swing level on the wrong side within `SR_PROXIMITY_PCT` (0.75%) -> CAUTION; a supporting level nearby -> INFO |
| moving averages (10 / 30 simple) | stacked against the direction -> CAUTION; aligned -> supportive evidence |
| momentum (Wilder RSI 14) | stretched in the direction (>= 75 for a long, <= 25 for a short) or 15+ points against -> CAUTION; 15+ points aligned -> supportive evidence |
| regime | Kaufman efficiency over the long lookback below 0.25 -> RANGE (never SUPPORTIVE); otherwise TRENDING |
| invalidation (equity / future only; option stops are premiums) | price already beyond the signal's stop-loss -> `TECH_INVALIDATION` (**BLOCKING**, configurable ADVERSE) |
Verdict = the worst level. With nothing cautionary: **SUPPORTIVE** needs a trending regime and at least two aligned signals; otherwise **NEUTRAL** (confidence 70).

### `price-action-v1` - Price-Action Agent (weight 50, can block)
Same inputs and data rules. Looks at the last `PA_PATTERN_WINDOW` (3) candles against the average range of the preceding `PA_ATR_PERIOD` (14) bars.
| Check | Result |
| --- | --- |
| engulfing | bullish / bearish engulfing with a body >= `MIN_BODY_ATR` (0.5) x the average range |
| hammer / shooting star | a small body with a long wick (>= 2x the body, <= 25% on the other side) after a 3-bar decline / advance |
| rejection wicks | a wick >= `WICK_RATIO` (0.6) of the range on a candle at least `MIN_BODY_ATR` x the average range (not already a hammer / star) |
| inside / outside bars | INFO; a strong outside bar closing against the direction -> CAUTION |
| pattern verdicts | aligned patterns are supportive evidence; an opposing pattern is CAUTION, ADVERSE when the candle is strong (range >= `STRONG_RANGE_ATR` 1.5 x average); **critical** (a strong opposing pattern right after >= `EXHAUSTION_RUN` (3) aligned candles and at the `EXTREME_LOOKBACK` (20-bar) extreme) -> `PA_CRITICAL_REVERSAL` (ADVERSE, configurable BLOCKING); patterns older than the previous candle are capped at CAUTION; aligned and opposing together -> CAUTION |
| gap (latest open vs previous close) | against the direction >= `GAP_ADVERSE_PCT` (1.5%) -> ADVERSE, >= `GAP_CAUTION_PCT` (0.5%) -> CAUTION; aligned -> INFO |
| consecutive candles | against: >= 5 -> ADVERSE, >= 3 -> CAUTION; aligned >= 3 -> supportive evidence, >= 5 -> CAUTION (extended run) |
| volatility | the latest range >= 2x the average -> CAUTION (ADVERSE when >= 3.5x and closing against the direction); <= 0.5x -> INFO |
| entry proximity | the distance to the recent extreme in the signal's favour is reported (INFO) and feeds the critical-reversal rule |
Verdict = the worst level. With nothing cautionary: **SUPPORTIVE** needs an aligned pattern or an aligned run; otherwise **NEUTRAL**.

### Configuration (Task 5)
Providers: `TWINS_AGENT_OHLC_PROVIDER`, `TWINS_AGENT_LAST_PRICE_PROVIDER` (`none` | `file:<path>`, default `none`). Staleness and market: `TWINS_AGENT_OHLC_*`. Lookbacks, thresholds and severities: `TWINS_AGENT_TECH_*` (min bars, lookbacks, trend, swing, breakout, proximity, averages, RSI, regime, break and invalidation severities) and `TWINS_AGENT_PA_*` (min bars, ATR period, pattern window, body / wick / range thresholds, gaps, runs, volatility, extremes, critical-reversal severity). Enable / disable and weights use the engine settings. All settings are listed in `rules.ts`; defaults are conservative; a malformed value (including `MIN_BARS` smaller than the lookbacks it must cover) throws at start-up.

### Limitations of these two agents
* **With the engine enabled, all eight required agents need their providers.** Without an OHLC provider every decision is `INCOMPLETE` and halts; reviewed, refreshed candle snapshots (or a future live adapter, a separate task) must exist first. The snapshot's interval is whatever it provides; lookbacks are in bars, so daily and intraday series are not interchangeable without re-tuning.
* The indicators are textbook and unoptimised (simple averages, Wilder RSI, strict swing pivots, a fixed pattern set). They describe the series; they are not a forecast, a strategy or evidence of cause.
* Option signals are judged on the underlying only; no option premium, spread or volatility analysis (a separate task). The invalidation check compares price with the stop only for equity and futures.
* The historical-dataset adapter covers equity price series only and has no snapshot time.
* Events are judged against the engine clock; a re-run of the same decision version returns the stored result. A supportive result does not make a decision eligible: every later gate still runs, and eligibility does not yet re-check the research assessment.

## The liquidity and options-risk agents (Stage 5 / Task 6)
Two more production agents, registered with the earlier ones only when the engine is explicitly enabled and **required by default** (the default required set is now all ten production agents, so a missing result fails closed). They run in the same parallel level (default concurrency limit 4), receive parsed fields and the engine clock only (never message text) and are validated, redacted, persisted and included in the synthesis like every other agent. A BLOCKING verdict halts at the existing worker halt point. **No migration, no broker, no external API, no order, fill, position or approval-card write, and no change to approval eligibility.** The engine stays disabled by default.

### Provider interfaces (`quoteProviders.ts`, `quoteCommon.ts`)
| Interface | Contract | Shipped implementations |
| --- | --- | --- |
| `QuoteProvider` | `quote({market,symbol,instrumentType,expiry,strike,optionType})` -> `{ bid, ask, last, volume, avgVolume, openInterest, bidDepth, askDepth, asOf }` (unknown fields `null`) or `null` | in-memory; file `twins-quotes-v1` (keys `MARKET:SYMBOL[:EXPIRY[:STRIKE:CE\|PE]]`) |
| `OptionsQuoteProvider` | same query -> `{ premium, bid, ask, iv, ivPrevious, delta, gamma, theta, vega, openInterest, volume, underlyingPrice, asOf }` or `null` | in-memory; file `twins-option-quotes-v1` |
| `OptionsChainProvider` | `chain({market,underlying,expiry})` -> `{ underlyingPrice, asOf, rows[{ strike, optionType, iv, openInterest, volume }] }` or `null` | in-memory; file `twins-option-chain-v1` (keys `MARKET:UNDERLYING:EXPIRY`) |
The OHLC and last-price providers of Task 5 are reused: the options agent takes the underlying price from the quote, then the chain, then the OHLC provider; the liquidity agent cross-checks an equity quote against the last price. Files are validated at load and again by the agents (non-negative finite sizes, positive prices, `ask >= bid`, a call delta in [0, 1] and a put delta in [-1, 0], offset-bearing times); a crossed or malformed quote is **malformed data, not a wide spread**. Nothing is repaired. Files use the shared safe reader (a `.json` regular file, no symlink, no credential-like name).

Staleness (`TWINS_AGENT_QUOTE_*`): a quote older than 5 minutes -> CAUTION; older than 30 minutes or dated more than 2 minutes in the future -> UNAVAILABLE.

### `liquidity-v1` - Liquidity Agent (weight 50, can block)
Inputs: `risk_decision` (required; `signal_context`, `signal_features`, `source_intelligence` optional, only its status recorded); quote provider (required), last-price provider (optional); the engine clock. Applies to equity, future and option contracts; any other instrument type or an incomplete contract is UNAVAILABLE.
| Check | Result |
| --- | --- |
| no provider / throws / no quote / malformed / crossed / neither bid nor ask / too old / future | **UNAVAILABLE** (never a pass; the provider's message is never stored) |
| the side the signal needs (BUY: ask, SELL: bid) | missing -> `LIQ_EXTREME_SEVERITY` (**BLOCKING**, configurable ADVERSE); the other side missing -> CAUTION |
| spread as % of mid | equity / future >= 0.5 CAUTION, >= 1.5 ADVERSE, >= 5 `LIQ_EXTREME_SEVERITY`; options >= 5 / 15 / 40 |
| displayed depth on the needed side | below `LIQ_MIN_DEPTH_QUANTITY` (1) -> `LIQ_EXTREME_SEVERITY`; depth not provided -> INFO |
| volume | average volume below `LIQ_POOR_AVG_VOLUME` (1000) -> ADVERSE (poor liquidity); volume under 0.25 x the average -> CAUTION (thin) |
| open interest (future / option) | below 100 -> ADVERSE; below 1000 -> CAUTION; missing -> CAUTION |
| price sanity | last price outside the quote by more than 2% -> CAUTION; entry price away from the quote mid by >= 3% CAUTION, >= 10% ADVERSE (x3 for options); equity quote vs last price > 5% -> CAUTION |
Verdict = the worst level. With nothing cautionary: **SUPPORTIVE** needs at least two assessed dimensions (spread plus volume, open interest or depth); otherwise **NEUTRAL** (confidence 70).

### `options-risk-v1` - Options Risk Agent (weight 50, can block)
Inputs: `risk_decision` (required); option-quote provider (required), option-chain provider (optional context), OHLC / last-price providers (underlying price fallback only); the engine clock. **Any other instrument type -> NEUTRAL with `applicable: false`** (the providers are never touched).
| Check | Result |
| --- | --- |
| no provider / throws / no quote / malformed (crossed market, negative IV, delta of the wrong sign or beyond 1, ...) / no price / premium not below the underlying / no underlying price from any source / too old / future | **UNAVAILABLE** |
| contract expiry (close `OPT_EXPIRY_CLOSE_UTC` 10:00 UTC = 15:30 IST) | past -> **BLOCKING**; <= 3 h -> `OPT_EXTREME_SEVERITY` (BLOCKING, configurable ADVERSE); <= 24 h -> ADVERSE; <= 3 days -> CAUTION |
| implied volatility level | >= 40 CAUTION, >= 70 ADVERSE, >= 120 `OPT_EXTREME_SEVERITY` |
| implied volatility change vs the previous session | +15% CAUTION, +30% ADVERSE, +60% `OPT_EXTREME_SEVERITY`; IV >= 1.5x the chain's at-the-money IV -> CAUTION |
| theta (long positions) | decay >= 4% of the premium per day CAUTION, >= 8% ADVERSE, >= 8% with <= 3 h to expiry `OPT_EXTREME_SEVERITY`; for a sale INFO |
| gamma (inside `OPT_GAMMA_WINDOW_DAYS`, 2) | delta change per 1% underlying move >= 0.10 CAUTION, >= 0.20 ADVERSE, >= 0.20 with <= 3 h to expiry `OPT_EXTREME_SEVERITY`; outside the window INFO |
| vega | a one-point IV change moving the premium >= 8% while IV >= 40 -> CAUTION |
| delta | absolute delta < 0.10 or > 0.90 -> CAUTION; missing greeks -> CAUTION |
| strike distance | long: >= 5% out of the money CAUTION, >= 10% ADVERSE; deep in the money >= 8% CAUTION; a sale only informs |
| premium sanity | below `OPT_MIN_PREMIUM` (1) or below intrinsic value -> CAUTION; entry premium vs quote >= 10% CAUTION, >= 25% ADVERSE |
| spread and market | spread >= 5% CAUTION, >= 10% ADVERSE; no market on the needed side -> ADVERSE; one-sided -> CAUTION |
| open interest / volume | OI < 500 CAUTION, < 50 ADVERSE; volume < 100 CAUTION, zero ADVERSE |
| premium stop-loss | the stop on the wrong side of the entry -> ADVERSE; premium already through the stop -> `OPT_STOP_INVALIDATION` (**BLOCKING**, configurable ADVERSE); stop distance not larger than the spread -> ADVERSE; smaller than one day of decay (long) -> CAUTION; the implied underlying move is reported (INFO) |
| chain (optional) | not configured -> INFO; throws / no chain / too old -> CAUTION; malformed -> UNAVAILABLE; strike not listed -> CAUTION |
Verdict = the worst level. With nothing cautionary: **SUPPORTIVE** needs at least four assessed dimensions (expiry, spread, IV, greeks, chain, open interest, volume); otherwise **NEUTRAL**.

### Configuration (Task 6)
Providers: `TWINS_AGENT_QUOTE_PROVIDER`, `TWINS_AGENT_OPTION_QUOTE_PROVIDER`, `TWINS_AGENT_OPTION_CHAIN_PROVIDER` (`none` | `file:<path>`, default `none`). Staleness: `TWINS_AGENT_QUOTE_*`. Liquidity thresholds and severities: `TWINS_AGENT_LIQ_*`. IV, theta / gamma windows, expiry proximity, moneyness, premium, spread, OI / volume and severities: `TWINS_AGENT_OPT_*`. Enable / disable and weights use the engine settings (`TWINS_AGENT_ENGINE_DISABLED_AGENTS`, `TWINS_AGENT_ENGINE_WEIGHTS`). Every value is validated at start-up (ordered thresholds, a gamma window, an extreme window below the adverse window); an invalid value stops the process.

### Limitations of these two agents
* **With the engine enabled, all ten required agents need their providers.** Without a quote provider (and, for options, an option-quote provider) every decision is `INCOMPLETE` and halts; reviewed, refreshed quote snapshots (or a future live adapter, a separate task) must exist first. Quotes are snapshots: depth is the displayed quantity at the best price only.
* Volume is compared with an average without time-of-day adjustment, so early-session volume looks thin (CAUTION only); the poor-liquidity ADVERSE rule uses the average volume alone.
* Greeks and IV are taken from the provider as given (theta per calendar day, vega per IV point, IV in percent); the agent does not recompute them, models no volatility surface and does not compare implied with realised volatility.
* Expiry time is the configured close of the expiry date; the agent has no exchange calendar (a holiday-shifted expiry is the calendar agent's concern).
* The options agent assumes the premium stop-loss is in premium units, as signal-integrity does; it judges contracts one at a time (no spreads or multi-leg structures).
* A supportive result does not make a decision eligible: every later gate still runs, and eligibility does not yet re-check the research assessment.

## Future agent roadmap (not in this task)
Each is a separate, reviewed task registering through this contract: data verification, market / news context, strategy applicability and invalidation, cost / spread / liquidity, probability and calibration, independent challenge, adaptive-management proposals (see the phase plans). LLM-based agents, if ever added, would be advisory-first, auditable layers beside the deterministic confidence - never the source of a numeric confidence.
