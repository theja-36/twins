# P10 - Paper execution, order lifecycle and reconciliation

- **State:** NOT_STARTED
- **Depends on:** P06, P09
- **Primary requirements:** RE-06, EX-01, EX-02, EX-03, EX-05, EX-06, EX-07, EX-09, EX-10, OP-01
- **Also checked here (cross-phase dependencies/acceptance):** AP-04, AP-05, CL-04, EX-08, EX-12, GV-01, GV-02, PL-02, PL-03, SC-01
- **Findings (primary owner):** -
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Exercise the complete order lifecycle and management logic against a simulated venue, including crash recovery and uncertain responses, with strict structural separation from any live adapter.

Scope:
- Paper adapter implementing the ExecutionProvider contract.
- Order lifecycle state machine with intent persisted before I/O and an explicit `unknown -> reconcile` path.
- Fill model (spread, slippage, lot, liquidity), charges, protection simulation, bounded management policy.
- Reconciliation job; crash/restart and emergency-mode drills.
- Static separation of paper from live.

## 2. Explicit non-goals
- No real broker connection or order.
- Simulated fills are not evidence of live results (stated in all reports).

## 3. Required inputs and entry gates
- P09 approved; P06 emergency controls in place.
- D-011 management policy and its re-approval boundaries.
- Q-028 (open-position policy definition), D-011, D-021.
- D-035 defines the open-position execution contract (OP-01) but activates no automation; its management-policy (D-011) and emergency-position (D-021) components are UNRESOLVED.

## 4. Existing reusable components and evidence
- `adapters/broker contracts (BrokerProvider/ExecutionProvider)` - interfaces
- `orders/fills/positions tables` - extend by migration
- `crash tests pattern` - tests/integration/runtime/crashRecovery.test.ts

## 5. Subphases (independently testable)
- **10A** Lifecycle state machine
- **10B** Paper venue and fill model
- **10C** Management and exits
- **10D** Reconciliation and drills

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T10.1 | Order intent/submission/ack/fill state machine with unknown-response handling. | packages/execution (new) | - |
| T10.2 | Paper adapter + deterministic fill model. | adapters/broker/paper (new) | T10.1 |
| T10.3 | Management policy executor within approved envelope; re-approval request on breach. | packages/execution | T10.2 |
| T10.4 | Reconciliation job and kill-and-restart drill. | services/worker, tests/integration/ | T10.2 |
| T10.5 | Static test: paper package has no path to live code; images contain no live adapter. | tests/unit/execution/ | - |
| T10.6 | Mandate enforcement gateway: orders must lie within contract, quantity, risk, entry range, management policy, expiry of the approved mandate. | packages/execution | T10.1 |
| T10.7 | Monotonic stop rule and verified stop adjustments; continuation review at each checkpoint. | packages/execution | T10.3 |
| T10.8 | Cancellation-with-fills reconciliation: cancel outstanding entry order where applicable, reconcile actual fills, never assume the cancellation succeeded; apply the open-position policy if a fill occurred. | packages/execution | T10.1 |
| T10.9 | Open-position execution contract (OP-01): versioned references to the mandate-bound management policy, the configured emergency-position policy and the deterministic invariants; `incomplete` when a component is missing; continuation logic cannot override safety restrictions. Automation stays disabled until the owner activates it. | packages/execution | T10.3 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
OrderIntent(id, proposal_version_id, idempotency_key, state: armed|intent|submitted|acked|partial|filled|cancelled|rejected|unknown). unknown -> reconciling -> (acked|rejected|not_found). Intent is persisted before any I/O; unknown never leads to blind resubmit. OPEN_POSITION_CONTRACT(mandate_id, management_policy_version, emergency_policy_version, invariants_version, state: complete | incomplete); documentation label for the contract defined by D-035.

## 8. External dependencies and permissions
- None (simulation).

## 9. Tests
- **Unit:** Transition tests; fill model fixtures.
- **Integration:** Reconciliation against paper ledger on real PostgreSQL.
- **End-to-end:** Proposal -> approval -> pre-flight -> paper fill -> management -> exit -> realized P&L.
- **Failure-path:** Crash between intent and submit; duplicate submit prevented; partial fill; unprotected fill escalation; feed outage during position.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-10.1 Kill-and-restart at every lifecycle step reconciles with zero duplicate or lost intents.
- A-10.2 Realized P&L equals recomputation from fills + charges.
- A-10.3 Unprotected fill escalates within the policy window (fake-clock test).
- A-10.4 Actions outside the approved envelope require new approval.
- A-10.5 Static separation tests pass.
- A-10.6 Property test: no order outside the mandate passes the gateway.
- A-10.7 Monotonic-stop property test: the stop is never widened and risk never increased without a new approval.
- A-10.8 Cancel-vs-fill race fixtures reconcile to the broker/paper ledger; a cancellation is never assumed successful (SC-01).
- A-10.9 The open-position contract references versions of all three components; with any component missing it is `incomplete`, automation stays disabled, an alert is raised and no action is improvised; a continuation rule cannot override a safety restriction (property test).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Drill transcripts; reconciliation reports; test logs.

## 12. Rollback / recovery approach
Paper only; disable executor job; tables additive.

## 13. Exit gate and handoff
User reviews the paper track record (period set by the owner) and the drills.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
