# Remaining gap register

Updated each stage. A gap closes only when the tracker shows the related requirements VERIFIED or IMPLEMENTED with evidence.

| ID | Gap | Stage | Status |
|---|---|---|---|
| G-01 | No per-user authentication, sessions, roles or row-level security (contracts and helpers exist; DB and routes do not) | 01-02 | open |
| G-02 | No user capital profile, per-user risk policy or per-user broker connection rows in use | 02, 06 | open |
| G-03 | Decision outcome vocabulary not in the database or engine | 02, 07 | open |
| G-04 | Telegram classification (intraday/positional/scalping, setup types), channel playbooks, strategy versioning and drift | 03 | open |
| G-05 | Market Context agent missing; agents not yet on the spec contract; no LLM adapter | 04 | open |
| G-06 | Independent Opportunity Engine absent | 05 | open |
| G-07 | Charges/brokerage model, single-trade what-if simulator, calibrated 0-100 confidence | 06 | open |
| G-08 | Assisted-live and controlled-auto flows, broker reconciliation | 07 | open |
| G-09 | Outcome learning loop, calibration reports, counterfactuals | 08 | open |
| G-10 | Frontend: auth and 30 screens on real contracts | 09 | open |
| G-11 | No Postgres/Docker locally: migrations cannot be applied or integration-tested here | all | environment limit |
| G-12 | Classic frontend bot link never enables in production builds (env read not inlined); fix is uncommitted in the frontend working copy | 09 | open |
