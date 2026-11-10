# TWINS roadmap status, Stages 00 to 12 (evidence-based, 2026-11-09)

Status words are not interchangeable: IMPLEMENTED = code and local tests exist; TESTED = automated tests pass in CI; VERIFIED = proven against the stated acceptance criteria with linked evidence; BLOCKED = cannot proceed without an external input; DEFERRED = consciously postponed; NOT STARTED. The tracker (`tracker.json`, 421 requirements) has no DEFERRED state. Source: tracker counts, PROGRESS_LOG, GAP_REGISTER. `STAGE_00_09_GAP_MATRIX.md` is stale against the tracker and must not be relied on.

| Stage | Scope | State | CI evidence recorded | Main open items |
|---|---|---|---|---|
| 00 | Baseline and preservation map | COMPLETE (BASELINE_PRESERVATION_MAP, tracker generated) | n/a | no completion report file |
| 01 | Platform foundation, auth, ownership, audit | VERIFIED in CI | STAGE_01 report | web login BFF (G-42, Stage 09) |
| 02 | Database and domain models | VERIFIED in CI (run 42445765317; G-34 closed by 42518889031) | STAGE_02 report | none recorded |
| 03 | Telegram intelligence | **Engineering: ENGINEERING COMPLETE for the listed scope (carry-overs named); External Validation: DEFERRED to Stage 10/11** (`STAGE_03_ENGINEERING_BOUNDARY_AND_ACCEPTANCE.md`) | backend 67dee94 run 42528709453 (docs 842e21a run 42531280629); frontend 9abf640 run 42531055911 | M02-15, M01-14, G-37, G-38, G-39, G-40, real-data leakage proof |
| 04 | Research and market intelligence | **ENGINEERING COMPLETE** (backend `a9431af`, CI run 42904103501 green); carry-overs: M05-13 design confirmation, Stage 08 regime-read test; external validation deferred to Stage 10/11 | run 42904103501 | G-45 (Stage 09), G-15, G-16, G-20, G-23, G-25 (Stage 10/11) |
| 05 | Independent opportunity engine | **ENGINEERING IMPLEMENTED: CI PENDING** (17 of 18 rows verified in CI; M16-06 calendar gate, M16-08 reward:risk screen, the read API and reproducibility provenance built 2026-11-10, local) (`STAGE_05_TEST_AND_ACCEPTANCE_REPORT.md`) | run 42459457501 (cc7590c), later 42904103501 | live data and regime (G-16, G-20), calendar feed, backtesting (G-21): Stage 10/11 |
| 06 | Capital, confidence, risk, simulator | IMPLEMENTED + TESTED (76 of 85; 4 NOT_STARTED, 5 IN_PROGRESS) | run 42462060290 (8d60401) | no portfolio state (G-22), no instrument/fee spec (G-23), uncalibrated confidence (G-24), no margin model (G-25) |
| 07 | Decisions, approval, execution, trade management | IMPLEMENTED + TESTED, PAPER only (65 of 79; 12 NOT_STARTED = Assisted Live / Controlled Auto) | run 42466542084 (51430f3); G-26 approval API run 42516023424 | live modes (G-08), live price feed (G-29), approval settings table (G-36) |
| 08 | Outcome learning and analytics | IMPLEMENTED + TESTED (13 of 21), FIXTURE-backed | run 42473777077 (61ab9d8) | no real-price outcomes (G-30), no MAE/MFE (G-31), no OHLC provider (G-32) |
| 09 | Complete frontend | IMPLEMENTED + TESTED, tracked separately; DEMO fixtures; LIVE reads need a session | frontend run 42531055911 (70 unit, 37 Playwright) | login/session BFF (G-42), manual screen-reader review, remaining screens' non-demo states |
| 10 | External integrations (real Telegram, market data, news/macro, hosted AI, broker, notifications) | NOT STARTED | n/a | every provider-dependent gap above |
| 11 | Full-system testing and validation (integration, security, financial correctness, resilience, performance, paper-trading validation) | NOT STARTED | n/a | real-data validation of M02-15, M01-14, G-30, G-39 |
| 12 | Controlled release | NOT STARTED | n/a | real-money trading stays disabled until every legal, security, operational and technical approval passes |

Stages 04 to 08 have no completion reports and no VERIFIED requirements: green CI proves the code runs, not that the acceptance criteria are met on real data. This review was read-only; no Stage 04 work was started.
