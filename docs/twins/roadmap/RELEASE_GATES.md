# Release gates

Gates are checkpoints between *capability levels*. Passing a gate requires the evidence listed and an **explicit user authorization**; no gate is passed by the existence of planning files. Gate numbers are not phase numbers.

| Gate | Capability level | Evidence required | Phases involved |
|---|---|---|---|
| G0 | Baseline accepted | P00 exit: criteria A-00.1..A-00.5 all PASS (including the residual-question scope in A-00.5) and the owner's explicit authorization | P00 |
| G1 | Operationally safe | Image provenance; alert drills; off-host restore pass; durable intake failure matrix; hosted CI green. Off-host backup/restore acceptance is blocked by the Q-007 deferral (D-040); alert acceptance by the Q-018 deferral (D-042). Production alert readiness is NOT claimed while thresholds or the alert destination are unresolved (D-030a) | P01 |
| G2 | Data complete enough to research | Intake completeness tests, accuracy baseline, library, coverage matrix accepted | P02, P03, P04 |
| G3 | Ground truth available | Conventions approved, outcome sample verified, leakage tests | P05 |
| G4 | Risk core verified | Sizing fixtures, concurrency test, emergency modes, static no-AI rule | P06 |
| G5 | Decision & strategy ready | State machine tests; strategy validation incl. null control; user-approved eligible versions (may be none) | P07, P08 |
| G6 | Approval path (no orders) | Proposal-bound approvals, pre-flight truth table, replay/stale tests, real-PostgreSQL decide() test | P09 |
| G7 | Paper trading | Lifecycle drills, reconciliation, paper record accepted by the owner for an owner-set period | P10, P11 |
| G8 | Broker read-only | Capability matrix from broker evidence, read-only reconciliation, F1 closed, compliance conclusions | P12A/B |
| G9 | Controlled live | Separate user approval per step (sandbox order, first live order); credential revocation tested; `LIVE_TRADING` remains false until the owner authorizes the specific step | P12C/D |

## Current state
All gates are `NOT_PASSED`; see [../STATUS.md](../STATUS.md) section 3 (kept there so the state exists once). Receiving the architecture does not pass G0.

## Rules
1. A gate cannot be skipped; the earliest unpassed gate blocks later *deployment*, not necessarily later *development* (see DEPENDENCY_MAP parallelism).
2. Failing evidence moves the phase to `BLOCKED` or back to `IN_PROGRESS`, never to complete.
3. Rollback for each gate is the phase's rollback section; live steps additionally require credential revocation and emergency-mode drills.
4. The user, and only the user, sets phase states to `APPROVED_COMPLETE`.
