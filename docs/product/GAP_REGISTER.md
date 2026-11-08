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
| G-18 | Candidate research gives `stop_loss_validation = null`; the decision engine (Stage 07) must run the mandatory stop-loss rule itself | 07 | open, by design |
| G-19 | Telegram claims are not materialised as `opportunity_candidates` (nothing converts a stored claim into a TELEGRAM-source candidate), so the shared research dispatcher has only independent candidates to work on | 05/07 | open |
| G-20 | No live market-data provider: the engine scans file/in-memory OHLC and last-price snapshots only, labelled FIXTURE by default; live scanning, live revalidation prices and real-data setup accuracy are unproven | 05/10 | open, by design |
| G-21 | Setup rules (breakout, reversal, momentum) are not backtested or calibrated; the rank is an ordering heuristic with no performance claim | 05/08 | open |
