# TWINS — Complete Master Product Flow & Development Roadmap

**Product:** TWINS  
**Market:** India — NSE-focused  
**Users:** Private platform for 10 individual users  
**Product objective:** Build a complete AI-powered trading intelligence, research, decision-support, risk-management and execution platform.

---

# PART 1 — PRODUCT VISION

TWINS is not just a Telegram signal analyser. It is an independent trading intelligence platform with two parallel opportunity sources:

1. **Telegram Intelligence:** Understand trading calls from Telegram channels, learn each channel's strategy and historical performance, validate new signals and decide whether they deserve consideration.
2. **Independent Opportunity Engine:** Independently scan market conditions, identify opportunities, research them and generate trade candidates without requiring a Telegram signal.

Both pipelines must ultimately use the same research, validation, risk, simulation and decision infrastructure.

The platform must answer five questions before any trade:

- What is the opportunity?
- What evidence supports it?
- What are the risks and possible outcomes?
- How much capital can this particular user safely allocate?
- Should the system qualify it, wait, reject it or send it for human approval?

The product must continuously learn from actual outcomes and improve its strategy intelligence without allowing unvalidated learning to change live trading rules automatically.

## Core product principles

- Every signal and independently generated opportunity must have an evidence trail.
- Every user must have individual capital, risk settings and trading permissions.
- Research and risk calculations must be explainable.
- AI-generated confidence must be calibrated and must not override hard risk limits.
- No trade should bypass the decision and risk engines.
- Paper, assisted-live and controlled-auto execution must be separate modes.
- All original 16 modules must be retained.
- Existing working code must be reused wherever appropriate.

---

# PART 2 — COMPLETE MASTER SYSTEM FLOW

## 2.1 Overall architecture

The platform has seven major layers.

**Layer 1 — Data Ingestion**
- Telegram messages and channel data.
- Market prices and historical market data.
- Options and futures data.
- News and sentiment.
- Economic calendar and macro events.
- Index and constituent information.
- User trading profiles and capital settings.

**Layer 2 — Intelligence and Understanding**
- Signal parsing.
- Signal classification.
- Strategy identification.
- Market regime detection.
- Historical pattern matching.
- Channel strategy learning.
- Independent opportunity generation.

**Layer 3 — Research and Validation**
- 12 specialist research agents.
- Evidence ledger.
- Technical and price-action validation.
- Liquidity and instrument validation.
- News, macro and sentiment research.
- Historical probability analysis.
- Independent challenger.

**Layer 4 — Risk and Capital**
- Individual user capital.
- Position sizing.
- Lot calculations.
- Risk limits.
- Portfolio exposure.
- What-if simulation.
- Capital protection.

**Layer 5 — Decision Intelligence**
- Confidence scoring.
- Research synthesis.
- Decision engine.
- Explainable decision package.
- Qualification and cancellation rules.

**Layer 6 — Execution and Monitoring**
- Human approval.
- Paper trading.
- Assisted live execution.
- Controlled auto execution.
- Trade monitoring and management.

**Layer 7 — Learning and Analytics**
- Trade outcomes.
- Historical performance.
- Strategy learning.
- Channel performance.
- Confidence calibration.
- Model and strategy drift detection.

## 2.2 Complete end-to-end flow

```text
                       TWINS PLATFORM
                              |
                 USER & PLATFORM SETTINGS
                              |
              Individual Capital / Risk Profiles
                              |
                  MARKET DATA FOUNDATION
                              |
               +--------------+--------------+
               |                             |
       PIPELINE A                    PIPELINE B
   TELEGRAM INTELLIGENCE        INDEPENDENT OPPORTUNITY
               |                             |
       Telegram Capture              Market Scanning
               |                             |
       Raw Message Storage            Candidate Generation
               |                             |
       Message Parsing                Opportunity Classification
               |                             |
       Signal Classification          Setup Identification
               |                             |
       Strategy Identification        Initial Candidate Validation
               |                             |
       Evidence Ledger                Opportunity Evidence
               |                             |
       Channel History                Historical Pattern Matching
               |                             |
       Channel Strategy Learning      Market Regime Analysis
               |                             |
               +--------------+--------------+
                              |
                    COMMON RESEARCH ENGINE
                              |
                    12 SPECIALIST AGENTS
                              |
                    Research Synthesis
                              |
                    Independent Challenger
                              |
                    Evidence & Verdict Review
                              |
                    MARKET REGIME VALIDATION
                              |
                    STRATEGY & PATTERN CHECK
                              |
                    CONFIDENCE SCORING
                              |
                    USER-SPECIFIC RISK ENGINE
                              |
                    POSITION SIZING ENGINE
                              |
                    PRE-TRADE SIMULATOR
                              |
                    DECISION ENGINE
                              |
             +----------------+----------------+
             |                |                |
          QUALIFIED          WAIT             REJECT
             |                |                |
      Approval Workflow   Revalidation     Store Reason
             |
      User Approval / Policy
             |
     +-------+------------------------+
     |               |                |
 PAPER TRADING   ASSISTED LIVE    CONTROLLED AUTO
     |               |                |
     +---------------+----------------+
                     |
             TRADE MONITORING
                     |
          SL / TARGET / EXIT / P&L
                     |
              OUTCOME RECORDING
                     |
           PERFORMANCE ANALYTICS
                     |
          STRATEGY LEARNING ENGINE
                     |
           CONFIDENCE CALIBRATION
                     |
              LEARNING DATABASE
                     |
           FUTURE RESEARCH IMPROVEMENT
```

The Telegram and Independent Opportunity pipelines must operate independently. One pipeline must not depend on the other to generate opportunities.

Both must converge into the same common research and risk infrastructure.

---

# PART 3 — ALL 16 REQUIRED PRODUCT MODULES

## MODULE 01 — Signal Intelligence & Telegram Integration

**Purpose:** Capture, preserve and understand Telegram trading signals.

### Required functionality
- Multiple Telegram channel support.
- Real-time message listener.
- Channel management.
- Raw message storage.
- Message parsing and structured extraction.
- Signal identification.
- Message edit and delete tracking.
- Duplicate detection.
- Malformed signal detection.
- Delayed signal detection.
- Signal freshness and validity.
- Channel health monitoring.
- Historical message ingestion.
- Source reliability tracking.

### Information to extract
- Symbol and underlying.
- CE / PE.
- Strike price.
- Expiry.
- Entry price or entry range.
- Stop-loss.
- Multiple targets.
- Signal timestamp.
- Signal type.
- Intraday, positional, scalping or other strategy classification.
- Relevant instructions and conditions.

### Important behaviour
The original Telegram message must never be overwritten. Store original content, revisions, edits and deletions as separate evidence events.

## MODULE 02 — Signal Understanding & Classification

**Purpose:** Convert raw messages into structured, understandable trading setups.

### Required functionality
- Signal type classification.
- Market and instrument identification.
- Strategy identification.
- Breakout classification.
- Reversal classification.
- Momentum classification.
- Gap strategy classification.
- Scalping classification.
- Entry condition extraction.
- Exit pattern extraction.
- Risk-profile identification.
- Setup-context reconstruction.
- Structure validation.

### Output
A structured signal object containing the original message reference, instrument details, entry conditions, stop-loss, targets, strategy type, risk characteristics and classification confidence.

## MODULE 03 — Evidence Ledger & Historical Pattern Intelligence

**Purpose:** Maintain the complete evidence history behind every signal and decision.

### Required functionality
- Immutable original message storage.
- Edit and deletion history.
- Signal revision tracking.
- Evidence references.
- Historical signal database.
- Similar signal matching.
- Pattern library.
- Setup similarity analysis.
- Market-regime matching.
- Volatility matching.
- Time-of-day matching.
- Historical outcome matching.
- Evidence completeness checks.

### Output
Every decision must be traceable to its source evidence, research results, historical comparisons and relevant revisions.

## MODULE 04 — Research & Validation AI Agents

**Purpose:** Independently research and validate every trade candidate.

### The 12 specialist agents

| No. | Agent | Main responsibility |
|---|---|---|
| 1 | Signal Integrity Agent | Check signal structure, freshness and consistency |
| 2 | Instrument Validation Agent | Validate symbol, expiry, strike and contract |
| 3 | Market Context Agent | Understand market direction and context |
| 4 | Technical Structure Agent | Analyse technical indicators and market structure |
| 5 | Price Action Agent | Analyse price behaviour, support and resistance |
| 6 | News & Sentiment Agent | Analyse news, sentiment and relevant events |
| 7 | Liquidity Agent | Validate liquidity, spreads and execution conditions |
| 8 | Historical Pattern Agent | Compare similar historical setups and outcomes |
| 9 | Calendar & Macro Agent | Analyse macroeconomic events and calendar risk |
| 10 | Index Constituents Agent | Analyse index components and broader exposure |
| 11 | Independent Challenger Agent | Challenge assumptions and identify opposing evidence |
| 12 | Research Synthesis Agent | Consolidate agent findings into a final research assessment |

The existing audit also identifies an additional `options-risk-v1` agent. Preserve and map it appropriately rather than silently removing it.

### Agent responsibilities
Each agent must have:
- Clearly defined input schema.
- Clearly defined output schema.
- Evidence references.
- Confidence or assessment fields where applicable.
- Reasoning summary.
- Risk flags.
- Execution status.
- Error and unavailable-state handling.

### Verdict vocabulary
- SUPPORTIVE
- CAUTION
- NEUTRAL
- ADVERSE
- INCOMPLETE
- BLOCKING

Agents must be able to report missing or unavailable evidence. Missing data must not be treated as positive evidence.

## MODULE 05 — Market Intelligence & Regime Detection

**Purpose:** Understand the current market environment.

### Required functionality
- Trending market detection.
- Range-bound market detection.
- Volatile market detection.
- Risk-off market detection.
- Bullish and bearish market assessment.
- Volatility regime detection.
- Implied volatility analysis.
- Event-risk assessment.
- Multi-timeframe analysis.
- 5-minute analysis.
- 15-minute analysis.
- 1-hour analysis.
- Market structure.
- Correlated index exposure.

### Output
A structured market-regime object containing market direction, regime classification, volatility, event risk, relevant timeframes and evidence freshness.

## MODULE 06 — Channel Strategy Learning Engine

**Purpose:** Learn how individual Telegram channels actually trade.

### Required functionality
- Identify entry style.
- Identify CE / PE preference.
- Identify strike-distance preference.
- Identify preferred trading times.
- Identify market conditions used by the channel.
- Detect recurring strategy clusters.
- Identify breakout strategies.
- Identify reversal strategies.
- Identify momentum strategies.
- Identify gap strategies.
- Identify scalping strategies.
- Infer entry rules.
- Infer exit rules.
- Infer stop-loss rules.
- Infer target rules.
- Infer risk behaviour.

### Channel performance intelligence
- Conditional win rates.
- Historical profitability.
- Best market conditions.
- Worst market conditions.
- Performance by time of day.
- Performance by instrument.
- Performance by market regime.
- Strategy confidence.
- Strategy classification.
- Playbook generation.

### Channel playbook
Every learned playbook must contain:
- Strategy description.
- Entry context.
- Entry rules.
- Exit rules.
- Stop-loss behaviour.
- Target behaviour.
- Risk rules.
- Preferred instruments.
- Preferred market regimes.
- Historical performance.
- Sample size.
- Confidence and limitations.
- Version history.

## MODULE 07 — Strategy Intelligence & Learning Database

**Purpose:** Maintain long-term strategy intelligence.

### Required functionality
- Strategy inference.
- Pattern-to-outcome mapping.
- Outcome-reason analysis.
- Conditional win rates.
- Evidence chain.
- Playbook versioning.
- Performance tracking.
- Strategy rollback.
- Strategy drift detection.
- Strategy degradation alerts.
- Source profiles.
- Regime-specific performance.
- Time-specific performance.
- Instrument-specific performance.
- Stop-loss behaviour analysis.
- Signal revision and staleness analysis.
- Counterfactual review.

### Important rule
Learning must be versioned. A new strategy version must be evaluated before it can influence live decision policies.

## MODULE 08 — Capital Management & Position Sizing

**Purpose:** Calculate position size for each individual user.

### User-specific information
- Total trading capital.
- Available capital.
- Risk percentage.
- Maximum risk per trade.
- Maximum daily loss.
- Maximum concurrent positions.
- Trading budget.
- Preferred instruments.
- User permissions.
- Broker account reference.

### Calculations
- Maximum permissible trade risk.
- Risk per lot.
- Number of lots.
- Expected profit.
- Expected loss.
- Risk-to-reward ratio.
- Break-even price.
- Capital utilisation.
- Portfolio exposure.
- Remaining daily risk capacity.

### Calculation principles
Use deterministic calculation code, not an LLM, for monetary calculations.

Illustrative formulas:

`Maximum Risk = Capital × Risk Percentage`

`Risk per Lot = Absolute(Entry − Stop Loss) × Contract Lot Size`

`Permitted Lots = Floor(Maximum Risk / Risk per Lot)`

`Expected P&L = Price Movement × Contract Lot Size × Number of Lots`

Actual calculations must additionally account for:
- Current exchange contract specifications.
- Brokerage.
- Taxes and statutory charges.
- Slippage.
- Spread.
- Instrument-specific payoff behaviour.
- Available funds and margin.
- Applicable broker restrictions.

The formulas above are conceptual and must be adapted for options, futures and other supported instruments.

## MODULE 09 — Confidence Scoring & Signal Strength

**Purpose:** Produce a transparent and calibrated assessment of each candidate.

### Required inputs
- Agent assessments.
- Historical outcomes.
- Market regime.
- Technical structure.
- Price action.
- News and sentiment.
- Liquidity.
- Pattern similarity.
- Risk flags.
- Evidence completeness.
- Data freshness.
- Strategy reliability.

### Required outputs
- Overall confidence score.
- Supporting evidence.
- Contradicting evidence.
- Missing evidence.
- Risk flags.
- Historical comparison.
- Confidence explanation.
- Calibration status.

### Important rules
- Confidence is not automatically the probability of winning.
- Historical win rate and AI confidence must be separate metrics.
- Confidence must be calibrated using out-of-sample results.
- Hard risk restrictions must always override confidence.
- The PDF's proposed sizing tiers are reference proposals, not validated production rules.

## MODULE 10 — Risk Management & Capital Protection

**Purpose:** Prevent unacceptable trading risk.

### Required controls
- Maximum risk per trade.
- Stop-loss validation.
- Maximum loss per trade.
- Maximum daily loss.
- Portfolio exposure.
- Maximum concurrent positions.
- Correlated index exposure.
- Event-risk restrictions.
- Drawdown controls.
- High-volatility restrictions.
- Low-liquidity restrictions.
- Market closing-time restrictions.
- Maximum lot limits.
- Minimum risk-to-reward requirements.
- Daily loss halt.
- Drawdown halt.
- Adaptive risk reduction.
- Correlation controls.
- Optional research-only Kelly analysis.

### Kill switches
- Global kill switch.
- Per-market kill switch.
- Per-source kill switch.
- Per-strategy kill switch.
- Daily-loss kill switch.
- Drawdown kill switch.

A kill switch must prevent new prohibited activity. Its behaviour for open positions and emergency exits must be explicitly defined and tested.

## MODULE 11 — Pre-Trade What-If Simulator

**Purpose:** Simulate potential outcomes before a trade is approved.

### Required functionality
- Stop-loss loss calculation.
- Target profit calculation.
- Break-even calculation.
- Implied-move analysis.
- Gap-risk analysis.
- Portfolio impact.
- Multiple-lot simulation.
- Different entry-price comparison.
- Different stop-loss comparison.
- Risk-to-reward comparison.
- Cost and slippage estimation.
- Scenario comparison.

### Output
A scenario report showing expected profit, expected loss, capital usage, risk percentage, break-even and portfolio impact.

## MODULE 12 — Decision Engine & Explainable Decisions

**Purpose:** Convert research and risk results into a final actionable decision.

### Decision outcomes
- QUALIFIED
- WAIT
- REJECT
- EVALUATION_ONLY
- NO_TRADE

The decision engine must also support workflow states such as:
- PENDING
- APPROVED
- REJECTED
- EXPIRED
- SUPERSEDED
- CANCELLED

These are different concepts: decision outcomes describe the assessment; workflow states describe the lifecycle.

### Required functionality
- Evidence-based decision.
- Research synthesis.
- Risk validation.
- User-specific eligibility.
- Decision validity window.
- Signal cancellation.
- Revalidation.
- Stale-decision detection.
- Contradiction handling.
- Human-readable explanation.

### Explainable decision package
Every decision must explain:
- Why it qualified.
- Why it did not qualify.
- Why a larger position was not permitted.
- What evidence supports it.
- What risks remain.
- What would invalidate it.
- Which historical patterns are comparable.
- Which agents agreed or disagreed.

## MODULE 13 — Human Approval & Execution

**Purpose:** Allow controlled execution after research and risk approval.

### Approval interface
- Telegram approval bot.
- Approval cards.
- Signal summary.
- Evidence summary.
- Confidence assessment.
- Risk assessment.
- Suggested quantity.
- Entry, SL and target.
- Approve / reject / watch actions.
- Approval expiry.
- Eligibility recheck.

### Three execution modes

**Mode A — Paper Trading**
- Simulated order placement.
- Simulated fills.
- Simulated trade lifecycle.
- P&L calculation.
- Trade history.
- No real money.

**Mode B — Assisted Live**
- User reviews the proposed order.
- User explicitly confirms each live order.
- System rechecks risk and eligibility.
- Broker adapter executes only after valid authorisation.
- Order and fill status are reconciled.

**Mode C — Controlled Auto**
- Explicitly authorised automation.
- Pre-approved strategy and risk policy.
- Strict capital and quantity limits.
- Kill switches.
- Order monitoring.
- Emergency stop.
- Complete audit trail.

Live execution modes must remain disabled until broker, security, legal, regulatory, exchange and data-provider requirements have been verified. A private group of 10 users is not automatically exempt from applicable requirements.

## MODULE 14 — Trade Management & Monitoring

**Purpose:** Monitor every approved or executed trade.

### Required functionality
- Entry tracking.
- Live P&L.
- Stop-loss monitoring.
- Target monitoring.
- Trailing stop.
- Time-based exit.
- Risk breach alerts.
- Stop-loss-hit status.
- Target-hit status.
- Partial exit handling.
- Trade status.
- Position reconciliation.
- Outcome recording.

The platform must distinguish between a proposed order, submitted order, accepted order, actual fill, open position and completed trade.

## MODULE 15 — Outcome Learning & Performance Analytics

**Purpose:** Learn from actual trade outcomes.

### Required analytics
- Actual versus predicted results.
- Outcome reasons.
- Channel performance.
- Pattern performance.
- Strategy performance.
- Confidence calibration.
- Agent contribution.
- Entry timing quality.
- Stop-loss quality.
- Target quality.
- Exit quality.
- Verdict accuracy.
- Strategy attribution.
- Source-confidence adjustment.
- Historical performance trends.

### Learning loop

`Decision → Execution → Monitoring → Outcome → Attribution → Learning → Versioned Strategy Update`

The system must distinguish paper results from actual live fills. Paper outcomes must not be presented as real-money performance.

## MODULE 16 — Independent Opportunity Engine

**Purpose:** Find opportunities even when no Telegram signal exists.

### Required functionality
- Independent market scanning.
- Pattern detection.
- Market-regime analysis.
- Technical setup detection.
- Price-action confluence.
- Macro and calendar analysis.
- Historical pattern matching.
- Risk-to-reward screening.
- Candidate generation.
- Candidate ranking.
- Opportunity evidence creation.
- Candidate expiry.
- Revalidation.

### Opportunity generation flow

`Market Scan → Candidate Detection → Setup Classification → Evidence Collection → Historical Matching → Common Research Engine → Risk Engine → Simulator → Decision Engine`

This module is a separate source of trade candidates, not just a challenger for Telegram signals.

---

# PART 4 — USER MANAGEMENT AND MULTI-USER ARCHITECTURE

TWINS must support 10 individual users without pooling their money.

## Individual user profile

Each user must have:
- Separate account.
- Secure authentication.
- Individual capital.
- Individual available balance.
- Individual risk percentage.
- Individual daily loss limit.
- Individual position limits.
- Individual trading permissions.
- Individual broker connection.
- Individual approval settings.
- Individual portfolio.
- Individual trade history.
- Individual analytics.

## Data isolation

All user-specific data must be protected by an enforceable user and account ownership model.

One user must never be able to:
- View another user's private broker details.
- Access another user's capital.
- Approve another user's trade.
- Modify another user's risk settings.
- View another user's private trade history.

Use explicit authorisation checks at API, service and database-access boundaries. A frontend-only restriction is insufficient.

## Shared versus private information

**Shared platform intelligence:**
- General market research.
- Public news.
- General strategy patterns.
- Non-identifying aggregate research, where permitted.

**Private user information:**
- Capital.
- Broker credentials.
- Orders and fills.
- Positions.
- Personal risk settings.
- Account balance.
- Private trading history.

---

# PART 5 — COMPLETE TECHNICAL ARCHITECTURE

The existing project should be extended, not unnecessarily rewritten.

## 5.1 Backend

Preserve the existing TypeScript/Node.js, Fastify, BullMQ, Redis and PostgreSQL/Drizzle architecture where the audit confirms it is appropriate.

Core backend domains:

1. Authentication and user management.
2. Telegram ingestion.
3. Signal parsing.
4. Signal classification.
5. Evidence ledger.
6. Historical intelligence.
7. Research orchestration.
8. Agent execution.
9. Market intelligence.
10. Channel strategy learning.
11. Independent opportunity generation.
12. Capital and position sizing.
13. Risk management.
14. What-if simulation.
15. Confidence scoring.
16. Decision management.
17. Approval workflows.
18. Execution management.
19. Trade monitoring.
20. Performance analytics.
21. Learning and strategy versioning.
22. Audit and administration.

## 5.2 AI intelligence layer

Build a provider-independent AI architecture.

Required components:
- AI provider interface.
- Hosted LLM provider adapters.
- Model selection and routing.
- Structured output validation.
- Prompt and agent versioning.
- Tool calling.
- Retry and timeout handling.
- Token usage tracking.
- Cost tracking.
- Provider failure handling.
- Response provenance.
- Agent execution logs.

Use hosted AI providers. Do not make local Ollama or a local LLM a platform requirement.

LLMs may assist with interpretation, research synthesis and strategy discovery. Deterministic code must control financial arithmetic, permissions, risk limits and execution eligibility.

## 5.3 Database

The audit reports an existing PostgreSQL database with 81 tables and 33 migrations. Preserve and extend the existing schema where appropriate.

Required logical domains:

- Users and authentication.
- User accounts.
- User capital profiles.
- Risk policies.
- Broker connections.
- Telegram channels.
- Telegram messages and revisions.
- Signals and signal classifications.
- Evidence ledger.
- Historical data.
- Market data.
- News and events.
- Agent runs and findings.
- Research packages.
- Market regimes.
- Strategies and playbooks.
- Pattern library.
- Opportunity candidates.
- Confidence assessments.
- Risk assessments.
- Simulations.
- Decisions.
- Approvals.
- Orders.
- Fills.
- Positions.
- Trades.
- Monitoring events.
- Outcomes.
- Analytics.
- Learning versions.
- Audit logs.

Do not create duplicate tables simply because a new module is being introduced. First map existing tables, ownership, relationships, constraints and migration history.

## 5.4 Frontend

Preserve the separate Next.js frontend repository.

The final UI must include the following main screens:

1. Login and authentication.
2. Main dashboard.
3. Market overview.
4. Telegram channels.
5. Signal intake.
6. Signal details.
7. Signal history.
8. Evidence explorer.
9. Research workspace.
10. Agent intelligence.
11. Channel strategy intelligence.
12. Strategy playbooks.
13. Independent opportunities.
14. Decision centre.
15. Decision detail.
16. Risk dashboard.
17. Capital management.
18. What-if simulator.
19. Approval centre.
20. Paper trading.
21. Live execution controls.
22. Orders and fills.
23. Open positions.
24. Trade monitoring.
25. P&L and analytics.
26. Learning and performance.
27. Notifications.
28. User settings.
29. Broker settings.
30. Administration and audit.

Each screen must have real backend contracts and defined loading, empty, error, stale-data and permission states. Do not leave production screens dependent on hardcoded sample data.

---

# PART 6 — MASTER DEVELOPMENT ROADMAP

## DEVELOPMENT PRINCIPLE

The requested order is:

**Complete the product modules first → External integrations second → Full testing and validation third.**

This does not mean writing disconnected modules. Every module must be designed with its data contracts, database relationships and internal service interfaces so the platform can be connected coherently later.

## PHASE 00 — Existing Build Baseline and Preservation

**Goal:** Establish the exact starting point.

Tasks:
- Audit the backend repository.
- Audit the separate frontend repository.
- Map all existing packages and services.
- Map all 81 reported database tables.
- Review all 33 reported migrations.
- Map all existing API routes.
- Map existing agents.
- Map existing risk engine.
- Map existing signal parser.
- Map evidence ledger.
- Map paper engine.
- Map Kite read-only adapter.
- Identify incomplete and unused code.
- Identify duplicate implementations.
- Identify stale documentation.
- Record current commit and working-tree status.

**Deliverable:** Existing Build Baseline + 16-Module Gap Matrix.

**Completion condition:** Every existing component is classified as reuse, extend, replace with justification, or missing.

No existing code is removed merely because a new architecture is being planned.

## PHASE 01 — Complete Platform Foundation

**Goal:** Establish the complete internal platform foundation.

Tasks:
- Finalise domain architecture.
- Finalise module boundaries.
- Define shared data contracts.
- Define event contracts.
- Define API contracts.
- Define database ownership and relationships.
- Define authentication and authorisation.
- Define user isolation.
- Define configuration management.
- Define audit logging.
- Define error handling.
- Define background-job conventions.
- Define AI provider interface.
- Define execution safety boundaries.

**Deliverable:** Complete platform foundation and architecture.

## PHASE 02 — Complete Database and Domain Models

**Goal:** Make every required product concept representable in the database.

Tasks:
- User and account models.
- Individual capital and risk profiles.
- Signal and signal-revision models.
- Telegram channel and message models.
- Evidence models.
- Historical intelligence models.
- Agent execution and findings.
- Market regime models.
- Strategy and playbook models.
- Opportunity candidate models.
- Confidence and risk assessment models.
- Simulation models.
- Decision and approval models.
- Orders, fills and positions.
- Trade and outcome models.
- Analytics and learning models.
- Audit and versioning models.

Reuse existing schemas where possible. Use controlled migrations for required changes.

**Deliverable:** Complete database model supporting all 16 modules.

## PHASE 03 — Complete Telegram Intelligence Modules

**Goal:** Finish the complete Telegram-side product logic.

Build:
- Module 01: Signal Intelligence.
- Module 02: Signal Understanding.
- Module 03: Evidence Ledger.
- Module 06: Channel Strategy Learning.
- Module 07: Strategy Intelligence.

Deliverables:
- Complete signal domain.
- Complete classification domain.
- Evidence and revision history.
- Historical pattern representation.
- Channel strategy profiles.
- Strategy playbooks.
- Performance and versioning structures.

External Telegram connectivity is reserved for the integrations phase. Build and complete the internal processing capabilities first.

## PHASE 04 — Complete Research and Market Intelligence

**Goal:** Finish the full research system.

Build:
- Module 04: Research and Validation Agents.
- Module 05: Market Intelligence and Regime Detection.

Deliverables:
- All 12 specialist agent implementations.
- Agent input and output contracts.
- Research orchestration.
- Synthesis and challenger workflows.
- Evidence and verdict handling.
- Market regime domain.
- Multi-timeframe analysis interfaces.
- Missing-data and unavailable-state handling.

Preserve and map the existing deterministic agents. Add LLM capabilities through the AI provider architecture where needed, without making financial decisions dependent on unverified generated text.

## PHASE 05 — Complete Independent Opportunity Engine

**Goal:** Build a genuinely independent source of trading candidates.

Tasks:
- Candidate generation architecture.
- Market scanning logic.
- Setup classification.
- Pattern identification.
- Technical confluence.
- Price-action conditions.
- Regime suitability.
- Historical similarity.
- Candidate ranking.
- Evidence generation.
- Candidate expiry and revalidation.

**Deliverable:** Independent Opportunity Engine capable of producing candidates without Telegram signals.

## PHASE 06 — Complete Capital, Risk and Simulation

**Goal:** Complete all financial calculations and protective logic.

Build:
- Module 08: Capital Management and Position Sizing.
- Module 09: Confidence Scoring.
- Module 10: Risk Management.
- Module 11: What-If Simulator.

Tasks:
- Per-user capital calculation.
- Per-user risk policies.
- Instrument-specific sizing.
- Contract and lot specification model.
- Charges and slippage calculation framework.
- Portfolio exposure.
- Correlation and drawdown controls.
- Kill switches.
- Confidence calibration architecture.
- Single-trade simulations.
- Multi-lot scenario comparisons.

**Deliverable:** Complete deterministic capital and risk system.

## PHASE 07 — Complete Decision and Execution Workflows

**Goal:** Finish the full decision lifecycle.

Build:
- Module 12: Decision Engine.
- Module 13: Approval and Execution.
- Module 14: Trade Management and Monitoring.

Tasks:
- Decision vocabulary.
- Decision lifecycle.
- Evidence package.
- Qualification and rejection rules.
- Expiry and cancellation.
- Revalidation.
- Approval workflow.
- Paper execution lifecycle.
- Assisted-live workflow.
- Controlled-auto policy framework.
- Order/fill/position lifecycle.
- Monitoring and exit-state models.

**Deliverable:** Complete execution lifecycle architecture.

Live execution must remain disabled until its separate regulatory, security, broker and integration gates are passed.

## PHASE 08 — Complete Learning and Analytics

**Goal:** Finish the feedback and improvement system.

Build:
- Module 15: Outcome Learning and Performance Analytics.
- Strategy performance dashboards.
- Channel performance dashboards.
- Confidence calibration reports.
- Agent contribution reports.
- Outcome attribution.
- Strategy versioning.
- Drift detection.
- Degradation alerts.
- Counterfactual analysis.
- Learning review and rollback.

**Deliverable:** Complete learning and analytics layer.

## PHASE 09 — Complete Frontend and User Experience

**Goal:** Finish all product screens and workflows before external integrations.

Tasks:
- Complete all 30 screen areas.
- User-specific dashboards.
- Telegram intelligence screens.
- Research and agent screens.
- Strategy intelligence screens.
- Independent opportunity screens.
- Capital and risk screens.
- What-if simulator.
- Decision centre.
- Approval screens.
- Paper-trading screens.
- Trade monitoring.
- Performance analytics.
- User settings.
- Admin and audit screens.

Every screen must be connected to defined internal API contracts and must support realistic application states. Where external data is not yet integrated, use clearly labelled development fixtures or simulated data.

**Deliverable:** Complete frontend and backend product functionality, with all 16 modules represented.

## PHASE 10 — Complete External Integrations

**Goal:** Connect the completed platform to real external services.

Integration categories:

### A. Telegram
- Telegram API/client.
- Channel authentication.
- Channel listeners.
- Message history.
- Message updates and deletions.
- Reconnection and health monitoring.

### B. Market data
- NSE-related market data sources.
- Historical prices.
- Live quotes.
- Candles and timeframes.
- Futures and options data.
- Contract specifications.
- Market depth and liquidity data where licensed and available.

### C. News and macro
- News providers.
- Sentiment sources.
- Economic calendar.
- Macro indicators.
- Global market information.
- Corporate and index events.

### D. AI providers
- Hosted LLM providers.
- Provider routing.
- Structured outputs.
- Usage and cost tracking.
- Fallback handling.

### E. Broker integration
- Broker authentication.
- Account information.
- Order placement.
- Order modification and cancellation.
- Fill updates.
- Positions.
- Reconciliation.
- Rate limits and error handling.

### F. Notifications
- Telegram bot.
- User alerts.
- Approval notifications.
- Risk alerts.
- System health alerts.

### G. Infrastructure
- Redis and queues.
- PostgreSQL backups.
- Object storage where required.
- Secrets management.
- Monitoring and alerting.
- Deployment configuration.

**Deliverable:** Connected platform with real external data and service capabilities.

Every provider must be checked for API availability, commercial terms, rate limits, data rights, costs and permitted use. Do not assume that a provider offers unrestricted or free access.

## PHASE 11 — Complete Testing and Validation

**Goal:** Validate the entire system, not just individual functions.

### Testing categories

**1. Unit testing**
- Parser.
- Classifier.
- Agents.
- Risk engine.
- Position sizing.
- Confidence calculations.
- Simulator.
- Decision engine.
- Strategy learning.
- Outcome attribution.

**2. Database testing**
- Migrations.
- Relationships.
- Constraints.
- Transactions.
- User isolation.
- Historical records.
- Revision immutability.
- Rollback and recovery.

**3. API testing**
- Authentication.
- Authorisation.
- Validation.
- Rate limiting.
- Error responses.
- User permissions.
- API contracts.

**4. Integration testing**
- Telegram ingestion.
- Market data ingestion.
- News ingestion.
- AI providers.
- Queue processing.
- Broker sandbox.
- Notifications.
- Data reconciliation.

**5. End-to-end testing**
- Telegram signal to decision.
- Independent candidate to decision.
- Decision to paper trade.
- Paper trade to outcome.
- Assisted-live workflow in a broker sandbox.
- User-specific capital and risk.
- Strategy learning loop.

**6. Financial correctness testing**
- Lot-size accuracy.
- Entry and stop-loss calculations.
- Charges.
- Slippage.
- P&L.
- Options payoff calculations.
- Portfolio exposure.
- Daily loss.
- Drawdown.
- Correlation.
- Margin and available funds.

**7. Security testing**
- Authentication.
- User isolation.
- Credential protection.
- API permissions.
- Secrets management.
- Audit logs.
- Abuse and rate-limit controls.
- Execution authorisation.

**8. Performance and resilience**
- Queue backlogs.
- High message volume.
- Provider outages.
- Redis failure.
- Database failure.
- Reconnection.
- Duplicate events.
- Retry behaviour.
- Recovery.

**9. Paper-trading validation**
- Real market data.
- Realistic spreads and slippage.
- Actual market hours.
- Contract expiry.
- Order lifecycle simulation.
- Position reconciliation.
- Performance attribution.

**10. Live-readiness validation**
- Broker sandbox validation.
- Order and fill reconciliation.
- Kill-switch verification.
- Emergency-stop behaviour.
- Regulatory and compliance review.
- Explicit user authorisation.

**Deliverable:** Complete test reports, defect register, security report, performance report and live-readiness assessment.

---

# PART 7 — FINAL DELIVERY GATES

The product must not be called complete just because code has been written or unit tests pass.

| Gate | Required result |
|---|---|
| Gate 1 | All 16 modules implemented |
| Gate 2 | All 12 specialist agents implemented |
| Gate 3 | Independent Opportunity Engine implemented |
| Gate 4 | All user-specific capital and risk models implemented |
| Gate 5 | Complete backend and database domain coverage |
| Gate 6 | All required frontend screens implemented |
| Gate 7 | Telegram and market-data integrations operational |
| Gate 8 | AI providers operational with structured outputs |
| Gate 9 | Broker integration validated in permitted sandbox |
| Gate 10 | Full automated test suite passed |
| Gate 11 | Security and user-isolation review passed |
| Gate 12 | Paper-trading validation completed |
| Gate 13 | Live execution regulatory and operational approval obtained |

A gate can only be marked complete when supported by evidence, not by an assumption or a placeholder.

---

# PART 8 — EXISTING BUILD VS FINAL PRODUCT

Based on the Claude Code Phase 00 audit report, the following is the initial preservation and gap-mapping position. These are audit-reported findings, not independently verified repository findings.

| Area | Audit-reported existing state | Target |
|---|---|---|
| Telegram capture | Implemented | Complete and production-ready |
| Signal parser | Implemented, parser v3 | Complete classification and lifecycle |
| Evidence ledger | Implemented | Complete evidence intelligence |
| Historical imports | Implemented | Full historical pattern intelligence |
| 12 agents | Deterministic rule-based implementations | Full research and validation system |
| AI provider layer | Interface contract only | Hosted LLM integration and routing |
| Risk engine | Significant deterministic functionality | Complete per-user risk controls |
| Position sizing | Existing implementation; single configured capital | Individual user sizing and full cost model |
| What-if simulator | Portfolio stress only | Complete single-trade and multi-lot simulator |
| Decision engine | Existing states differ from target vocabulary | Complete decision lifecycle |
| Approval bot | Existing but reported inactive | Complete approval workflow |
| Paper engine | Existing but reported inactive | Validated real-data paper trading |
| Kite adapter | Read-only | Separate approved execution adapter |
| Strategy learning | Historical and pattern foundations | Full channel playbooks and drift intelligence |
| Independent Opportunity Engine | Reported missing | Complete independent pipeline |
| Multi-user isolation | Reported incomplete | Secure 10-user architecture |
| Frontend | Separate repository; existing screens | Complete product experience |
| Monitoring | Existing foundations | Complete trade and system monitoring |
| Learning analytics | Partial foundations | Complete outcome feedback loop |

### Existing functionality to preserve

- Signal parser v3.
- Telegram capture.
- Evidence ledger.
- Audit chains.
- Risk engine.
- Existing kill-switch and live guard functionality.
- Agent contracts and orchestration.
- Historical import and scorecards.
- Pattern foundations.
- Paper engine.
- Read-only Kite integration.
- Egress controls.
- API and OpenAPI definitions.
- Existing CI and staging infrastructure.

### Missing or incomplete functionality to close

- Full hosted LLM architecture.
- Independent Opportunity Engine.
- Multi-user authentication and authorisation.
- Individual capital and risk.
- Full channel strategy learning.
- Playbooks and strategy drift.
- Full charges and brokerage model.
- Single-trade what-if simulator.
- Final decision vocabulary and lifecycle.
- Calibrated confidence.
- Complete market regime workflow.
- Economic calendar workflow.
- Full channel-management workflow.
- Per-user dashboards.
- Complete order, fill and position reconciliation.
- Production frontend workflows.

**Preservation rule:** Existing implementation must be examined before creating replacements. If existing code already satisfies a requirement, reuse it and add only what is missing.

---

# PART 9 — MASTER OPERATING RULES FOR DEVELOPMENT

1. Do not remove any feature from the original 16-module specification.
2. Do not reduce the 12-agent research architecture.
3. Do not turn TWINS into a Telegram-only system.
4. Do not omit the Independent Opportunity Engine.
5. Do not pool the 10 users' capital.
6. Do not share broker credentials between users.
7. Do not allow one user to access another user's private data.
8. Do not allow LLM output to bypass deterministic financial controls.
9. Do not allow confidence scores to override hard risk limits.
10. Do not make live execution available by default.
11. Do not rewrite working modules without a technical reason.
12. Do not introduce duplicate database structures without checking existing models.
13. Do not leave important frontend actions as non-functional mock buttons.
14. Do not label simulated results as real performance.
15. Do not mark a module complete without implementation evidence.
16. Do not mark testing complete based only on unit-test results.
17. Do not change the agreed architecture or development sequence without explaining the reason and obtaining approval.
18. Maintain clear documentation of what exists, what was added, what remains and how it was verified.

---

# PART 10 — FINAL DEVELOPMENT ORDER

The entire TWINS project must follow this order:

| Order | Stage | Main outcome |
|---|---|---|
| 00 | Existing Build Audit | Exact baseline and preservation map |
| 01 | Platform Foundation | Architecture and contracts |
| 02 | Database | Complete domain models |
| 03 | Telegram Intelligence | Modules 1, 2, 3, 6 and 7 |
| 04 | Research Intelligence | Modules 4 and 5 |
| 05 | Independent Opportunity Engine | Module 16 |
| 06 | Capital and Risk | Modules 8, 9, 10 and 11 |
| 07 | Decisions and Execution | Modules 12, 13 and 14 |
| 08 | Learning and Analytics | Module 15 |
| 09 | Frontend Completion | All product screens |
| 10 | External Integrations | Telegram, market data, AI, news, brokers |
| 11 | Testing and Validation | Full test and safety programme |
| 12 | Controlled Release | Paper first, then approved live modes |

## Final definition of TWINS

When the complete roadmap is delivered, TWINS must be capable of:

- Receiving and understanding Telegram signals.
- Learning the strategy and historical performance of each channel.
- Generating independent trading opportunities.
- Researching every opportunity through 12 specialist agents.
- Understanding market regimes.
- Comparing current setups against historical patterns.
- Assessing supporting and opposing evidence.
- Calculating confidence with calibration.
- Applying each user's individual capital and risk limits.
- Simulating trade outcomes before approval.
- Producing explainable decisions.
- Supporting paper, assisted-live and controlled-auto execution modes.
- Monitoring trades and positions.
- Recording actual outcomes.
- Learning from strategy and trade performance.
- Protecting each user's data, capital and permissions.

**The final goal is one complete, unified TWINS platform — not 16 disconnected tools, not a Telegram signal bot, and not a collection of AI agents without a controlled decision and execution system.**