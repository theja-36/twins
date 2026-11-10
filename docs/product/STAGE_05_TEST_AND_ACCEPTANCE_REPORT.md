# Stage 05 test and acceptance report (2026-11-10)

**Status: ENGINEERING IMPLEMENTED: CI PENDING.** ENGINEERING COMPLETE is declared only after a green CI run (Node 20 and 22, PostgreSQL 16, Redis 7, crash recovery) and every criterion below is satisfied. External-provider validation is deferred to Stage 10/11.

## Local results (this pass; not CI)
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
| 7 | Reward:risk and calendar screening (missing rows) | IMPLEMENTED; local unit evidence; CI pending |
| 8 | Ranking with explainable evidence | MET (factors, missing evidence scored zero, `confidence: null`) |
| 9 | Duplicate detection and idempotent creation | MET (dedupe key, supersession; concurrent slot delivery test added, CI pending) |
| 10 | Lifecycle, expiry, supersession, invalidation | MET (database triggers; `engine.test.ts`) |
| 11 | Provenance, timestamps, versioning, reproducibility | IMPLEMENTED: engine version, config hash and calendar status recorded; CI pending |
| 12 | Bounded queues, retries, concurrency, worker recovery | MET: atomic claim, bounded retries, lease recovery; research crash recovery verified in CI (G-43) |
| 13 | Session-protected read APIs | IMPLEMENTED: 3 routes, session plus `opportunities:read`, read-only, validated, OpenAPI; CI pending |
| 14 | Auditability and user isolation | MET: candidates and scans are shared platform data (no owner) by design; routes need a session; candidate history is append-only |
| 15 | No order, approval or execution | MET: candidates are proposals; static boundary tests; the API is pinned read-only; no size or approval field exists |
| 16 | Missing, stale, contradictory data produce explicit statuses | MET: skip reasons (NO_DATA, STALE, FROM_FUTURE, MALFORMED, MARKET_CLOSED, EVENT_WINDOW, REWARD_RISK_BELOW_MIN, ...), CALENDAR_UNAVAILABLE, regime missing evidence |
| 17 | Regression of existing functionality | MET locally: full unit suite; CI pending |

## Not claimed
No scan ran against real market, calendar or regime data; every candidate is FIXTURE-labelled by default and uncalibrated (`confidence: null`). The reward:risk screen defaults to 1.5 and can reduce the number of candidates on real data; it is configurable (0 switches it off).

## To declare ENGINEERING COMPLETE
You authorise the commit and push; CI is green as above; the roadmap and tracker are updated with the run id.
