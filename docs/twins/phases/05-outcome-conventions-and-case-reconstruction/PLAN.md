# P05 - Outcome conventions and case reconstruction

- **State:** NOT_STARTED
- **Depends on:** P03, P04
- **Primary requirements:** CR-01, CR-02, CR-03, CR-04, CR-05, CR-06
- **Also checked here (cross-phase dependencies/acceptance):** GV-02, OL-07, SV-02, SV-07
- **Findings (primary owner):** F-004
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Produce reproducible, leakage-free outcome labels for historical cases, keeping reconstructed, paper and actual results separate and preserving unresolved cases.

Scope:
- Owner-approved written conventions BEFORE any evaluator code (entry eligibility, expiry, stop, target, costs, slippage, fill assumptions, same-bar ambiguity).
- Outcome schema with kind (reconstructed|paper|actual), evaluator versioning, unresolved states.
- Deterministic evaluator job and hand-verified sample.
- Case view linking message, revisions, claim, evidence and outcome.

## 2. Explicit non-goals
- No performance claims, scorecards or strategy discovery (P08).
- No paper/actual rows created here (schema supports them; only `reconstructed` is written).

## 3. Required inputs and entry gates
- D-005 conventions approved by the owner.
- P04 coverage accepted; P03 library available.

## 4. Existing reusable components and evidence
- `packages/signals/src/context/market.ts` - as-of selection
- `backtests/backtest_results tables (unused)` - evaluate reuse vs new outcome tables in 5A
- `T6 design section 3 signal_outcomes` - starting schema

## 5. Subphases (independently testable)
- **5A** Conventions document (owner decision)
- **5B** Schema
- **5C** Evaluator + unresolved handling
- **5D** Verification sample and case view

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T05.1 | Draft conventions options with consequences; owner decides; freeze as versioned document. | docs/twins/DECISION_LOG.md, docs/implementation/ | - |
| T05.2 | Outcome tables (append-only, versioned) with kind and method_version. | packages/database/drizzle/, schema | T05.1 |
| T05.3 | Evaluator in a worker job; missing/ambiguous -> unresolved with reason. | services/worker, packages/analytics (new) | T05.2 |
| T05.4 | Leakage tests (future bar inserted changes nothing); hand-computed fixtures; sample verification report. | tests/ | T05.3 |
| T05.5 | Case view API/page. | apps/api, apps/web | T05.3 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
outcome(signal_record_id, kind, method_version, horizon, entry_basis, mfe, mae, hit_target, hit_stop, result: win|loss|flat|unresolved, reason, costs_assumed, computed_at). Append-only; new method version adds rows.

## 8. External dependencies and permissions
- None beyond P04 data.

## 9. Tests
- **Unit:** Property tests (monotonicity, reproducibility); hand-computed fixtures.
- **Integration:** Evaluator on rehearsal DB; re-run is identical.
- **End-to-end:** Library record -> outcome -> case view.
- **Failure-path:** Missing bars -> unresolved, never guessed.; Same-bar stop/target -> flagged ambiguous per the convention.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-05.1 100% of the hand-verified sample matches the evaluator.
- A-05.2 Re-running the evaluator at the same version yields identical rows.
- A-05.3 Inserting a future bar changes no historical outcome.
- A-05.4 Ambiguous/unresolved counts are reported, not hidden.
- A-05.5 Outcome kinds cannot be mixed in one aggregate (DB check/test).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Conventions document with approval record, verification report, test logs.

## 12. Rollback / recovery approach
Outcome versions are additive; discard a method version by flag.

## 13. Exit gate and handoff
User approves labels as usable ground truth for P08.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
