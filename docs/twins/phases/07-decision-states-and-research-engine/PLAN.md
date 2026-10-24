# P07 - Eligibility states, case orchestration and research engine

- **State:** NOT_STARTED
- **Depends on:** P03, P04, P06
- **Primary requirements:** GV-02, TG-11, CS-03, CS-04, EV-01, RA-01, RA-02, RA-03, RA-04, RA-05, RA-07, MA-01, PB-02, PB-03, RE-01, RE-02, RE-03, RE-04, RE-07, RE-08, RE-09, CH-01, SY-01, SY-03, SY-04, PL-02, PL-03, XC-05
- **Also checked here (cross-phase dependencies/acceptance):** CS-01, EV-02, EV-03, LC-04, PB-01, PL-01, RA-06, SY-02, SZ-09, SZ-10, XC-10
- **Findings (primary owner):** F-003, F-014, F-017, F-018
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Implement the Step 4 research chain deterministically first: the WAIT / REJECT / EXPIRED / RESEARCH_ONLY / QUALIFIED state machine (research eligibility never means human approval), per-case orchestration with deadlines and bounded budgets, versioned evidence snapshots, the research components, synthesis with a separate TWINS_PLAN, and the independent challenge. Model-based reasoning is optional, separable, and never blocks the deterministic work.

Scope:
- Rename engine `APPROVE` and introduce the five eligibility states with reason codes; WAIT always carries blocker, recheck trigger and deadline.
- Case orchestration: research deadline, entry validity, holding deadline (policy values are owner decisions, D-022), required inputs, dependencies and bounded budgets per case; timeouts produce WAIT with the specific blocker.
- Versioned evidence snapshot per decision (reproducible decisions).
- Research components: global/macro, domestic regime, constituents/news, technical structure/invalidation, options and execution feasibility, event/stress scenarios; each emits evidence with provenance and freshness or an explicit `unavailable`.
- Synthesis: supporting, contrary, missing and correlated evidence; regime-strategy compatibility hook (returns `no eligible strategy` until P08); cost-adjusted tradeability; opportunity-decay / no-chase; unfamiliar-setup abstention.
- TWINS_PLAN separate from the unchanged SOURCE_PLAN; review checkpoints distinct from exit orders; T1-T4 optional.
- Independent challenge (different data or method, limitations recorded); a material unresolved objection blocks QUALIFIED; no independence claimed from a prompt change.
- Probability interface: research score and probability are separate fields; probability is null unless supported; insufficient support -> RESEARCH_ONLY.
- Hybrid target (D-026): deterministic safety and authority controls; statistical/analytical validation and probability components; model-assisted research behind deterministic gates (MA-01). Agents are logical responsibilities, not necessarily separate services, models or providers. Agent 12 and final eligibility (Agent 15 + policy engine) are deterministic and non-overridable.
- Independent challenge uses a distinct review procedure and independent checks where available; a different prompt or model alone is never represented as proven independence (RE-07).
- RESEARCH_ONLY initially means record only: no order, approval card or automatic trade simulation (D-029).
- 7E optional, per component: model-assisted research behind deterministic gates; none is authorized yet.

## 2. Explicit non-goals
- LLM is never an authority for entry, size or approval.
- No calibrated-probability claim.
- No order or approval flow.

## 3. Required inputs and entry gates
- D-008 (name of the renamed state and reason-code catalog), D-022 (deadline policy), D-024 (thresholds for decay/novelty/regime compatibility) - all UNRESOLVED.
- Q-019 ANSWERED (D-026): hybrid target architecture; per-agent table in PRODUCT_BASELINE.md. The hybrid target does NOT make an active model provider mandatory for any phase or release slice: 'no model component activated yet' is a valid state for P07. Q-009 stays UNRESOLVED (no model; local model; external provider; or a mixed deployment if separately proposed); provider selection, data disclosure and activation are unapproved.
- Q-026 ANSWERED (D-033): no 1:1 mapping of source targets to TWINS levels.
- P06 sizing available for cost/liquidity inputs; P04 data for components.

## 4. Existing reusable components and evidence
- `packages/decision-intelligence/src/*` - bull/bear/counter-thesis, source reliability, structural validation, immutable persistence
- `packages/signals/src/context/*` - as-of context

## 5. Subphases (independently testable)
- **7A** Eligibility state machine and rename
- **7B** Case orchestration, deadlines, budgets, evidence snapshot
- **7C** Research components (Agents 3-7 and 9)
- **7D** Synthesis, TWINS_PLAN, independent challenge, final eligibility
- **7E** Optional model-based reasoning (separable)

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T07.1 | Define the five states, transitions and reason-code catalog; compatibility migration for stored rows; WAIT payload (blocker, recheck trigger, deadline). | packages/decision-intelligence/src/types.ts, packages/database/ | - |
| T07.2 | Case orchestrator: deadlines, required inputs, parallel component execution with bounded budgets; EXPIRED on deadline. | services/worker, packages/decision-intelligence | T07.1 |
| T07.3 | Evidence snapshot object + id; decisions reference it; replay-from-snapshot tool. | packages/database/, packages/signals/src | T07.1 |
| T07.4 | Research components as isolated modules with a common evidence contract (provenance, as-of, freshness, quality, `unavailable`). | packages/market, packages/signals/src/context, packages/analytics | T07.3 |
| T07.5 | Synthesis and TWINS_PLAN builder; opportunity-decay and abstention checks; probability/score separation. | packages/decision-intelligence | T07.4 |
| T07.6 | Independent challenge component with documented data/method and limitations; blocking rule for unresolved material objections. | packages/decision-intelligence/src/counterThesis.ts | T07.5 |
| T07.7 | (Optional) model-based explanation harness with injection corpus; no tools, no credentials. | packages/ai | T07.5 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Case states: WAIT (blocker, recheck_trigger, deadline) | REJECT (terminal for the case version) | EXPIRED | RESEARCH_ONLY | QUALIFIED. Transitions: any -> WAIT on missing/stale input; WAIT -> QUALIFIED|REJECT|RESEARCH_ONLY|EXPIRED on new evidence or deadline; QUALIFIED -> EXPIRED if entry validity lapses before approval. EvidenceSnapshot(id, case_id, claim_version, items[{source, as_of, availability, values_hash}], versions{parser,feature,strategy,policy,model}). TWINS_PLAN(case_id, claim_version, entry{trigger, range}, initial_stop, checkpoints[], continuation_conditions, stop_adjustment_constraints, partial_exit_permissions, invalidation, time_exit, fallback) referencing an unchanged SOURCE_PLAN. TWINS_PLAN level types (D-033): review_checkpoint | partial_exit_level | hard_exit_objective; each level needs independent support and passes validation/eligibility rules; no mapping to source targets is required.

## 8. External dependencies and permissions
- 7C only: model provider and its terms.

## 9. Tests
- **Unit:** Transition table, reason-code catalog, plan builder, objection-blocking rule.
- **Integration:** Case orchestration with injected component latencies on the rehearsal database; snapshot replay.
- **End-to-end:** Library record -> orchestrated research -> final state with snapshot and TWINS_PLAN (fixture data only).
- **Failure-path:** Component timeout -> WAIT with blocker; model outage leaves deterministic path unaffected; injection corpus changes no state; missing inputs never synthesized.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-07.1 No engine output or column is named APPROVE (grep + test); QUALIFIED is never treated as approval anywhere (static + DB test).
- A-07.2 Every transition of the five-state machine has a passing test; WAIT always carries blocker, recheck trigger and deadline.
- A-07.3 Re-running a decision from its evidence snapshot id reproduces the same state and reason codes.
- A-07.4 A case past its research or entry deadline becomes EXPIRED; a component timeout yields WAIT with the specific blocker.
- A-07.5 TWINS_PLAN never mutates the SOURCE_PLAN (trigger test); source targets are preserved unchanged; every TWINS_PLAN level is typed review checkpoint | partial-exit level | hard exit objective; a plan with a single level is valid; T1-T4 are not required; checkpoint rows never create orders.
- A-07.7 Uncalibrated scores are labelled; probability is null unless supported.
- A-07.8 Each component fixture with missing input yields `unavailable`/WAIT/REJECT with a reason and no synthesized value (GV-02).
- A-07.6 A fixture with an unresolved material objection cannot reach QUALIFIED; insufficient validation support yields RESEARCH_ONLY, which creates no order, approval card or simulation.
- A-07.9 Static test: no model client is importable from risk, eligibility or approval code; a model outage leaves the deterministic path unaffected.
- A-07.10 Model-assisted output without schema validation and provenance is rejected; an injection corpus changes no state (MA-01).
- A-07.11 Every challenge report states, per check, what is independent (data source, code path, procedure) and what is not; none claims independence from a different prompt or model alone (RE-07).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Test logs; rename migration review; sample decisions with provenance.

## 12. Rollback / recovery approach
Compatibility mapping retained; revert migration via restore (frozen-migration policy).

## 13. Exit gate and handoff
User approves the state machine and authorizes P08/P09 as dependencies allow.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
