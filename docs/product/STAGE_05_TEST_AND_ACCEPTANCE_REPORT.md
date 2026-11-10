# Stage 05 test and acceptance report (2026-11-10)

**Status: ENGINEERING COMPLETE (2026-11-10).** Backend `69e87d0`, CI run https://github.com/theja-36/twins/actions/runs/42908338203: all 7 jobs green (static; unit Node 20 and 22; integration Node 20 and 22 on PostgreSQL 16 and Redis 7; crash recovery; ci-gate). External-provider validation is deferred to Stage 10/11 and is not part of this status.

## CI results (run 42908338203, commit 69e87d0)
| Job | Result |
|---|---|
| static (lint, typecheck, build, secret scan) | success |
| unit, Node 20 and 22 | success: 254 of 254 files, 4,116 of 4,116 tests each |
| integration, Node 20 and 22 (PostgreSQL 16, Redis 7, migrations applied) | success: 83 files passed, 3 skipped, out of 86; 1,107 tests passed, 6 skipped, out of 1,113, each (the skips are the gated crash files, run in the crash job) |
| crash recovery (real SIGKILL, Node 22) | success: 2 files, 3 tests |
| ci-gate | success |
`stage05Reads.test.ts` executed and passed 7 of 7 on both Node versions (screen and provenance stored, calendar and screen no-ops recorded, five concurrent deliveries of one slot, deterministic paging, no claim on an independent candidate); `engine.test.ts` 12 of 12; `researchRuns.test.ts` 11 of 11. All criteria below are satisfied with this evidence.

## Local results before CI (this pass)
| Check | Result |
|---|---|
| TypeScript `tsc -b` | clean |
| ESLint on the changed files | 0 errors |
| Full backend unit suite (one local run) | **254 files passed (254), 4,116 tests passed (4,116)**, no failures, no skips reported, no worker timeout |
| Previous CI unit baseline (run 42904103501) | 252 files, 4,087 tests; this pass adds 2 files and 29 tests (`screens.test.ts` 20, `opportunityApi.test.ts` 9); the OpenAPI parity test now covers 17 routes |
| PostgreSQL 16 / Redis 7 integration and Node 20/22 | **NOT RUN**: no Docker daemon locally and no push is authorised. `tests/integration/opportunity/stage05Reads.test.ts` (screen and provenance stored, calendar and screen no-ops recorded, five concurrent deliveries of one slot give one scan, deterministic paging, independent candidate has no claim) is written and only parse-checked |
Last CI evidence for the existing engine: run 42904103501 (82 files / 1,100 tests passed on each Node version; 3 files / 6 tests skipped), including `engine.test.ts`.

## Acceptance criteria
| # | Criterion | Verdict |
|---|---|---|
| 1 | Independent discovery without Telegram input | MET: `engine.test.ts` (CI), `screens.test.ts` (no Telegram/claim in a draft), new integration check that `claim_id` is null (CI pending) |
| 2 | Instrument eligibility and validation | MET: universe, optional instrument-reference verifier (unverifiable means ineligible), symbol mismatch, malformed series (`scan.test.ts`) |
| 3 | Configurable screening | MET: strict config (rank, reward:risk, structure lookback, event block), fails closed |
| 4 | Technical structure and price-action detection | MET (existing, verified) |
| 5 | Volume, liquidity and options context | MET to the extent evidence exists: volume confirmation in setups; liquidity and options risk are reached in research (Stage 04 agents, A13 mapping); no provider is wired (G-20, G-25) |
| 6 | Regime-aware qualification | MET at fixture level (suppress on HIGH_VOLATILITY or RISK_OFF, rank factors); live regime is external (G-16) |
| 7 | Reward:risk and calendar screening (missing rows) | MET and VERIFIED in CI |
| 8 | Ranking with explainable evidence | MET (factors, missing evidence scored zero, `confidence: null`) |
| 9 | Duplicate detection and idempotent creation | MET (dedupe key, supersession; concurrent slot delivery test added, CI pending) |
| 10 | Lifecycle, expiry, supersession, invalidation | MET (database triggers; `engine.test.ts`) |
| 11 | Provenance, timestamps, versioning, reproducibility | MET and VERIFIED in CI |
| 12 | Bounded queues, retries, concurrency, worker recovery | MET: atomic claim, bounded retries, lease recovery; research crash recovery verified in CI (G-43) |
| 13 | Session-protected read APIs | MET and VERIFIED in CI: 3 routes, session plus `opportunities:read`, read-only, validated, OpenAPI |
| 14 | Auditability and user isolation | MET: candidates and scans are shared platform data (no owner) by design; routes need a session; candidate history is append-only |
| 15 | No order, approval or execution | MET: candidates are proposals; static boundary tests; the API is pinned read-only; no size or approval field exists |
| 16 | Missing, stale, contradictory data produce explicit statuses | MET: skip reasons (NO_DATA, STALE, FROM_FUTURE, MALFORMED, MARKET_CLOSED, EVENT_WINDOW, REWARD_RISK_BELOW_MIN, ...), CALENDAR_UNAVAILABLE, regime missing evidence |
| 17 | Regression of existing functionality | MET: full CI run green |

## Not claimed
No scan ran against real market, calendar or regime data; every candidate is FIXTURE-labelled by default and uncalibrated (`confidence: null`). The reward:risk screen defaults to 1.5 and can reduce the number of candidates on real data; it is configurable (0 switches it off).

## Declaration
Every criterion is satisfied with CI evidence; Stage 05 is ENGINEERING COMPLETE. Carry-overs (external, Stage 10/11): live regime source (G-16), live market data and prices (G-20), no backtesting or calibration of the setup rules (G-21), no holiday/event calendar feed wired for the new gate, no scan-level historical-pattern provider, instrument and fee specifications (G-23).
