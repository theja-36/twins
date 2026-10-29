# TWINS status

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## 1. Product-baseline state
- Architecture: **RECEIVED 2026-10-24**, saved verbatim as [PRODUCT_BASELINE.md](PRODUCT_BASELINE.md), reconciled with the requirement matrix. Finding F-001 / question Q-001 closed on that basis; owner decisions D-026..D-044 were recorded 2026-10-24 (hybrid architecture, first mandate type, source changes, RESEARCH_ONLY, outbox initial rules, material changes, TWINS levels, generated-candidate deferral, open-position contract). Q-019..Q-024, Q-026 and Q-028 are answered, Q-025 is partly answered with explicit deferrals, and Q-027 is explicitly deferred; no residual architecture question lacks an answer or a deferral. Deferrals keep the affected work blocked.
- Requirements (130; updated 2026-10-29: Stage 1 Task 2 added XC-11 and moved EX-08 to PARTIAL, Task 3 added XC-12, Task 4 added XC-13): VERIFIED_IMPLEMENTED 10, PARTIAL 47, MISSING 69, UNVERIFIED 3, BLOCKED 1, NOT_APPLICABLE 0. (v1 had 78; 49 added, 11 changed.)
- Highest-severity open findings: F-002 (no risk/sizing/emergency layer, no production-budget fail-closed), F-003 (`APPROVE` naming collision; target eligibility states absent). Full list: [audit/10_FINDINGS_AND_RECOMMENDATIONS.md](audit/10_FINDINGS_AND_RECOMMENDATIONS.md).
- F1 (independent review of security-critical code): **unresolved**; no reviewer is assumed, no waiver or retrospective approval is recorded, and the assistant does not self-certify independence. The historical discrepancy between the recorded F1 policy and real data held in staging is finding F-020 (decision D-031 OPEN).

## 1a. Implementation checkpoint (2026-10-29)
**Stage 1 (Safety Core) is complete, approved and committed** on branch `feat/stage1-safety-core` as seven reviewable commits (shared live-trading guard; database-backed runtime state and kill switch; immutable audit trail and hash-chain verifier; mandatory stop-loss invariant; Stage 1 safety tests; docs; hosted CI), each production commit type-checked on its own. Design and evidence: [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [MANDATORY_STOP_LOSS.md](MANDATORY_STOP_LOSS.md), [CI.md](CI.md), [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md). The branch is not merged to `main` and nothing is deployed. The table below keeps the earlier phase numbering; Stage 1 delivered parts of P01 and P06 and is not a phase advance.

## 1b. Stage 2 progress (2026-10-29)
Stage 2 / Task 1 (commit checkpoint + hosted CI) is complete and **merged to `main`** (PR #19, hosted CI green on `main`). Stage 2 / Task 2 (durable Telegram intake outbox) is implemented on branch `feat/stage2-durable-outbox`: an acknowledged message is now a committed PostgreSQL row before any Redis work, with claim/retry/dead-letter/reconcile and runtime-safety gating. Design: [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md). Not merged to `main` and not deployed to staging.

## 1c. Staging (2026-10-29)
Stage 2 / Task 4: **staging runs commit `a0120d75`** (Stage 1 safety core, hosted CI, durable outbox, off-host backup code) with migrations 0000-0012, the `twins_app` runtime role, api/worker/approval-bot (inactive) on image `sha256:ef8b49d6…`; LIVE_TRADING=false, TRADING_ENABLED=false, TWINS_BOT_ACTIVE=false. Verification and rollback: [STAGING_DEPLOYMENT_VERIFICATION.md](STAGING_DEPLOYMENT_VERIFICATION.md).

## 1d. Alerting and scheduled verification (2026-10-29)
Stage 2 / Task 5 and the Telegram alert destination are **merged to `main`** (PR #23, #24) and deployed to staging (image `tgalert-0d333eb7`; migrations 0000-0013); **Stage 2 is complete**. Installed timers: daily backup (existing), hourly audit verification, weekly local backup verification; alert relay running with **no destination configured yet**. See [OPERATIONAL_ALERTING.md](OPERATIONAL_ALERTING.md).

## 1e. Stage 3 (2026-10-29)
Stage 3 / Task 1 (risk decision schema and immutable risk records) is implemented on branch `feat/stage3-risk-decisions` (migration 0014, `packages/risk`); not merged and **not deployed to staging**. See [RISK_DECISIONS.md](RISK_DECISIONS.md).

Stage 3 / Task 2 (position sizing engine) is implemented on branch `feat/stage3-position-sizing` (migration 0015, `packages/risk/src/sizing`); see [POSITION_SIZING.md](POSITION_SIZING.md). Tasks 1-3 are merged to main (PRs #26-#28); none is deployed to staging.
Stage 3 / Task 4 (risk-decision expiry and loss circuit breakers) is implemented on branch `feat/stage3-expiry-circuit-breakers` (migration 0017); see [CIRCUIT_BREAKERS.md](CIRCUIT_BREAKERS.md).
Stage 3 / Task 3 (portfolio open-risk and correlation limits) is implemented on branch `feat/stage3-portfolio-limits` (migration 0016, `packages/risk/src/portfolio`); see [PORTFOLIO_RISK_LIMITS.md](PORTFOLIO_RISK_LIMITS.md).

## 2. Phase implementation state (only the user advances phases)
| Phase | Title | State | Depends on | Primary requirements |
|---|---|---|---|---|
| [P00](phases/00-baseline-and-governance/PLAN.md) | Baseline, governance and open decisions | IN_PROGRESS | - | 3 |
| [P01](phases/01-operations-foundation/PLAN.md) | Operations foundation: provenance, monitoring, backups, CI | NOT_STARTED | P00 | 6 |
| [P02](phases/02-telegram-intake-completeness/PLAN.md) | Telegram intake completeness, classification and source health | NOT_STARTED | P00 | 15 |
| [P03](phases/03-signal-library-and-identity/PLAN.md) | Signal library, case identity and claim versions (T6) | NOT_STARTED | P00 | 7 |
| [P04](phases/04-instruments-and-market-data/PLAN.md) | Instruments and market data | NOT_STARTED | P00 | 9 |
| [P05](phases/05-outcome-conventions-and-case-reconstruction/PLAN.md) | Outcome conventions and case reconstruction | NOT_STARTED | P03, P04 | 6 |
| [P06](phases/06-risk-policy-and-sizing-core/PLAN.md) | Risk engine scaffolding, production-budget gating and emergency controls | NOT_STARTED | P00 | 13 |
| [P07](phases/07-decision-states-and-research-engine/PLAN.md) | Eligibility states, case orchestration and research engine | NOT_STARTED | P03, P04, P06 | 28 |
| [P08](phases/08-strategy-research-and-validation/PLAN.md) | Strategy research and validation | NOT_STARTED | P05, P07 | 11 |
| [P09](phases/09-candidates-proposals-and-approval/PLAN.md) | Candidates, proposals, approval binding and pre-flight | NOT_STARTED | P03, P06, P07 | 10 |
| [P10](phases/10-paper-execution-and-reconciliation/PLAN.md) | Paper execution, order lifecycle and reconciliation | NOT_STARTED | P06, P09 | 10 |
| [P11](phases/11-outcome-learning-and-governance/PLAN.md) | Outcome learning and governance | NOT_STARTED | P08, P10 | 8 |
| [P12](phases/12-broker-integration-and-controlled-live/PLAN.md) | Broker integration and controlled live | NOT_STARTED | P10, P01, P00 | 1 |

P00 is `IN_PROGRESS` only because the owner authorized documentation reconciliation on 2026-10-24; A-00.3 is BLOCKED (reviewer unassigned) and the exit authorization is missing; A-00.1, A-00.2, A-00.4 and A-00.5 meet their exact wording only (mechanical, assistant-produced results). No other phase is authorized.

## 3. Release readiness (gates; independent of phase states)
| Gate | Level | State | What is missing |
|---|---|---|---|
| G0 | Baseline accepted | NOT_PASSED | Architecture RECEIVED and reconciled (documentation). NOT PASSED: A-00.3 is BLOCKED (F1 reviewer UNASSIGNED; package refreshed but undelivered) and the owner has not authorized exit. A-00.1, A-00.2, A-00.4 and A-00.5 meet their exact wording only (assistant-produced; not independent verification; deferrals keep their work blocked). D-031 unresolved. See phases/00-baseline-and-governance/PLAN.md section 7. |
| G1 | Operationally safe | NOT_PASSED | P01 not started: image provenance, alert drills, off-host restore, durable intake, hosted CI. |
| G2 | Data complete enough to research | NOT_PASSED | P02, P03, P04 not started. |
| G3 | Ground truth available | NOT_PASSED | P05 not started; conventions (D-005) undecided. |
| G4 | Risk core verified | NOT_PASSED | P06 not started; production budgets (D-007) not supplied - production would fail closed. |
| G5 | Decision & strategy ready | NOT_PASSED | P07, P08 not started. |
| G6 | Approval path (no orders) | NOT_PASSED | P09 not started. |
| G7 | Paper trading | NOT_PASSED | P10, P11 not started. |
| G8 | Broker read-only | NOT_PASSED | P12 not started; F1 independent review unresolved; broker not chosen. |
| G9 | Controlled live | NOT_PASSED | Not applicable until G8; `LIVE_TRADING` stays false. |

## 4. Historical runtime evidence (dated; NOT current status)
Dated observations only (repository 2026-10-24T21:14:25Z; staging, read-only, 2026-10-24T21:15:29Z). They are not a statement of current runtime status and may have changed. Only aggregate counts and image tags are recorded; run states, health, schedules and host details are deliberately not recorded. Safety posture is stated as decisions (D-001 `LIVE_TRADING` stays false; D-018 bot activation is a separate owner action; capture start/stop is an owner action), not as runtime status.
- Repository at observation (before this documentation was committed locally): branch `main`, HEAD `702d4a8`; one tracked documentation file modified (`docs/implementation/review/F1_REVIEW_PACKAGE.md`, refresh section); no code or configuration changed; untracked: `.vscode/`, `TWINS_Planning_Pack/` (untracked local source, not available in the repository), `docs/twins/`.
- Documentation preservation: at preparation time `docs/twins/` had **no verified durable copy**. A local Git commit (if made) is a local-only copy; it is not an off-host backup. No push, upload or external backup is authorized; any such action needs separate approval.
- Image tags as observed: api and worker `capture-8cb22f9` (commit mapping unverified, finding F-009); approval bot `bot-aba762bb`; capture `capture-2762179-1ad16990`.
- Aggregate counts as observed (9 migrations recorded): 45 captured messages (32 history-pilot, 12 live, 1 webhook), 45 options claims (44 claim, all `INSUFFICIENT_EVIDENCE`; 1 unsupported), 0 signals, 0 validations, 0 market observations, 0 orders/positions; 1 bot TEST card decided (no claim reviewed).
