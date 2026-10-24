# P00 - Baseline, governance and open decisions

- **State:** IN_PROGRESS
- **State note:** Documentation-only work authorized by the owner on 2026-10-24. P00 stays IN_PROGRESS: A-00.3 is BLOCKED (F1 reviewer unassigned) and the owner's exit authorization is missing. A-00.1, A-00.2, A-00.4 and A-00.5 meet their exact wording only - these are mechanical, assistant-produced results, not independent verification. No gate is passed, no waiver or retrospective approval exists, and no later phase is authorized.
- **Depends on:** none
- **Primary requirements:** GV-01, XC-07, XC-09
- **Also checked here (cross-phase dependencies/acceptance):** -
- **Findings (primary owner):** F-001, F-007, F-012, F-013, F-019, F-020
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Make the product baseline, requirement IDs and decisions authoritative and tracked, and clear the process blockers that no engineering work can clear (missing diagram, independent F1 reviewer, compliance register, documentation tracking policy).

Scope:
- Reconcile the received architecture (2026-10-24) with PRODUCT_BASELINE.md and the traceability matrix; keep stable requirement IDs and append new ones.
- Authority-boundary rule (GV-01): every later phase that adds a component carries an authority-boundary test in its acceptance.
- Freeze requirement IDs; record every owner choice in DECISION_LOG.md instead of hiding it as an assumption.
- Name the independent reviewer for F1 and hand over the existing review package.
- Create the external-terms and regulatory register (Telegram, Yahoo, data vendor, broker, exchange/SEBI) with an owner for each row; this records questions, it does not claim compliance.
- Decide the tracking policy for docs/twins, TWINS_Planning_Pack and .vscode.

## 2. Explicit non-goals
- No application code, schema, deployment or runtime change.
- No legal conclusions; the register lists what must be reviewed and by whom.

## 3. Required inputs and entry gates
- None for starting. Advancement of any later phase requires an explicit user instruction.

## 4. Existing reusable components and evidence
- `docs/implementation/ROADMAP_AND_AUDIT_2026-10-22.md` - prior audit; section H questions carried into OPEN_QUESTIONS.md
- `docs/implementation/review/F1_REVIEW_PACKAGE.md` - ready-to-hand review package for the independent reviewer
- `TWINS_Planning_Pack/` (an untracked local source, not available in the repository) - earlier proposed baseline; historical provenance only, not relied on by this phase; its ADR text is quoted where needed (D-016, SZ-06); ADR-001 etc. are proposals, not decisions

## 5. Subphases (independently testable)
- **0A** Baseline reconciliation (architecture received 2026-10-24; owner review pending)
- **0B** Decision and question triage
- **0C** F1 reviewer + compliance register

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T00.1 | Architecture received, reconciled and documented (2026-10-24); the owner accepted the documented architecture and requirement set as the intended product scope (D-037) without certifying mapping adequacy, verified statuses, safety, compliance or release readiness. | docs/twins/PRODUCT_BASELINE.md, REQUIREMENTS_TRACEABILITY.md | - |
| T00.2 | A-00.2 prerequisites are recorded as explicit deferrals with the blocked work named (Q-003 D-038, Q-006 D-039, Q-007 D-040, Q-017 D-041, Q-018 D-042; D-006; D-030a). Resolving them later is separate work. | docs/twins/OPEN_QUESTIONS.md, DECISION_LOG.md | T00.1 |
| T00.3 | Tracking policy D-002 accepted in principle (not authorizing add/commit/push). Open: D-002a (Planning Pack, deferred pending inventory T00.6) and D-002b (.vscode); no .gitignore change. A documentation-only commit candidate is prepared unstaged (D-044); the exact preservation action needs separate approval. | docs/twins/DECISION_LOG.md | - |
| T00.4 | F1: reviewer profile recorded (D-036); review package refreshed against target 702d4a82ba37e3e533f5acdd652b290bb025e7b1. Reviewer UNASSIGNED (owner action); D-031 unresolved. The assistant does not contact a reviewer or self-certify. | docs/implementation/review/F1_REVIEW_PACKAGE.md | - |
| T00.5 | Compliance register maintained with the product owner as coordination role only; qualified reviewers UNASSIGNED; rows stay UNVERIFIED (questions only; no compliance claims). | docs/twins/audit/08_SECURITY_AND_OPERATIONS_AUDIT.md (register section) | - |
| T00.6 | Inventory the unique content of TWINS_Planning_Pack so D-002a can be decided. Read-only; no deletion; not started. | TWINS_Planning_Pack/ (untracked local directory; read-only), docs/twins/DECISION_LOG.md | - |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Decision records: `D-nnn | date | decision | decided-by | rationale | status(DECIDED/PROPOSED/OPEN)`. Requirement rows are immutable by ID; changes append a note. No runtime data contracts.

### P00 exit criteria: complete checklist (no criterion changed in this round)

| Criterion | Result | Exact remaining item |
|---|---|---|
| A-00.1 | PASS (wording only) | Evidence is recorded in three separate attestations (below). The owner accepted the documented scope (D-037); that is not certification of mapping adequacy, implementation statuses, safety, compliance or release readiness, and no independent coverage review exists. |
| A-00.2 (revised wording) | PASS (wording only) | D-002 and D-014a DECIDED; D-006, the deferred portions of Q-025 (D-030a), Q-003, Q-006, Q-007, Q-017 and Q-018 explicitly DEFERRED (D-038..D-042) with the blocked work named. Deferral does not authorize executing the blocked work, and the blocked items remain unresolved for their phases. |
| A-00.3 | BLOCKED | The owner assigns an F1 reviewer matching the D-036 profile (currently UNASSIGNED) and the refreshed package is delivered. D-031 and the F-020 discrepancy stay unresolved; no waiver or retrospective approval exists. |
| A-00.4 | PASS (wording only) | The register exists and each row names the product owner as the COORDINATION role only. All six rows remain UNVERIFIED; qualified reviewers are UNASSIGNED; this is not a legal or compliance review. |
| A-00.5 | PASS (wording only) | Q-019..Q-028 each answered or explicitly deferred. |
| Exit gate | NOT_PASSED | The owner's explicit authorization after review. |

**A-00.2 wording history.** Prior wording (preserved): "DECISION_LOG.md has a DECIDED/PROPOSED/OPEN status for every decision needed by P01-P03." The revised wording is in section 10; it is stricter (a recorded OPEN status is not enough).

**A-00.1 attestations, recorded separately.**
| Attestation | Produced by | Evidence | Not established |
|---|---|---|---|
| Owner acceptance of intended product scope | Owner (2026-10-24, D-037) | Acceptance of the documented six-step architecture and reconciled requirement set as the intended scope, subject to the recorded decisions and explicit deferrals | Not certification that every detail is adequately mapped, that statuses are verified, or that the system is safe, compliant or release-ready |
| Architecture-to-requirement coverage evidence | Assistant | PRODUCT_BASELINE.md mapping table (element -> requirement IDs); a presence check that every requirement ID maps to an element and every mapped ID exists, run by the assistant with tooling that is not in this repository (historical assistant-produced evidence; the repository cannot reproduce it) | Not independently reviewed; the checker is outside the repository and no tooling is added by this documentation; semantic adequacy of each mapping is unverified |
| Repository/source implementation verification | Assistant | Requirement statuses with file/line evidence, earlier test runs, one read-only staging observation | Not independently verified; hosted CI, image-to-commit mapping (F-009), host posture and F1 review are open |

Gate G0 refers to these criteria directly (A-00.1..A-00.5), so the scope cannot drift between the gate and the criterion.

## 8. External dependencies and permissions
- The owner's architecture diagram.
- An independent reviewer for F1 (person chosen by the owner).
- A qualified reviewer for terms/regulatory questions (owner decides who).

## 9. Tests
- **Unit:** Not applicable (documentation phase).
- **Integration:** Traceability check: every requirement ID appears in exactly one phase; every finding maps to a phase (script or manual checklist recorded in TEST_EVIDENCE.md).
- **End-to-end:** Not applicable.
- **Failure-path:** A requirement with no phase or a finding with no phase blocks exit.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-00.1 The architecture is stored as the canonical baseline and every element maps to a requirement ID or a logged new requirement (DONE in documentation 2026-10-24; awaiting the owner's review).
- A-00.2 (revised 2026-10-24; prior wording preserved in section 7) Every decision and prerequisite relevant to P01-P03 - D-002, D-006, D-014a and the information prerequisites Q-003, Q-006, Q-007, Q-017, Q-018 and the deferred portions of Q-025 - is recorded as DECIDED, or as explicitly DEFERRED with the affected work named as blocked. None may remain UNRESOLVED without an agreed deferral. An explicit deferral records that the blocked work stays blocked; it never authorizes executing it.
- A-00.3 F1 reviewer named by the owner and the package delivered (sign-off itself is tracked separately; P12 requires it).
- A-00.4 Compliance register exists with an owner per row.
- A-00.5 Every residual question Q-019..Q-028 has an owner answer or an explicit deferral (as of 2026-10-24: answered Q-019..Q-024, Q-026, Q-028; Q-025 partly answered with the remainder explicitly deferred - D-030a; Q-027 explicitly deferred - D-034). A deferral does not authorize the blocked work.

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Dated copy of the diagram and the reconciliation table.
- Owner's recorded answers.
- Reviewer acknowledgement.

## 12. Rollback / recovery approach
Documentation only: revert the commit; prior versions remain in git history.

## 13. Exit gate and handoff
User reviews the reconciliation and explicitly authorizes P01 (and any parallel phase they choose).

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
