# P12 - Broker integration and controlled live

- **State:** NOT_STARTED
- **Depends on:** P10, P01, P00
- **Primary requirements:** EX-04
- **Also checked here (cross-phase dependencies/acceptance):** EX-05, EX-08, EX-09, SZ-11, XC-07, XC-09
- **Findings (primary owner):** -
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Integrate a broker read-only first, then enable controlled live orders only behind separate, revocable owner approvals.

Scope:
- Read-only account/positions/funds integration.
- Documented per-broker protection-order and order-type capabilities from the broker's own documentation/sandbox (nothing assumed).
- Separate live execution service, credentials, network and database role.
- Broker reconciliation after crashes/disconnects; kill-switch and emergency-mode drills on the live adapter in sandbox/read-only form.
- Staged enabling gates; first live order is its own approval.

## 2. Explicit non-goals
- No live order before every entry gate is met and the user explicitly authorizes the specific step.
- `LIVE_TRADING` stays false until that authorization.

## 3. Required inputs and entry gates
- P10 approved with a paper record the owner accepts; F1 independent review closed; compliance register conclusions recorded (D-013); risk policy approved; broker choice and account (Q-010).
- Every step (read-only, first sandbox order, first live order) separately approved and revocable.

## 4. Existing reusable components and evidence
- `P10 lifecycle and reconciliation` - unchanged contracts
- `P06 emergency controls` - wired to live adapter

## 5. Subphases (independently testable)
- **12A** Broker read-only
- **12B** Capability matrix and protection orders
- **12C** Live adapter in sandbox
- **12D** Controlled live enablement

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T12.1 | Read-only adapter and account snapshot feed into P06. | adapters/broker/<vendor> | - |
| T12.2 | Capability matrix document from broker evidence. | docs/twins/audit/07_APPROVAL_AND_EXECUTION_AUDIT.md | - |
| T12.3 | Live execution service skeleton with separate credentials/role/network; sandbox tests. | services/execution (new) | T12.1 |
| T12.4 | Reconciliation against broker state; kill-switch drills. | services/execution, tests/ | T12.3 |
| T12.5 | Enablement checklist and per-step approval records. | docs/twins/roadmap/RELEASE_GATES.md | T12.4 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Same OrderIntent contract as P10; live adapter accepts only an approved, pre-flighted, risk-sized intent; credentials exist only in the execution service.

## 8. External dependencies and permissions
- Broker account/API subscription and any registration (e.g. static IP) the broker or regulator requires.
- Owner-held credentials.
- Compliance review outcome.

## 9. Tests
- **Unit:** Adapter contract tests with recorded sandbox fixtures.
- **Integration:** Reconciliation drills against sandbox.
- **End-to-end:** Sandbox: approved intent -> order -> fill -> reconciliation.
- **Failure-path:** Broker timeout/uncertain response -> reconcile, never resubmit blindly.; Credential revocation halts submission.; Kill-switch modes behave as specified.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-12.1 Capability matrix cites broker documentation/sandbox evidence per order type.
- A-12.2 Reconciliation drill passes after forced disconnects and restarts.
- A-12.3 Live adapter is absent from every image except the execution service image.
- A-12.4 Each enabling step has a recorded user approval and a tested rollback (credential revocation).
- A-12.5 The live gateway enforces the approved mandate and refuses to run without an active approved production risk policy (SZ-11, EX-09).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Sandbox transcripts (no secrets), drill reports, approval records.

## 12. Rollback / recovery approach
Kill-switch modes + credential revocation; LIVE_TRADING literal returns to false.

## 13. Exit gate and handoff
Only the user can declare any live step complete.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
