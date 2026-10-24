# P11 - Outcome learning and governance

- **State:** NOT_STARTED
- **Depends on:** P08, P10
- **Primary requirements:** OL-01, OL-02, OL-03, OL-04, OL-05, OL-06, OL-07, OL-08
- **Also checked here (cross-phase dependencies/acceptance):** EV-01, GV-01, RE-05, XC-10
- **Findings (primary owner):** -
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Record every decision and outcome with full version attribution, monitor drift, and route all changes through reviewed approvals — without letting learning change risk policy or promote strategies.

Scope:
- Decision store including WAIT/REJECT; actual vs counterfactual separation.
- Attribution to strategy, model, prompt, data and policy versions.
- Drift monitoring and reports.
- Change-request workflow requiring user approval; learning DB role with no privilege on risk or strategy state.

## 2. Explicit non-goals
- No automatic retraining promotion; no policy self-modification.

## 3. Required inputs and entry gates
- P08 and P10 approved; D-012 review cadence.

## 4. Existing reusable components and evidence
- `signal_validations / decisions tables` - extend
- `rolePrivileges test pattern` - enforce OL-05

## 5. Subphases (independently testable)
- **11A** Decision and attribution store
- **11B** Drift monitoring
- **11C** Governed change workflow

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T11.1 | Attribution columns/tables and writers in every decision path. | packages/database/, packages/decision-intelligence | - |
| T11.2 | Counterfactual store separated by constraint and role. | packages/database/ | T11.1 |
| T11.3 | Drift report job. | packages/analytics | T11.1 |
| T11.4 | Change-request + approval records; learning-role privilege tests. | infrastructure/staging, tests/integration/ | T11.1 |
| T11.5 | Policy comparison report: source vs fixed TWINS vs adaptive on identical cases and costs. | packages/analytics | T11.1 |
| T11.6 | Outcome attribution into selection, entry, exit and execution effects. | packages/analytics | T11.5 |
| T11.7 | Promotion pipeline records (learn, test, unseen evaluation, paper/shadow, independent review, explicit promotion, monitoring); no automatic live promotion. | packages/database/, scripts/ | T11.4 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
DecisionRecord(..., versions{strategy,model,prompt,data,policy}); Counterfactual(decision_id, hypothetical_outcome, method_version) in a separate table; ChangeRequest(target, proposed_by, evidence, state, approved_by).

## 8. External dependencies and permissions
- None.

## 9. Tests
- **Unit:** Attribution completeness tests.
- **Integration:** Privilege test: learning role cannot write risk/strategy-state tables.
- **End-to-end:** Decision -> outcome -> drift report.
- **Failure-path:** Learning job attempting policy change is refused.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-11.1 Every decision row carries all five version ids.
- A-11.2 Counterfactuals cannot enter actual-performance views (constraint/test).
- A-11.3 Learning role cannot modify risk policy or strategy state (privilege test).
- A-11.4 Drift report reproducible from stored data.
- A-11.5 Attribution components sum to the total difference on a fixture.
- A-11.6 A promotion without every stage record and a user approval is refused.

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Privilege report, sample drift report, test logs.

## 12. Rollback / recovery approach
Additive; disable jobs.

## 13. Exit gate and handoff
User approves governance process; any live use still requires P12.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
