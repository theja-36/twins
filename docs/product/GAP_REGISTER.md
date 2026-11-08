# Remaining gap register

Updated each stage. A gap closes only when the tracker shows the related requirements VERIFIED or IMPLEMENTED with evidence.

| ID | Gap | Stage | Status |
|---|---|---|---|
| G-01 | No per-user authentication, sessions, roles or row-level security (contracts and helpers exist; DB and routes do not) | 01-02 | open |
| G-02 | Capital profile, risk policy and permission TABLES exist (0033, unapplied); no service uses them and sizing still reads one configured capital | 06 | open |
| G-03 | Outcome vocabulary is in the schema (`user_decisions`, unapplied); the engine does not produce it | 07 | open |
| G-04 | Stage 03 logic is built, but is not yet fed real data: classification is not wired into live intake (owner-run backfill only), no loader maps real outcomes/regimes/edits into the learning inputs, structure-based setup detection needs market data, regime-based parts need Stage 04 | 03-04 | partly closed |
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
