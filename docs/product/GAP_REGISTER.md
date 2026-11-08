# Remaining gap register

Updated each stage. A gap closes only when the tracker shows the related requirements VERIFIED or IMPLEMENTED with evidence.

| ID | Gap | Stage | Status |
|---|---|---|---|
| G-01 | No per-user authentication, sessions, roles or row-level security (contracts and helpers exist; DB and routes do not) | 01-02 | open |
| G-02 | Capital profile, risk policy and permission TABLES exist (0033, unapplied); no service uses them and sizing still reads one configured capital | 06 | open |
| G-03 | Outcome vocabulary is in the schema (`user_decisions`, unapplied); the engine does not produce it | 07 | open |
| G-04 | Stage 03 logic is built, but is not yet fed real data: classification is wired into live intake behind TWINS_CLASSIFY_ON_INTAKE (default false; not enabled anywhere) and classifier accuracy on real messages is unmeasured (M02-15), no loader maps real outcomes/regimes/edits into the learning inputs, structure-based setup detection needs market data, regime-based parts need Stage 04 | 03-04 | partly closed |
| G-05 | Market Context agent missing; agents not yet on the spec contract; no LLM adapter | 04 | open |
| G-06 | Independent Opportunity Engine absent | 05 | open |
| G-07 | Charges/brokerage model, single-trade what-if simulator, calibrated 0-100 confidence | 06 | open |
| G-08 | Assisted-live and controlled-auto flows, broker reconciliation | 07 | open |
| G-09 | Outcome learning loop, calibration reports, counterfactuals | 08 | open |
| G-10 | Frontend: auth and 30 screens on real contracts | 09 | open |
| G-11 | No Postgres/Docker locally: database changes are verified only by CI after a push (each push is a feature-branch push) | all | environment limit |
| G-12 | Classic frontend bot link never enables in production builds (env read not inlined); fix is uncommitted in the frontend working copy | 09 | open |
| G-13 | `users.role` can be changed by any role holding UPDATE on `users` (the runtime role does today). No code does it, but role escalation must be closed when the auth service is built (definer function or revoke) | 01-02 follow-up | open |
| G-14 | `performance_snapshots` and other shared tables have no per-writer restriction beyond role grants | 08 | open |
| G-15 | No hosted AI adapter exists: the gateway runs only against fixtures until Stage 10 (needs provider credentials and an approved budget) | 04/10 | open, by design |
| G-16 | No live regime source: `market-context-v1` reports UNAVAILABLE until a `RegimeProvider` is wired to real OHLC data; regime rows exist only from fixtures/tests | 04/10 | open |
| G-17 | Dispatch half RESOLVED in Stage 05: the worker's opportunity cycle claims any NEW candidate and calls `runCandidateResearch` (CI green). The Telegram-side half moved to G-19 | 04/05 | dispatch resolved (CI run 42459457501); see G-19 |
| G-18 | Candidate research gives `stop_loss_validation = null`; the decision engine (Stage 07) must run the mandatory stop-loss rule itself | 07 | CLOSED in Stage 07 (CI green, run 42466542084): the decision engine runs the full packages/stop-loss validation on every QUALIFIED path, the persistence door and migration 0038 refuse a QUALIFIED decision without a VALID recorded validation, and approval and execution re-run it; proof in tests/unit/safety/qualifiedProducerStage07.test.ts |
| G-19 | Telegram claims are not materialised as `opportunity_candidates` (nothing converts a stored claim into a TELEGRAM-source candidate), so the shared research dispatcher has only independent candidates to work on | 05/07 | open |
| G-20 | No live market-data provider: the engine scans file/in-memory OHLC and last-price snapshots only, labelled FIXTURE by default; live scanning, live revalidation prices and real-data setup accuracy are unproven | 05/10 | open, by design |
| G-21 | Setup rules (breakout, reversal, momentum) are not backtested or calibrated; the rank is an ordering heuristic with no performance claim | 05/08 | open |
| G-22 | PAPER half resolved in Stage 07 (`paperPortfolioProvider`: open paper positions and today's paper result; no equity curve, so drawdown stays unevaluated). The LIVE half stays open. Original text: No portfolio-state source: open positions, today's realised loss and the equity curve have no provider (and no position tracking exists until Stage 07/08). The worker passes none, so every real evaluation is BLOCKED (PORTFOLIO_STATE_UNAVAILABLE) and the daily-loss / drawdown halts cannot trigger from real data | 06/07 | open |
| G-23 | No instrument specification or fee schedule is loaded (nothing is built in by design), and no quote or strategy-performance provider is wired: instruments are BLOCKED until an operator supplies an official specification file (`TWINS_SPECS_FILE`) | 06/10 | open, by design |
| G-24 | Confidence is uncalibrated and cannot be calibrated until resolved outcomes exist (Stage 08); the specification's sizing tiers are deliberately not implemented | 06/08 | open, by design |
| G-25 | No margin model: selling futures/options is not sized; implied-move analysis (M11-04) needs implied-volatility / option-chain data | 06/10 | open |
| G-26 | No user-facing approval API or notification delivery: authentication sessions, login and per-route permissions (Stage 01) do not exist, so a route could not know who approves; approval cards are contracts, delivery needs Stage 10. Approvals run through the owner-run `decision:control` CLI | 01/07/10 | open, by design |
| G-27 | No WATCH action and no comparable-historical-pattern listing on decisions (M13-09, M12-28) | 07/10 | open |
| G-28 | Two paper systems coexist: the legacy signal pipeline (`packages/paper`, `paper_trades`) and the master-build path (`paper_*`). They are separate on purpose; consolidating them is a later decision | 07 | open, by design |
| G-29 | Paper monitoring uses only the file last-price snapshot declared FIXTURE; there is no live price feed (same cause as G-20). A paper P&L shown anywhere must say it is simulated | 07/10 | open, by design |
| G-30 | No real-price outcomes: every paper outcome is FIXTURE-backed, so no performance, drift or calibration result is validated. Analytics report this explicitly (NOT_VALIDATED_FIXTURE); it clears only with a live or historical price source and enough real-price paper trades (depends on G-20 / G-29) | 08/10 | open, by design |
| G-31 | Outcome records lack excursions (MAE / MFE), a reference price for slippage, regime during the trade, and playbook-version attribution, so entry timing, stop and target placement quality, slippage and playbook-level performance cannot be assessed (M15-08..10 limits) | 08 | open |
| G-32 | Unexecuted-decision estimates (M15-12) need later price bars; no OHLC provider is wired into the learning job, so they report UNAVAILABLE | 08/10 | open |
| G-33 | The learning job processes at most TWINS_LEARNING_MAX_USERS (default 200) users per run in id order, skipping users with no paper activity; there is no rotation, which is acceptable for a single-user deployment and must be revisited before multi-user operation | 08/Stage 01 | open |
