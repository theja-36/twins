# Stage 05 architecture and implementation report: Independent Opportunity Engine (Module 16)

**Status (2026-11-10): ENGINEERING COMPLETE** (backend `69e87d0`, CI run https://github.com/theja-36/twins/actions/runs/42908338203, green on Node 20 and 22 with PostgreSQL 16 and Redis 7; see `STAGE_05_TEST_AND_ACCEPTANCE_REPORT.md`). The engine already existed and was verified in CI; this pass audited it against the specification and built the genuinely missing parts. External-provider validation is deferred to Stage 10/11.

## Existing functionality reused (audited, not rebuilt)
`packages/opportunity` (config, setups, rank, candidate, lifecycle, scan, dispatch, cycle); the shared `opportunity_candidates` / `opportunity_scans` / `opportunity_candidate_events` tables and the lifecycle guard triggers (migration 0036); the worker timer (`opportunity_queue`, off by default); the shared research dispatch (Stage 04: `runCandidateResearch`, the 12 specialist roles and the 13th Market Context agent, G-43 idempotent runs, G-44 run records); the instrument-reference eligibility hook; the regime provider port; the independent setup generator in `@twins/signals`. Both sources (TELEGRAM, INDEPENDENT) write the SAME candidate table, distinguishable by `source` and provenance, and enter the same research, risk and decision path. The engine imports no Telegram, broker, network, order or approval code (static tests).

## Audit result
17 of 18 requirements were already IMPLEMENTED AND VERIFIED in CI at rule/fixture level. Real gaps found by reading the code against the specification:
1. **M16-08 reward:risk against structure** was missing (targets are R multiples by construction, so nothing checked that price has room to reach them).
2. **M16-06 calendar and event awareness at scan level** was missing (the scan ran on a closed market and into imminent high-impact events; the calendar was only reachable during research).
3. **No read API for opportunity candidates**: the only candidate routes (`/intelligence/candidates`) serve the Telegram pipeline; independent candidates, their lifecycle, evidence and the scans had no session-protected route.
4. **Reproducibility**: a candidate did not record the engine version, the settings that decided it, or what the calendar said.
External: no live market-data, regime, calendar or historical-pattern provider exists (G-16, G-20, G-23): the engine runs on file/in-memory providers labelled FIXTURE.

## Built in this pass (local, uncommitted; CI pending)
- **Reward:risk screen** (`screen.ts`, `reward-risk-screen-v1`): finds the nearest OPPOSING swing level (swing high for a long, swing low for a short) between the entry and the reference target (the second target, else the first) and measures the reward that is actually open; a barrier closer than the minimum, or a reference target that is itself too small a multiple, screens the candidate out (`REWARD_RISK_BELOW_MIN`, with the reason, the level and its distance in R); no barrier means a clear path. Configurable: `TWINS_OPPORTUNITY_MIN_REWARD_RISK` (default 1.5; 0 switches it off), `..._STRUCTURE_LOOKBACK` (60 bars). The result is stored in the candidate's evidence.
- **Calendar gate** (`gateScan`, port `ScanCalendar`): a closed market or a high-impact event within `TWINS_OPPORTUNITY_EVENT_BLOCK_MINUTES` (30) makes the scan an explicit COMPLETED no-op that records `MARKET_CLOSED` / `EVENT_WINDOW` for every instrument (not a failure, not a silent empty success). No calendar, an unknown state or a failing source is `CALENDAR_UNAVAILABLE`: missing evidence recorded on the candidate, never "all clear" and never a block. A missing universe or provider still FAILS first.
- **Reproducibility**: every candidate's provenance records the scan engine version, `configSha256` (settings that decide candidates; batch sizes excluded) and the calendar status; the scan row records the same parameters.
- **Read API** (`apps/api/src/opportunityApi.ts`): `GET /opportunities/candidates` (source, state, limit, offset; both sources labelled), `GET /opportunities/candidates/:id` (candidate, lifecycle history, evidence, derived research status and package), `GET /opportunities/scans`. Session-protected, shared permission `opportunities:read`, read-only (pinned by a static test), validated and bounded, documented in `docs/api/openapi-session.json` (17 routes). A candidate is a proposal for research: no order, approval or size field exists.
- **Stores**: `listCandidates` gained a bounded `offset`; new `listScans` and `getCandidateEvidence` (read-only).
No migration; no existing table, trigger or constraint changed. No order, approval or execution path was added. Live trading stays off.

# Stage 05 requirement matrix (18 rows, audited 2026-11-10)

Classification words as in the Stage 04 report. IMPLEMENTED AND VERIFIED = code plus tests that passed in CI (run 42904103501 or earlier; synthetic/fixture evidence only); IMPLEMENTED AND VERIFIED (CI run 42908338203) = code and local tests, CI pending.

| ID | Requirement | Classification | Note and external dependency | Evidence |
|---|---|---|---|---|
| M16-01 | Independent market scanning | IMPLEMENTED AND VERIFIED | BLOCKED BY EXTERNAL DEPENDENCY for live data (G-20): provider is file/in-memory, labelled FIXTURE | packages/opportunity/src/scan.ts `runOpportunityScan`; tests/unit/opportunity/scan.test.ts; tests/integration/opportunity/engine.test.ts (CI 42904103501) |
| M16-02 | Pattern detection | IMPLEMENTED AND VERIFIED | rules are not backtested (G-21): pattern quality on real data is unmeasured | setups.ts `detectSetups`; scan.test.ts |
| M16-03 | Market-regime analysis | IMPLEMENTED AND VERIFIED | fixture-level (regime suppress/qualify/rank verified); live regime BLOCKED BY EXTERNAL DEPENDENCY (G-16) | scan.ts (REGIME_BLOCKED), rank.ts; scan.test.ts |
| M16-04 | Technical setup detection | IMPLEMENTED AND VERIFIED | - | setups.ts; scan.test.ts |
| M16-05 | Price-action confluence | IMPLEMENTED AND VERIFIED | - | setups.ts, rank.ts `withSetupAgreement`; scan.test.ts |
| M16-06 | Macro and calendar analysis | IMPLEMENTED AND VERIFIED (CI run 42908338203) | calendar gate port `gateScan` (MARKET_CLOSED, EVENT_WINDOW, CALENDAR_UNAVAILABLE) built this pass; no calendar source is wired in production (external: holiday/event feed, Stage 10); research still reaches the calendar agents | screen.ts; tests/unit/opportunity/screens.test.ts; tests/integration/opportunity/stage05Reads.test.ts (CI pending) |
| M16-07 | Historical pattern matching | IMPLEMENTED AND VERIFIED | reached through `historical-pattern-v1` during research; the scan itself has no historical provider; no provider wired (external, G-23/Stage 10) | Stage 04 research; research.test.ts |
| M16-08 | Risk-to-reward screening | IMPLEMENTED AND VERIFIED (CI run 42908338203) | reward:risk against structure built this pass (`screenRewardRisk`): nearest opposing swing level between entry and the reference target, minimum configurable (default 1.5, 0 = off); recorded in candidate evidence | screen.ts; screens.test.ts (20); stage05Reads.test.ts (CI pending) |
| M16-09 | Candidate generation | IMPLEMENTED AND VERIFIED | - | candidate.ts `toCandidateDraft`; scan.test.ts |
| M16-10 | Candidate ranking | IMPLEMENTED AND VERIFIED | explainable factors, never a probability (`confidence: null`, `calibrated: false`) | rank.ts; scan.test.ts |
| M16-11 | Opportunity evidence creation | IMPLEMENTED AND VERIFIED | evidence now also carries the reward:risk screen and provenance (engine version, config hash, calendar status) (CI pending for the additions) | candidate.ts; screens.test.ts |
| M16-12 | Candidate expiry | IMPLEMENTED AND VERIFIED | - | opportunityStore.expireDue; engine.test.ts |
| M16-13 | Revalidation | IMPLEMENTED AND VERIFIED | live price BLOCKED BY EXTERNAL DEPENDENCY (G-20): file snapshot only | lifecycle.ts `revalidate`; lifecycle.test.ts; engine.test.ts |
| M16-14 | Candidate lifecycle: NEW > IN_RESEARCH > READY_FOR_DECISION  | IMPLEMENTED AND VERIFIED | lifecycle enforced by database triggers; history now readable through the new read API (CI pending) | migration 0036; engine.test.ts; opportunityApi.test.ts |
| M16-15 | Research dispatch: source-agnostic atomic claim (SKIP LOCKED | IMPLEMENTED AND VERIFIED | bounded retries, atomic SKIP LOCKED claim, lease recovery; crash recovery verified for research (G-43) | dispatch.ts; engine.test.ts; researchRuns.test.ts; researchCrashRecovery.test.ts |
| M16-16 | Worker and scheduler: one idempotent opportunity_queue job p | IMPLEMENTED AND VERIFIED | - | services/worker; cycle.ts; engine.test.ts |
| M16-17 | Independence and safety boundary: the engine imports no Tele | IMPLEMENTED AND VERIFIED | static boundary tests (no Telegram, broker, network, order or approval imports); the new API is also pinned read-only | scan.test.ts / lifecycle.test.ts hygiene tests; opportunityApi.test.ts |
| M16-18 | Duplicate suppression: setup-identity dedupe key (unique), s | IMPLEMENTED AND VERIFIED | setup-identity dedupe key, supersession; concurrent slot delivery covered by a new integration test (CI pending) | candidate.ts `dedupeKeyOf`; engine.test.ts; stage05Reads.test.ts |

## Carry-overs and external dependencies (deferred to Stage 10/11)
G-16 live regime source; G-20 live market data and prices (revalidation uses a file snapshot); G-21 setup rules are not backtested or calibrated; a holiday/event calendar feed for the new gate (none wired); a historical pattern/outcome provider for the scan-level historical match (research-level agent exists); G-23 instrument and fee specifications. No candidate is calibrated: `confidence` is null by design.
