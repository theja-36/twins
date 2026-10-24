# P06 - Risk engine scaffolding, production-budget gating and emergency controls

- **State:** NOT_STARTED
- **Depends on:** P00
- **Primary requirements:** SZ-01, SZ-02, SZ-03, SZ-04, SZ-05, SZ-06, SZ-07, SZ-08, SZ-09, SZ-10, SZ-11, EX-08, EX-12
- **Also checked here (cross-phase dependencies/acceptance):** EX-10, GV-01, MA-01, OP-01, PL-02, RA-05, RA-07, RE-04
- **Findings (primary owner):** F-002
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Build the deterministic risk evaluator and emergency-control state machine as tested scaffolding that FAILS CLOSED, and separately define how an owner-supplied production policy is activated. The engine alone decides how many lots (if any) may be proposed; no budget value is invented or defaulted by this work.

Scope:
- 6A Scaffolding (needs no owner budget values): policy schema and validation, sizing function, reservation ledger with transactional locks and fencing, limit evaluation, emergency state machine, authority-boundary and no-override tests. Tests use explicitly labelled TEST-ONLY fixture policies that live under tests/ and carry `environment: test`.
- 6B Production policy configuration (needs the owner): policy records supplied and approved by the owner outside the repository, activated only by a recorded approval; no numeric budget literal or default exists in non-test source.
- Fail-closed behaviour: no active approved production policy -> zero lots -> no executable proposal; a TEST-ONLY policy is refused by any production gateway; execution adapters (P10/P12) refuse to run without an active approved policy.
- Sizing inputs from a timestamped account snapshot: planned stop-based risk per lot and stressed-loss scenarios kept as separate fields; fees/slippage/lot rounding/liquidity/broker constraints; exposure and correlation model (definition is an owner decision).
- No majority vote or agent consensus can override a deterministic veto (property test).
- Emergency control state machine: stop new orders / cancel pending / maintain protection / flatten as four distinct modes; pausing new entries never removes protection; emergency-position policy is owner-defined (D-021).
- Static rule: packages/risk imports no AI or broker code.

## 2. Explicit non-goals
- No broker connection, no order placement, no AI.
- No profitability thresholds.

## 3. Required inputs and entry gates
- 6A: none beyond P00 (no budget values are needed or invented).
- 6B: D-007 (owner's risk budgets, quality tiers, loss limits, correlation definition) and D-021 (emergency-position policy), plus an explicit owner approval record; until then production stays fail-closed.

## 4. Existing reusable components and evidence
- `tables accounts, positions, risk_decisions, portfolio_snapshots (unused)` - evaluate and extend via migration
- `TWINS_Planning_Pack/07_RISK_APPROVAL_EXECUTION.md` (an untracked local source, not available in the repository) - historical provenance only; this plan does NOT rely on its content, which has not been inventoried (task T00.6)
- `tests/integration/runtime/concurrency.test.ts` - concurrency test pattern

## 5. Subphases (independently testable)
- **6A** Scaffolding: schema, sizing, reservations, limits (test-only fixtures)
- **6B** Production policy activation (owner-supplied, approval-recorded)
- **6C** Emergency modes and emergency-position policy hook
- **6D** Fail-closed and boundary tests

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T06.1 | Policy schema + validation + versioning. | packages/risk (new), packages/database/drizzle/ | - |
| T06.2 | Sizing function: lots = floor(min over constraints); returns reasons; zero => no_trade. | packages/risk/src | T06.1 |
| T06.3 | Reservation ledger with SERIALIZABLE/advisory lock + fencing token; concurrent integration test. | packages/risk/src, tests/integration/ | T06.1 |
| T06.4 | Daily/portfolio limit evaluation and reset-by-recorded-action. | packages/risk/src | T06.2 |
| T06.5 | Emergency-mode state machine and persisted control state. | packages/risk/src, packages/database/ | - |
| T06.6 | Static dependency test: no import path to packages/ai, adapters/broker execution, or model clients. | tests/unit/risk/ | - |
| T06.7 | Fail-closed tests: no policy, test-only policy in production gateway, expired/unsigned policy, stale snapshot -> zero lots. | tests/unit/risk, tests/integration/ | T06.1, T06.2 |
| T06.8 | Property test: arbitrary agent outputs + a veto -> no proposal (no majority-vote override). | tests/unit/risk | T06.2 |
| T06.9 | Static test: no numeric budget literal or default policy in packages/risk/src. | tests/unit/risk | T06.1 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
RiskPolicy(version, budgets, tiers, limits, approved_by, approved_at). SizingResult(lots, planned_risk_per_lot, stressed_loss_per_lot, reasons[], inputs_hash). Reservation(account, proposal, amount, fence, state). EmergencyState: normal|no_new_orders|cancel_pending|hold_protection|flatten_requested (transitions explicit; flatten only by explicit action). RiskPolicy.environment: test | production; only an owner-approved production policy with approved_by/approved_at can be `active`; engine input without an active policy -> SizingResult(lots=0, reason=no_policy).

## 8. External dependencies and permissions
- None (pure library + database).

## 9. Tests
- **Unit:** Hand-calculated sizing fixtures; rounding always down; missing input -> zero lots.
- **Integration:** N parallel reservations never exceed limit (real PostgreSQL).
- **End-to-end:** Proposal builder returns no_trade when lots == 0.
- **Failure-path:** Stale account snapshot -> zero lots.; Policy missing/unsigned -> engine refuses.; No policy / test-only policy / expired policy -> zero lots in the production path.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-06.1 All sizing fixtures match hand calculation.
- A-06.2 Concurrency test shows zero over-reservation across repeated runs.
- A-06.3 Each of the four emergency modes is a separate state with its own test.
- A-06.4 Static test proves no AI/broker imports.
- A-06.5 Zero permissible lots yields no executable proposal.
- A-06.6 With no active approved production policy the engine returns zero lots and the production gateway refuses every proposal.
- A-06.7 A TEST-ONLY policy cannot be activated in production (refused by the gateway).
- A-06.8 Property test: a deterministic veto cannot be outvoted by any combination of agent outputs.
- A-06.9 No numeric budget literal exists in non-test source of packages/risk.
- A-06.10 With no explicitly configured emergency-position policy, the emergency modes take no invented action: they report `policy missing`, alert, and leave existing protection in place (D-035).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Test logs, fixture hand-calculation sheet, policy approval record.

## 12. Rollback / recovery approach
Library + additive tables; not wired into any runtime path until P09.

## 13. Exit gate and handoff
User approves the risk core as the only authority for entry sizing.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
