# P08 - Strategy research and validation

- **State:** NOT_STARTED
- **Depends on:** P05, P07
- **Primary requirements:** RA-06, SV-01, SV-02, SV-03, SV-04, SV-05, SV-06, SV-07, PB-01, RE-05, SY-02
- **Also checked here (cross-phase dependencies/acceptance):** GV-02, OL-06, OL-08, PB-03
- **Findings (primary owner):** -
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Establish a governed process in which strategy hypotheses are tested with leakage and selection-bias controls and only versions the owner approves become eligible.

Scope:
- Hypothesis registry with source evidence and limitations.
- Chronological holdout and prospective-validation design; overlapping-case grouping.
- Multiple-testing / selection-bias controls and null (shuffled-label) control.
- Regime coverage, sample sufficiency, uncertainty intervals, cost-sensitivity reporting.
- Versioned strategy states with explicit eligibility rules and no automatic promotion.
- Calibration of probability estimates where data allow.

## 2. Explicit non-goals
- No invented success thresholds (thresholds are owner decisions D-009).
- No profitability guarantee or claim.
- No live use.

## 3. Required inputs and entry gates
- P05 outcomes approved as ground truth.
- D-009: validation protocol and thresholds.

## 4. Existing reusable components and evidence
- `backtests tables (unused)` - assess reuse
- `P05 outcome tables` - ground truth

## 5. Subphases (independently testable)
- **8A** Registry and states
- **8B** Validation protocol and tooling
- **8C** Null-control and bias audit
- **8D** Calibration

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T08.1 | Registry + state machine (draft\|testing\|validated\|eligible\|retired) with approval records. | packages/analytics, packages/database/ | - |
| T08.2 | Walk-forward / holdout runner; overlap grouping; frozen prospective set. | packages/analytics | T08.1 |
| T08.3 | Shuffled-label control and multiple-testing report. | packages/analytics, tests/ | T08.2 |
| T08.4 | Report generator: n, intervals, regimes, cost sensitivity, insufficient-data state. | packages/analytics | T08.2 |
| T08.5 | Calibration module (reliability curves) or explicit `not calibratable` result. | packages/analytics | T08.4 |
| T08.6 | Versioned validation artifacts + lookup by (strategy version, regime, instrument class); `none` routes to RESEARCH_ONLY. | packages/analytics, packages/database/ | T08.2 |
| T08.7 | Source-plan vs TWINS-policy evaluation on the same cases and cost model; ambiguous paths counted separately. | packages/analytics | T08.2 |
| T08.8 | Probability event definition (event, deadline, policy) tied to artifacts; signal-DNA hypothesis component (secondary, cannot qualify a case). | packages/analytics | T08.5 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Strategy(version, state, hypothesis_id, created_by, approved_by, approved_at). Evaluation(strategy_version, dataset_hash, split, metrics, intervals, regimes, null_control_result). Transitions require a recorded user approval; research DB role cannot update state.

## 8. External dependencies and permissions
- None.

## 9. Tests
- **Unit:** Split chronology; overlap grouping; interval computation fixtures.
- **Integration:** Runner on rehearsal DB; privilege test for research role.
- **End-to-end:** Hypothesis -> evaluation -> state change request -> owner approval record.
- **Failure-path:** Insufficient sample yields `insufficient_data`, not a number.; Attempted state change without approval is refused.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-08.1 Shuffled-label control yields no eligible strategy across repeated seeds.
- A-08.2 Reports always state n, interval, regimes and cost sensitivity.
- A-08.3 State changes occur only with an approval record (privilege + test).
- A-08.4 Evaluations are reproducible from dataset hash.
- A-08.5 Artifact lookup returns an id or `none`; `none` can never reach QUALIFIED.
- A-08.6 Source-plan and TWINS-policy results are produced on identical cases with an identical cost model.

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Reports, null-control logs, approval-record samples.

## 12. Rollback / recovery approach
Evaluations additive; strategies default to retired/ineligible.

## 13. Exit gate and handoff
User decides which (if any) strategy versions are eligible; nothing becomes eligible by default.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
