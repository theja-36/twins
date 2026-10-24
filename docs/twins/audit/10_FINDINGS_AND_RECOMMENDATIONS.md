# 10 Findings and recommendations

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

Severity: Critical = blocks safe progression of dependent phases; High = materially limits the product or risks irreplaceable data; Medium; Low.

| ID | Finding | Severity | Status | Phase |
|---|---|---|---|---|
| F-001 | Final architecture diagram was not supplied (RECEIVED 2026-10-24; reconciliation complete, residual ambiguities recorded) | High | CLOSED | P00 |
| F-002 | No deterministic risk, sizing, reservation, production-budget fail-closed or emergency-control layer exists | Critical | OPEN | P06 |
| F-003 | Decision-engine outcome `APPROVE` collides with the human approval concept; the target eligibility states (WAIT / REJECT / EXPIRED / RESEARCH_ONLY / QUALIFIED) do not exist | Critical | OPEN | P07 |
| F-004 | No outcome engine, labels, or conventions: the learning chain has no ground truth | High | OPEN | P05 |
| F-005 | Market data is a single unofficial daily-bar source; instrument model lacks option attributes and point-in-time resolution | High | OPEN | P04 |
| F-006 | Telegram intake lacks message classification/linking (replies, follow-ups), source health and gap detection, and full-history backfill; parser accuracy never measured | High | OPEN | P02 |
| F-007 | Independent review of security-critical code (F1) remains open | High | OPEN | P00 |
| F-008 | Backups are local-only with no failure alert; monitoring is partial | High | OPEN | P01 |
| F-009 | Deployed api/worker images are not tied to a commit; HEAD is ahead of what runs | Medium | OPEN | P01 |
| F-010 | Signal identity, deduplication and the research-only rule exist only as an unapproved design | Medium | OPEN | P03 |
| F-011 | Approval path covers claim review only; no proposal object, versioning, pre-flight or cancellation | High | OPEN | P09 |
| F-012 | Regulatory, terms-of-use and permission questions have no evidenced review | High | OPEN | P00 |
| F-013 | Planning pack, prior audits and this documentation are not under version control as one set | Low | OPEN | P00 |
| F-015 | Intake is acknowledged after a Redis enqueue, before PostgreSQL persistence; no transactional outbox | High | OPEN | P01 |
| F-014 | Option pipeline and equity-signal pipeline are decoupled; the decision stack is dormant for options intake | Medium | OPEN | P07 |
| F-016 | No case identity, claim versions, deadlines or per-case orchestration (architecture Step 4.0) | High | OPEN | P03 |
| F-017 | No TWINS_PLAN, management-policy, mandate or stop-monotonicity contracts | High | OPEN | P07 |
| F-018 | Research components (Agents 3-9) and per-decision evidence snapshots are largely absent | High | OPEN | P07 |
| F-019 | Authority separation and the no-override rule are enforced only for the approval bot | Medium | OPEN | P00 |
| F-020 | Historical discrepancy: the recorded F1 policy calls for independent review before real data, yet real channel data is captured and stored in staging with F1 open | High | OPEN | P00 |

## F-001 - Final architecture diagram was not supplied (RECEIVED 2026-10-24; reconciliation complete, residual ambiguities recorded)

- **Severity / status:** High / CLOSED
- **Requirements:** GV-01
- **Evidence:** The request ends with the unfilled placeholder `[Paste the complete architecture diagram here.]`. The baseline was therefore reconstructed from the workflow in the request (11 areas) plus the architecture text of the Planning Pack (an untracked local source, not available in the repository, dated 2026-10-19). UPDATE 2026-10-24: the complete architecture was received and saved as the canonical baseline (docs/twins/PRODUCT_BASELINE.md). Reconciliation added 49 requirements, changed 11, and recorded residual ambiguities as Q-019..Q-028 and decisions D-020..D-031 (by 2026-10-24 the owner answered Q-019..Q-024, Q-026 and Q-028, partly answered Q-025 and explicitly deferred its remainder and Q-027). Closure of this finding does NOT pass phase P00 or any release gate.
- **Impact:** Was: reconciliation against the real architecture was impossible. Now: resolved; no residual architecture question lacks an answer or an explicit deferral; deferred items (Q-027 / D-034, D-030a, D-006) keep their affected work blocked.
- **Dependencies:** Owner input
- **Recommended action:** None further for the diagram itself; the owner resolves or explicitly defers the A-00.2 prerequisites (tracked as P00 task T00.2).
- **Acceptance test:** PRODUCT_BASELINE.md carries the architecture verbatim; every element maps to requirement IDs (a presence check run by the assistant with tooling that is not in this repository (historical assistant-produced evidence; the repository cannot reproduce it)); residual ambiguities are recorded as Q/D ids.
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)

## F-002 - No deterministic risk, sizing, reservation, production-budget fail-closed or emergency-control layer exists

- **Severity / status:** Critical / OPEN
- **Requirements:** SZ-01, SZ-02, SZ-03, SZ-04, SZ-05, SZ-06, SZ-07, SZ-08, SZ-09, EX-08, SZ-10, SZ-11, EX-12
- **Evidence:** packages/risk, packages/market and packages/analytics are placeholder directories (only `.gitkeep`); risk_decisions/accounts/positions/portfolio_snapshots/orders/fills tables are never read or written by runtime code; adapters/broker is a contracts stub.
- **Impact:** Nothing can safely size, reserve capital, or stop activity. Every downstream execution-adjacent phase depends on it.
- **Dependencies:** Owner risk budgets (D-007)
- **Recommended action:** Build packages/risk as a pure deterministic library first (P06), with no AI or broker imports.
- **Acceptance test:** SZ-01..SZ-09 and EX-08 acceptance tests pass; static no-AI-import test passes
- **Phase:** [P06](../phases/06-risk-policy-and-sizing-core/PLAN.md)

## F-003 - Decision-engine outcome `APPROVE` collides with the human approval concept; the target eligibility states (WAIT / REJECT / EXPIRED / RESEARCH_ONLY / QUALIFIED) do not exist

- **Severity / status:** Critical / OPEN
- **Requirements:** RE-08, PB-03, CH-01
- **Evidence:** packages/decision-intelligence/src/types.ts:11 `SignalValidationOutcome = APPROVE | REJECT | INSUFFICIENT_EVIDENCE`; first recorded as C4 on 2026-10-22 and still open. Architecture Step 4.8 requires WAIT with blocker/recheck/deadline, REJECT, EXPIRED, RESEARCH_ONLY and QUALIFIED, and states that research eligibility must never mean human approval.
- **Impact:** A future component could read engine APPROVE as authorization; the target state machine (WAIT/REJECT/QUALIFIED) cannot be expressed.
- **Dependencies:** Naming decision D-008
- **Recommended action:** Introduce the target states and rename with a compatibility migration and tests (P07).
- **Acceptance test:** RE-08 state-machine test; grep shows no engine output named APPROVE
- **Phase:** [P07](../phases/07-decision-states-and-research-engine/PLAN.md)

## F-004 - No outcome engine, labels, or conventions: the learning chain has no ground truth

- **Severity / status:** High / OPEN
- **Requirements:** CR-01, CR-02, CR-03, CR-04, CR-05, CR-06
- **Evidence:** No evaluator code; backtests/backtest_results unused; conventions undecided (CR-04); staging has 0 signals, 0 validations, 0 market observations.
- **Impact:** Strategy validation, calibration, scorecards and any claim about channel quality are impossible until this exists.
- **Dependencies:** P04 data, D-005 conventions
- **Recommended action:** Owner approves conventions first, then build the evaluator (P05).
- **Acceptance test:** CR-01..CR-06 acceptance
- **Phase:** [P05](../phases/05-outcome-conventions-and-case-reconstruction/PLAN.md)

## F-005 - Market data is a single unofficial daily-bar source; instrument model lacks option attributes and point-in-time resolution

- **Severity / status:** High / OPEN
- **Requirements:** MD-01, MD-02, MD-03, MD-04, MD-05, MD-06, XC-06, EV-02, EV-03
- **Evidence:** adapters/market/src/yahoo.ts; instruments.ts:21-27 (no expiry/strike/right); options attributes only in claim JSON; no vendor or entitlement evidence; 0 market_observations on staging.
- **Impact:** Option outcomes, premiums, spreads and expired-contract analysis cannot be produced; the unofficial endpoint's terms are unevidenced.
- **Dependencies:** Vendor decision D-004, owner key custody
- **Recommended action:** Model instruments properly, choose vendor with recorded probes, build coverage matrix (P04).
- **Acceptance test:** MD-01..MD-06 acceptance
- **Phase:** [P04](../phases/04-instruments-and-market-data/PLAN.md)

## F-006 - Telegram intake lacks message classification/linking (replies, follow-ups), source health and gap detection, and full-history backfill; parser accuracy never measured

- **Severity / status:** High / OPEN
- **Requirements:** TG-02, TG-06, TG-08, TG-09, TG-10, CL-01, CL-03, SRC-01, TG-14, TG-15
- **Evidence:** mapping.py has no reply handling; no cancel/amend classification; history.py bounds 50 messages / 7 days; 44 claims, all INSUFFICIENT_EVIDENCE, no labelled sample.
- **Impact:** Follow-up messages that change or cancel a signal are invisible; coverage and parser quality are unknown.
- **Dependencies:** Owner labelling effort; channel-owner permission
- **Recommended action:** P02 subphases (replies, follow-ups, backfill, accuracy baseline).
- **Acceptance test:** TG-02, TG-06, TG-08, TG-10 acceptance
- **Phase:** [P02](../phases/02-telegram-intake-completeness/PLAN.md)

## F-007 - Independent review of security-critical code (F1) remains open

- **Severity / status:** High / OPEN
- **Requirements:** XC-09
- **Evidence:** docs/implementation/R0B_CLOSURE_REVIEW.md: F1 OPEN; no reviewer assigned. UPDATE 2026-10-24: the review package was refreshed (documentation only) against target commit 702d4a82ba37e3e533f5acdd652b290bb025e7b1 with base b2ad592be7bdd3747cfed92b3eaa0557491c853c; the earlier statements are preserved as history. The required reviewer profile is recorded (D-036). The reviewer is UNASSIGNED; no review has occurred and F1 is not passed. Proposed scope additions (internal ingest endpoint, intake policy) await owner confirmation.
- **Impact:** Auth, webhook and DB-client code rely on self-review only; blocks any wider exposure and any live phase.
- **Dependencies:** Owner names a reviewer
- **Recommended action:** Owner assigns a reviewer matching the D-036 profile and confirms the scope additions; the reviewer delivers the deliverable listed in the package.
- **Acceptance test:** XC-09 acceptance
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)

## F-008 - Backups are local-only with no failure alert; monitoring is partial

- **Severity / status:** High / OPEN
- **Requirements:** XC-03, XC-04, XC-02
- **Evidence:** no off-host copy was configured (historical observation 2026-10-24T21:15Z); worker has no health check; capture-watch.sh is on-demand; no TWINS-wide alerting; real captured data (45 messages) now exists.
- **Impact:** Loss of the host loses the only copy of irreplaceable captured history; failures are silent.
- **Dependencies:** Owner chooses off-host target and key escrow
- **Recommended action:** P01 monitoring/backup subphases.
- **Acceptance test:** XC-03, XC-04 acceptance
- **Phase:** [P01](../phases/01-operations-foundation/PLAN.md)

## F-009 - Deployed api/worker images are not tied to a commit; HEAD is ahead of what runs

- **Severity / status:** Medium / OPEN
- **Requirements:** XC-08
- **Evidence:** Runtime: api/worker run twins-staging:capture-8cb22f9 (observed 2026-10-24T21:15Z); repository HEAD is 702d4a8 with later commits; images are built by hand (host build-*.sh). Behavioural drift between running images and HEAD was not measured (UNVERIFIED).
- **Impact:** Tests at HEAD do not prove the running system; rollback targets are ambiguous.
- **Dependencies:** Owner deploy approval
- **Recommended action:** Image provenance labels + reproducible build + redeploy plan (P01).
- **Acceptance test:** XC-08 acceptance
- **Phase:** [P01](../phases/01-operations-foundation/PLAN.md)

## F-010 - Signal identity, deduplication and the research-only rule exist only as an unapproved design

- **Severity / status:** Medium / OPEN
- **Requirements:** LC-01, TG-03, CS-01, CS-02, PL-01, XC-10
- **Evidence:** docs/implementation/phase1/T6_SIGNAL_LIBRARY_DESIGN.md (proposal; six owner decisions pending); no schema.
- **Impact:** Cross-message duplicates inflate counts; historical imports have no structural barrier from actionable use.
- **Dependencies:** T6 owner decisions D-006
- **Recommended action:** Implement T6 S1/S2 after approval (P03).
- **Acceptance test:** LC-01 acceptance; historical rows can never be referenced by a proposal (trigger test)
- **Phase:** [P03](../phases/03-signal-library-and-identity/PLAN.md)

## F-011 - Approval path covers claim review only; no proposal object, versioning, pre-flight or cancellation

- **Severity / status:** High / OPEN
- **Requirements:** AP-02, AP-03, AP-04, AP-05, AP-06
- **Evidence:** services/approval-bot cards show parsed fields; no lots/risk/management/version; claim-decision SQL exercised on real PostgreSQL only for the TEST card (handshake 2026-10-24).
- **Impact:** Approval cannot yet bind to an executable proposal; first real claim decision will be the first end-to-end use of decide() for claims.
- **Dependencies:** P06, P07 outputs
- **Recommended action:** Extend with proposal versions and pre-flight (P09).
- **Acceptance test:** AP-02..AP-06 acceptance
- **Phase:** [P09](../phases/09-candidates-proposals-and-approval/PLAN.md)

## F-012 - Regulatory, terms-of-use and permission questions have no evidenced review

- **Severity / status:** High / OPEN
- **Requirements:** XC-07
- **Evidence:** No register in the repository; the 2026-10-22 roadmap lists them as owner questions (H.7). UPDATE 2026-10-24: the product owner is recorded as the coordination role only (D-043); qualified reviewers are UNASSIGNED; unresolved permission, licensing or compliance questions block the affected activation, use, export or sharing.
- **Impact:** Compliance cannot be claimed; broker/vendor/channel terms may constrain design.
- **Dependencies:** Owner and qualified reviewer
- **Recommended action:** Create the register and assign owners (P00); gate P12 on it.
- **Acceptance test:** XC-07 acceptance
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)

## F-013 - Planning pack, prior audits and this documentation are not under version control as one set

- **Severity / status:** Low / OPEN
- **Requirements:** XC-07
- **Evidence:** git status showed `?? TWINS_Planning_Pack/` (an untracked local directory, not available in the repository) and `?? .vscode/` untracked (observed 2026-10-24T21:14Z, before the local documentation commit); docs/implementation holds many dated audits.
- **Impact:** Single copy of the pack; reader cannot tell which document is current.
- **Dependencies:** Owner decision D-002
- **Recommended action:** Decide tracking policy; docs/twins/STATUS.md becomes the index (P00).
- **Acceptance test:** Policy recorded in DECISION_LOG.md
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)

## F-015 - Intake is acknowledged after a Redis enqueue, before PostgreSQL persistence; no transactional outbox

- **Severity / status:** High / OPEN
- **Requirements:** TG-12, XC-02
- **Evidence:** apps/api/src/internalIngest.ts: validate -> caps -> enqueue -> HTTP 200; the worker inserts into PostgreSQL afterwards. No outbox (grep). Baseline expectation, quoted from the Planning Pack architecture text (an untracked local source, not available in the repository): `Persist intake plus outbox atomically before acknowledging`. The durability design in phases/01-operations-foundation/PLAN.md is self-contained and does not require that source. Staging currently shows all 45 captured messages persisted (observed 2026-10-24T21:15Z), so no loss was observed, but the guarantee is not structural. STATUS NOTE 2026-10-24: selecting the transactional-outbox design direction (D-014a) does not close this runtime finding; it stays OPEN until implementation and acceptance evidence (the failure matrix in P01) exist.
- **Impact:** A Redis volume loss or flush between acknowledgement and processing silently loses an irreplaceable captured message; the capture client believes it was delivered.
- **Dependencies:** Design choice D-014a (outbox vs synchronous insert)
- **Recommended action:** Persist raw event (and an outbox row) in the ingest transaction, then enqueue from the outbox dispatcher (P01 subphase 1E).
- **Acceptance test:** TG-12 acceptance (Redis wipe after ack loses nothing)
- **Phase:** [P01](../phases/01-operations-foundation/PLAN.md)

## F-014 - Option pipeline and equity-signal pipeline are decoupled; the decision stack is dormant for options intake

- **Severity / status:** Medium / OPEN
- **Requirements:** RE-01, RE-08, OL-01, CS-04
- **Evidence:** Staging: options_claims 45 but signals 0 and signal_validations 0; decision-intelligence consumes `signals` created by parseTelegramSignal (extract.ts:94), not options claims.
- **Impact:** The evidence/decision machinery has no real inputs; its quality on real data is unmeasured.
- **Dependencies:** P02, P03
- **Recommended action:** Define how library records feed the research engine (P03/P07).
- **Acceptance test:** A library record can be evaluated end-to-end into a decision row
- **Phase:** [P07](../phases/07-decision-states-and-research-engine/PLAN.md)

## F-016 - No case identity, claim versions, deadlines or per-case orchestration (architecture Step 4.0)

- **Severity / status:** High / OPEN
- **Requirements:** CS-01, CS-02, CS-03, CS-04, XC-10
- **Evidence:** No case table; options_claims is keyed by (message, parser_version); no research/entry/holding deadline fields; the worker pipeline is fixed and linear (services/worker/src/index.ts).
- **Impact:** Revisions, parent links to generated alternatives and bounded parallel research cannot be represented; WAIT/EXPIRED have nothing to expire.
- **Dependencies:** T6 owner decisions (D-006), deadline policy (D-022)
- **Recommended action:** Introduce case/claim-version identity with the signal library (P03) and orchestration/deadlines in the research engine (P07).
- **Acceptance test:** CS-01..CS-04 and XC-10 acceptance
- **Phase:** [P03](../phases/03-signal-library-and-identity/PLAN.md)

## F-017 - No TWINS_PLAN, management-policy, mandate or stop-monotonicity contracts

- **Severity / status:** High / OPEN
- **Requirements:** PL-02, PL-03, EX-09, EX-10, EX-06
- **Evidence:** Only source claim fields exist (stop, targets); no separate plan object, no checkpoint-vs-exit distinction, no mandate concept; execution tables unused.
- **Impact:** Human approval cannot bind to a mandate and execution cannot be bounded by one; adaptive management cannot be specified or tested.
- **Dependencies:** Management policy decision D-011, mandate definition Q-020
- **Recommended action:** Define the TWINS_PLAN and mandate contracts in P07/P09 before any execution work; enforce in P10.
- **Acceptance test:** PL-02, PL-03, EX-09, EX-10, EX-06 acceptance
- **Phase:** [P07](../phases/07-decision-states-and-research-engine/PLAN.md)

## F-018 - Research components (Agents 3-9) and per-decision evidence snapshots are largely absent

- **Severity / status:** High / OPEN
- **Requirements:** EV-01, RA-01, RA-02, RA-03, RA-04, RA-05, RA-07, SY-01, SY-03, SY-04, PL-01, PB-02, GV-02
- **Evidence:** Macro adapter/news adapter are thin, no regime, technical, constituent or stress components; no snapshot object (signal_evidence links only); 0 rows of market/news/macro on staging.
- **Impact:** Step 4 can only abstain (INSUFFICIENT_EVIDENCE); decisions are not reproducible from a versioned snapshot.
- **Dependencies:** P04 data, Q-019 (component nature)
- **Recommended action:** Build the research components and snapshot in P07 on top of P04 data; keep model-based parts separable.
- **Acceptance test:** EV-01, RA-01..RA-07, SY-01..SY-04 acceptance
- **Phase:** [P07](../phases/07-decision-states-and-research-engine/PLAN.md)

## F-019 - Authority separation and the no-override rule are enforced only for the approval bot

- **Severity / status:** Medium / OPEN
- **Requirements:** GV-01, SZ-10
- **Evidence:** Restricted role and static tests exist for services/approval-bot; no risk veto, no majority-vote rule, no import-boundary tests for future components.
- **Impact:** Without enforcement from the first line of each new component, the seven-authority separation could erode silently.
- **Dependencies:** None
- **Recommended action:** Make an authority-boundary test a mandatory acceptance item of every phase that adds a component (P03, P06, P09, P10, P11).
- **Acceptance test:** GV-01, SZ-10 acceptance
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)

## F-020 - Historical discrepancy: the recorded F1 policy calls for independent review before real data, yet real channel data is captured and stored in staging with F1 open

- **Severity / status:** High / OPEN
- **Requirements:** XC-09, GV-01
- **Evidence:** Recorded policy: docs/implementation/ROADMAP_AND_AUDIT_2026-10-22.md finding C2 - F1 code "Must be reviewed by someone other than the implementing agent before any public exposure or real data". Recorded fact: staging holds 45 captured messages from the real channel (32 history-pilot, 12 live; observed 2026-10-24T21:15Z) while F1 remains OPEN (docs/implementation/R0B_CLOSURE_REVIEW.md sections J/K; docs/implementation/phase0/0D_INTAKE_GUARD_DEPLOYMENT_PLAN.md line 35: the image is 'not independently reviewed code: F1 stays open'). No waiver, retrospective approval or reviewer is recorded anywhere, and this documentation does not create one. INTERIM BOUNDARY 2026-10-24: no retrospective waiver is granted. This documentation does not authorize new real-data ingestion or processing, new public exposure, staging deployment, broker integration or live trading, nor starting or stopping any service. Local implementation requires a later, separately scoped authorization; P01 and P06 have not begun.
- **Impact:** The recorded policy and the recorded facts disagree; later phases cannot tell whether F1 gates local work, staging deployment or only release. Treating the discrepancy as resolved without a decision would be an invented approval.
- **Dependencies:** Owner decision D-031; reviewer (Q-012)
- **Recommended action:** Record the discrepancy (done here). Owner decides how F1 applies per environment (D-031) and names a reviewer; no fresh real-data activity or deployment is authorized by this documentation.
- **Acceptance test:** D-031 recorded as DECIDED by the owner; A-00.3 satisfied by an owner-named reviewer
- **Phase:** [P00](../phases/00-baseline-and-governance/PLAN.md)
