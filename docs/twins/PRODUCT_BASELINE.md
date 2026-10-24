# Product baseline (canonical)

Status: **RECEIVED 2026-10-24 and reconciled** (documentation only). Adopted by the owner as the proposed final product baseline (D-025). Reconciliation against the requirement matrix is complete. Owner decisions D-026..D-035 were recorded on 2026-10-24. Every residual question (Q-019..Q-028) now has an answer or an explicit deferral (Q-025 remainder: D-030a; Q-027: D-034); deferrals keep the affected work blocked. Receiving this architecture does **not** pass phase P00 or any release gate.

The text in the two fenced blocks below is the owner's architecture, preserved verbatim (sections A and B). Everything after it is reconciliation.

## A and B - architecture as received
```text
============================================================
A. PRODUCT IDENTITY AND NON-NEGOTIABLE BOUNDARIES
============================================================

TWINS is a research, validation, capital-protection,
human-approved execution and outcome-learning platform.

It is not a signal-copy bot.

Preserve the existing six-step product flow.

Separate these authorities:

1. External sources provide claims.
2. Research components produce evidence and proposals.
3. Statistical components produce supported estimates.
4. Deterministic policy/risk components enforce eligibility.
5. The authorized human approves a specific trading mandate.
6. Execution components act only within that mandate.
7. Learning components propose tested changes; they cannot
   silently promote themselves or relax risk limits.

A research eligibility result must never mean human approval.

No majority vote can override a deterministic risk veto.

Missing evidence must not be replaced with fabricated facts,
probabilities, target levels or assumed fills.

============================================================
B. COMPLETE PRODUCT ARCHITECTURE
============================================================

STEP 1 — EXTERNAL SIGNAL SOURCE
    |
    | Telegram signal, revision, cancellation or commentary
    | Source registry and source-health context
    v

STEP 2 — CAPTURE AND EVIDENCE LEDGER
    |
    | Preserve observed original content and revisions
    | Record source time, observed time and ingestion time
    | Detect duplicates, delays and capture gaps
    | Record historical coverage and its limitations
    | Durable intake with replay/recovery semantics
    |
    | Do not claim recovery of unobserved deleted content
    v

STEP 3 — CLASSIFY AND NORMALIZE CLAIM
    |
    | Classify:
    | NEW_SIGNAL / REVISION / CANCEL / EXIT_UPDATE /
    | TARGET_UPDATE / PERFORMANCE_CLAIM / COMMENTARY
    |
    | Link related messages to the correct claim/case
    | Extract underlying, strike, option type, expiry,
    | direction, entry semantics, source SL and targets
    | Flag missing/ambiguous information
    |
    | Parsed claim is not an executable order
    v

STEP 4 — RESEARCH, VALIDATION AND CAPITAL PROTECTION
    |
    +-- 4.0 CASE AND ORCHESTRATION
    |      Unique case ID and claim version
    |      Origin: TELEGRAM or TWINS_GENERATED
    |      Provenance and parent-case links
    |      Research deadline, entry validity, holding deadline
    |      Required inputs, dependencies and bounded budgets
    |
    +-- 4.1 SIGNAL / INSTRUMENT VERIFICATION — Agent 1
    |      Resolve actual contract and instrument metadata
    |      Verify expiry, strike, CE/PE and entry semantics
    |      Check duplicates, revisions and historical/current status
    |
    +-- 4.2 POINT-IN-TIME EVIDENCE — Agent 2
    |      Underlying and option observations
    |      Bid/ask and execution-relevant data where available
    |      News availability timestamps
    |      Constituents/weights and event context
    |      Source, freshness, coverage and quality checks
    |      Version evidence snapshots for each decision
    |
    +-- PARALLEL RESEARCH
    |      Agent 3: Global and macro context
    |      Agent 4: Domestic market regime
    |      Agent 5: Constituents and news
    |      Agent 6: Technical structure and invalidation
    |      Agent 7: Options and execution feasibility
    |
    +-- SECONDARY RESEARCH
    |      Agent 8: Signal DNA / source-strategy hypotheses
    |      Agent 9: Event and stress scenarios
    |
    +-- 4.3 SYNTHESIS AND MANAGEMENT PROPOSAL
    |      Supporting and contrary evidence
    |      Missing information
    |      Correlated/duplicate evidence
    |      Regime–strategy compatibility
    |      Cost-adjusted tradeability
    |      Opportunity-decay / no-chase check
    |      Unfamiliar-setup / abstention check
    |
    |      Preserve SOURCE_PLAN unchanged.
    |      Create separate TWINS_PLAN:
    |        - Entry trigger and permitted range
    |        - Initial protective stop
    |        - Supported targets/review checkpoints
    |        - Continuation conditions
    |        - Stop-adjustment constraints
    |        - Partial-exit permissions and lot feasibility
    |        - Invalidation, time exit and fallback policy
    |
    |      T1–T4 are not mandatory.
    |      Distinguish review checkpoints from actual exit orders.
    |
    +-- 4.4 HISTORICAL VALIDATION — Agent 10
    |      Applicable versioned validation artifacts
    |      Source-plan versus TWINS-policy evaluation
    |      Chronological unseen-data evaluation
    |      Costs, fills, latency and ambiguous path handling
    |      Coverage, sample quality and uncertainty
    |
    |      Expensive historical research runs offline.
    |      Live cases look up applicable validated artifacts.
    |
    +-- 4.5 PROBABILITY / EXPECTED OUTCOME — Agent 11
    |      Precisely defined event, deadline and policy
    |      Supported estimates and calibration references
    |      Research score kept separate from probability
    |      Insufficient support -> research/paper evaluation only
    |
    +-- 4.6 CAPITAL-PROTECTION GATE — Agent 12
    |      Deterministic enforcement of:
    |        - Per-trade and daily budgets
    |        - Existing/correlated exposure
    |        - Position sizing and lot feasibility
    |        - Stress/liquidity/execution constraints
    |        - Reservations and concurrent-candidate handling
    |      Risk veto cannot be overridden by agents
    |
    +-- 4.7 INDEPENDENT CHALLENGE — Agent 14
    |      Strongest failure case
    |      Unsupported assumptions and conflicting evidence
    |      Material unresolved objections block qualification
    |
    +-- 4.8 FINAL ELIGIBILITY — Agent 15 + policy engine
           |
           +--> WAIT
           |      Specific blocker, recheck trigger and deadline
           |
           +--> REJECT
           |
           +--> EXPIRED
           |
           +--> RESEARCH_ONLY
           |
           +--> QUALIFIED
                    |
                    v

STEP 5 — HUMAN APPROVAL
    |
    | Version-bound Telegram recommendation card
    | Authorized user; single-use approval
    | Bind contract, quantity, risk, entry range,
    | management policy and expiry
    |
    | Material changes invalidate the old card
    |
    +--> REJECT -> no new trade
    |
    +--> APPROVE -> execution pre-flight
                    |
                    v

STEP 6 — APPROVED TRADE LIFECYCLE
    |
    +-- Pre-flight
    |      Fresh prices, mandate validity, current risk,
    |      source changes, connectivity and duplicate checks
    |
    +-- Entry state machine
    |      Armed -> submitted -> acknowledged ->
    |      partial fill / fill / reject / unknown
    |      Unknown state -> reconcile before resubmission
    |
    +-- Protection
    |      Protect actual filled quantity
    |      Verify protective order state
    |      Handle rejection/uncertainty using approved policy
    |
    +-- Adaptive management
    |      Continuous defined thesis/invalidation monitoring
    |      T1 -> fresh continuation review
    |      Pass -> permitted stop adjustment -> verify -> T2
    |      Repeat for T3/T4 only where supported
    |      Fail/deadline/invalidation -> approved exit policy
    |      No unapproved risk increase or stop widening
    |
    +-- Exit and reconciliation
    |      Verify exit fills, remaining position and open orders
    |      Reconcile costs and realized P&L
    |
    v

OUTCOME AND CONTROLLED LEARNING
    |
    | Distinguish actual, paper and counterfactual outcomes
    | Compare source, fixed TWINS and adaptive policies
    | Attribute selection, entry, exit and execution effects
    | Monitor calibration, drift and operational incidents
    |
    | Learn -> test -> unseen evaluation -> paper/shadow ->
    | independent review -> explicit promotion -> monitoring
    |
    | No automatic live promotion or risk-limit relaxation


OPTIONAL ALTERNATIVE SEARCH — Agent 13

Rejected source candidate
    -> check whether alternative search is permitted
    -> bounded search, not mandatory trade generation
    -> no opportunity: NO TRADE
    -> new candidate: new case, TWINS_GENERATED origin
    -> SAME COMPLETE STEP 4, no lower bar


CROSS-CUTTING CONTROLS

Audit and lineage
Security and least privilege
Untrusted-source / prompt-injection boundaries
Durable intake and recovery
Off-host backup and restore verification
Monitoring and failure alerts
Build/commit provenance
Broker reconciliation
Safe new-entry pause
Separate emergency-position policy
Data coverage, access rights and compliance review

Pausing new entries must not remove existing protection.
```

## Reconciliation to the requirement matrix
Every architecture element maps to requirement IDs (statements, status, evidence and acceptance tests live **only** in [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)). A presence check that every requirement ID appears at least once below, and that every mapped ID exists, was run by the assistant with tooling that is not in this repository (historical assistant-produced evidence; the repository cannot reproduce it). It does not establish that each architecture line is adequately covered.

| Architecture element | Requirement IDs |
|---|---|
| A. Identity and boundaries: seven separated authorities; eligibility is not approval; no majority-vote override; no fabricated evidence | GV-01, GV-02, SZ-09, SZ-10, TG-11, RE-09, CL-04, MA-01 |
| Step 1 External signal source; source registry and health | SRC-01, TG-01, TG-14 |
| Step 2 Capture and evidence ledger (originals, revisions, three times, duplicates, delays/gaps, coverage, durable intake, no recovery claim for unobserved deletions) | TG-02, TG-03, TG-04, TG-05, TG-07, TG-12, TG-13, TG-14, TG-15, TG-09 |
| Step 3 Classify and normalize (seven classes, linking, extraction, ambiguity flags, claim is not an order) | CL-01, TG-06, TG-08, TG-10, CL-03, CL-04 |
| 4.0 Case and orchestration | CS-01, CS-02, CS-03, CS-04, LC-01, XC-10 |
| 4.1 Signal/instrument verification (Agent 1) | MD-02, MD-03, RE-01 |
| 4.2 Point-in-time evidence (Agent 2) | MD-01, MD-04, MD-05, MD-06, EV-01, EV-02, EV-03, CR-06, XC-06 |
| Parallel research (Agents 3-7) | RA-01, RA-02, RA-03, RA-04, RA-05 |
| Secondary research (Agents 8-9) | RA-06, RA-07 |
| 4.3 Synthesis and management proposal (SOURCE_PLAN vs TWINS_PLAN) | SY-01, SY-02, SY-03, SY-04, PL-01, PL-02, PL-03, RE-02, RE-03, RE-04, RE-06 |
| 4.4 Historical validation (Agent 10) | SV-01, SV-02, SV-03, SV-04, SV-05, SV-06, SV-07, CR-01, CR-02, CR-03, CR-04, CR-05 |
| 4.5 Probability / expected outcome (Agent 11) | PB-01, PB-02, PB-03, RE-05 |
| 4.6 Capital-protection gate (Agent 12) | SZ-01, SZ-02, SZ-03, SZ-04, SZ-05, SZ-06, SZ-07, SZ-08, SZ-11 |
| 4.7 Independent challenge (Agent 14) | RE-07, CH-01 |
| 4.8 Final eligibility (Agent 15 + policy engine) | RE-08 |
| Optional alternative search (Agent 13) | LC-02, LC-03, LC-04 |
| Step 5 Human approval | AP-01, AP-02, AP-03, AP-04, SC-01 |
| Step 6 Approved trade lifecycle (pre-flight, entry state machine, protection, adaptive management, exit/reconciliation) | AP-05, AP-06, EX-01, EX-02, EX-03, EX-04, EX-05, EX-06, EX-07, EX-09, EX-10, OP-01 |
| Outcome and controlled learning | OL-01, OL-02, OL-03, OL-04, OL-05, OL-06, OL-07, OL-08 |
| Cross-cutting: audit/lineage, security, durable intake, backups, monitoring, build provenance, broker reconciliation, new-entry pause, emergency-position policy, compliance | XC-01, XC-02, XC-03, XC-04, XC-05, XC-07, XC-08, XC-09, XC-10, EX-08, EX-12 |

## Target architecture decision: hybrid (D-026, answers Q-019)
TWINS is **not** an all-deterministic research product. The target is a hybrid of three kinds of responsibility:
1. **Deterministic safety and authority controls** (identity, policy, risk, eligibility, approval binding, execution gating).
2. **Statistical/analytical validation and probability components** (validation, calibration, estimation, anomaly and regime statistics).
3. **Model-assisted research behind deterministic gates** (optional per component; evidence and proposals only).

Agents are **logical responsibilities**, not necessarily separate services, models or providers. **No provider selection, purchase, model call or content disclosure is authorized.** The hybrid target does **not** make an active model provider mandatory for any phase or release slice: "no model component activated yet" is a valid state for every slice. The choices (no model yet; local model; external provider; mixed deployment if separately proposed) stay with the owner under Q-009, and any activation needs a separate approval. Agent 12 (capital protection) and final eligibility (Agent 15 + policy engine) are deterministic and non-overridable; no vote or consensus overrides a risk veto.

**Rules for every model-assisted responsibility (MA-01):** text from outside is untrusted data; outputs are schema-validated structured evidence with provenance; no credentials, tools or order access; failure or timeout falls back to deterministic abstention (WAIT / `unavailable`); it can neither set nor change an eligibility state, a size or an approval; the model/prompt version is recorded for attribution.

**Independence rule (RE-07):** the independent challenge uses a distinct review procedure and independent checks where available (different data source, different code path, different procedure). A different prompt or a different model alone is never represented as proven independence. Each challenge report states per check what is independent and what is not.

### Per-agent method table (statuses of the underlying requirements are in the matrix; nothing here marks anything implemented)
| # | Responsibility | Deterministic | Statistical | Optional model-assisted | Inputs -> outputs | Authority limit |
|---|---|---|---|---|---|---|
| 1 | Signal / instrument verification | as-of contract-master lookup, expiry/strike/CE-PE/entry-semantics rule checks, duplicate/revision keys | - | proposes readings of ambiguous text for rule or human confirmation; never resolves a contract | claim, instrument master snapshot, library records -> resolved instrument or `unresolved` + reasons | cannot invent or guess a contract; cannot promote a claim |
| 2 | Point-in-time evidence | retrieval, as-of enforcement, freshness/coverage/quality checks, snapshot ids and versioning | outlier and gap statistics for data quality | none foreseen | vendor data, news, constituents -> versioned evidence snapshot | no interpretation; missing data stays `unavailable`, never filled in |
| 3 | Global and macro context | data pulls, calendar joins, rule flags | deviation/factor statistics against history | summarize macro text into structured, cited evidence items | macro data/news -> macro evidence items | evidence only; cannot qualify or veto |
| 4 | Domestic market regime | regime rules from defined inputs | regime classification with uncertainty | narrative commentary only | market series -> regime label + uncertainty (`unknown` allowed) | evidence only |
| 5 | Constituents and news | as-of weights, availability timestamps, de-duplication | contribution and event-impact estimates where supported | classify/summarize news relevance into structured fields with quotes | constituents, news -> supporting/contrary items | evidence only; news text is never an instruction |
| 6 | Technical structure and invalidation | indicator computation, rule-based level detection, invalidation-level derivation | volatility distributions, level-robustness statistics | pattern commentary (never levels) | price series -> structure features, invalidation levels or `unavailable` | levels come from data only, never from a model or the source text |
| 7 | Options and execution feasibility | contract status, tick/lot checks, spread/depth/liquidity rules, tradeability verdict | slippage and fill-cost estimates from historical spreads | none foreseen | contract, quotes -> tradeable/not + cost estimate + reasons | missing bid/ask means not tradeable; fills are never assumed |
| 8 | Signal DNA / source-strategy hypotheses (secondary) | feature extraction from library records | hypothesis tests with multiple-testing control | suggest and summarize candidate hypotheses | library records -> hypotheses with evidence and limitations | cannot qualify a case; promotion only through governed validation |
| 9 | Event and stress scenarios (secondary) | scenario definitions and calendars | scenario/shock distributions from history | scenario brainstorming, labelled as hypotheses | events, history -> labelled scenarios feeding risk stress inputs | scenarios are not forecasts; cannot reduce risk requirements |
| 10 | Historical validation | split rules, leakage controls, reproducible runs, artifact versioning and lookup | unseen-data evaluation, uncertainty, cost sensitivity, calibration inputs | draft report text after numbers are fixed | strategy version, cases -> versioned validation artifact or `none` | artifacts only; cannot self-promote; `none` means RESEARCH_ONLY |
| 11 | Probability / expected outcome | event/deadline/policy definition, schema gating | calibrated estimates with intervals and calibration references | explanation text only (never the estimate) | artifact, case -> probability or null + support references | a probability exists only if supported; model confidence is never a probability |
| 12 | Capital-protection gate | **entirely deterministic**: budgets, exposure, sizing, lot feasibility, reservations, fail-closed policy | may consume stress estimates as inputs; the decision stays deterministic | none | case, account snapshot, active approved production policy -> lots or veto + reasons | veto is absolute and non-overridable by any agent or vote; no active policy means zero lots |
| 13 | Alternative search (optional) | permission check (D-023), bounds, case creation with TWINS_GENERATED origin, same Step 4 | screening statistics over eligible strategy versions | candidate-idea generation behind gates (candidates only) | rejected source case -> NO TRADE or a new case | cannot generate a trade by itself; no lower bar; only eligible strategy versions |
| 14 | Independent challenge | rule-based failure-case checklist (assumption audit, conflicting and stale evidence, duplicated evidence) as a distinct review procedure | sensitivity/robustness checks, base-rate and out-of-sample consistency using independent data where available | adversarial critique over the same snapshot (does NOT count as independence) | evidence snapshot, plan -> objections with severity and independence record | a material unresolved objection blocks QUALIFIED; cannot approve or size |
| 15 | Final eligibility (+ policy engine) | **entirely deterministic**: state machine over structured agent outputs and policy -> WAIT / REJECT / EXPIRED / RESEARCH_ONLY / QUALIFIED with reason codes | consumes estimates; decides nothing statistically | human-readable explanation after the decision only | agent outputs, policy -> eligibility state | QUALIFIED is never approval; cannot override Agent 12; no model or vote can set the state |

## Notes on how the architecture is read (no hidden assumptions)
- **"Existing six-step product flow"**: CONFIRMED by the owner on 2026-10-24 (Q-023): architecture STEP 1-6 plus the outcome/learning section is the canonical six-step product flow.
- **First mandate type (D-027, answers Q-020):** one resolved contract, fixed approved quantity, entry trigger/range, management-policy version and mandate expiry. No scale-in, quantity increase or re-entry. Bounded dynamic exits and protective-stop adjustments are permitted only within the explicitly approved management policy; any partial-exit permission must be explicit and lot-feasible.
- **Source changes (D-028, answers Q-021):** before entry, a reliably linked cancellation or material revision invalidates the outstanding mandate; a replacement needs a fresh eligible recommendation and fresh approval; any outstanding entry order is cancelled where applicable and actual fills are reconciled (cancellation is never assumed to have succeeded); if a fill occurred the open-position policy applies. After entry, source messages are evidence, not execution authority: alert and assess under the approved management policy; never automatically widen risk, add quantity or exit merely because the source said so. Ambiguous linking stays explicitly unresolved. The "open-position policy" is the open-position execution contract defined by D-035 (OP-01); its components are not yet configured.
- **Material changes (D-032, answers Q-024):** changes to these mandate-bound fields are material: resolved contract/expiry and side; approved quantity; entry trigger or permitted entry range; risk allowance; management-policy version or permissions; a mandate expiry extension; and a reliably linked source cancellation or material revision. Ordinary market movement inside the approved entry constraints is not material. Actions the approved management policy explicitly permits (bounded stop tightening, activating an approved continuation objective) need no fresh approval. A price-range breach blocks entry; it never authorizes chasing or automatic range expansion. No numerical tolerance is selected. Anything outside the approved mandate needs a new eligible recommendation and fresh approval.
- **Source targets and TWINS levels (D-033, answers Q-026):** no 1:1 mapping is required. Source targets stay unchanged in SOURCE_PLAN. TWINS may propose independently supported levels in TWINS_PLAN, subject to validation and deterministic eligibility, each identified as a review checkpoint, a partial-exit level or a hard exit objective. T1-T4 are not forced. Post-approval changes are allowed only within explicit, previously approved management-policy permissions; otherwise fresh approval.
- **Generated-candidate scope (D-034, Q-027):** no instrument or market allowlist is inferred from examples. Alternative search stays disabled until Q-002 and D-023 define and authorize its market, instrument, strategy and budget scope. This is an explicit activation deferral, not a granted multi-market permission.
- **Open-position execution contract (D-035, answers Q-028):** a named contract composed of the mandate-bound approved management policy, the explicitly configured emergency-position policy, and deterministic risk, mandate and execution invariants, each referenced by version. Safety restrictions cannot be overridden by normal continuation logic. No emergency action is invented when the emergency policy is missing. No open-position automation is activated by this decision.
- **RESEARCH_ONLY (D-029, answers Q-022):** initially record only. No order creation, approval card or automatic trade simulation. After the outcome engine exists, a separately authorized evaluation workflow may be proposed; reconstructed, prospective paper and actual outcomes stay distinct.
- **QUALIFIED** is a research eligibility result only; it carries no execution permission anywhere in the plans.
- Statements marked *proposed* (for example the durability design in P01) are designs, not implementations.

## Implementation reality in one paragraph
The repository implements STEP 1-3 substantially (read-only Telegram capture, raw ledger with revisions, options-claim parsing) and the approval *mechanics* of STEP 5 for claim review. STEP 4 exists only as a thin deterministic validation stack that is not wired to the options intake, STEP 6 and the outcome/learning loop do not exist, and `packages/risk`, `packages/market`, `packages/analytics` are placeholders. Details and evidence: the matrix and `audit/`.
