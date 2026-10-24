# P03 - Signal library, case identity and claim versions (T6)

- **State:** NOT_STARTED
- **Depends on:** P00
- **Primary requirements:** TG-03, TG-07, CS-01, CS-02, LC-01, PL-01, XC-10
- **Also checked here (cross-phase dependencies/acceptance):** CL-01, CR-01, GV-01, MD-02, TG-06, TG-15
- **Findings (primary owner):** F-010, F-016
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Implement the approved parts of the T6 design and add the case model the architecture requires: an immutable, provenance-rich library of source claims, case identity with claim versions and origins (TELEGRAM or TWINS_GENERATED), deduplication by clusters, lineage ids, and a structural research-only barrier for historical imports. SOURCE_PLAN stays unchanged forever.

Scope:
- signal_origins, signal_records, cluster and membership tables with append-only triggers.
- Ingest from existing options_claims; backfill of existing claims as `historical_import` / `research_only`.
- Deterministic clustering rules, versioned.
- Roles: ingest and research roles with least privilege.

## 2. Explicit non-goals
- No outcomes (P05), no recommendations, no scoring.
- No change to the approval bot's role.

## 3. Required inputs and entry gates
- D-006 is explicitly DEFERRED (2026-10-24): no freshness window (the 30-minute figure was only a proposal), outcome horizon, dedup tolerance or library role is selected. Blocked until decided: assignment of `actionability` to live records and the freshness cut-off (3A), clustering tolerances (3C), library roles and privilege tests (3D), and any use of outcome horizons (P05). The deferral is not authorization to execute any of this work.
- Soft dependency on P02: message classes/relations should be available, or their absence explicitly accepted by the owner; the library reserves nullable links for them.

## 4. Existing reusable components and evidence
- `docs/implementation/phase1/T6_SIGNAL_LIBRARY_DESIGN.md` - proposal
- `packages/database/drizzle/0008_approval_bot_review_log.sql` - append-only trigger pattern and privilege test pattern (tests/integration/approvalBot/rolePrivileges.test.ts)

## 5. Subphases (independently testable)
- **3A** Schema + ingest + research-only backfill
- **3B** Case identity, claim versions, origin and parent links, lineage ids
- **3C** Clustering
- **3D** Roles and static boundary tests

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T03.1 | Migration 0009: tables, CHECK (historical_import => research_only), update/delete/truncate triggers. | packages/database/drizzle/, packages/database/src/schema/ | - |
| T03.2 | Library ingest from options_claims with fingerprinting and provenance snapshot. | packages/signals/src/ | T03.1 |
| T03.3 | Clustering rules v1 and membership supersession. | packages/signals/src/ | T03.2 |
| T03.4 | Roles SQL + privilege tests on real PostgreSQL; static test: library tables carry no approval/order columns. | infrastructure/staging/, tests/integration/ | T03.1 |
| T03.5 | cases / case_claim_versions (case_id, claim_version, origin, parent_case_id), lineage id columns; SOURCE_PLAN immutability trigger. | packages/database/drizzle/, packages/database/src/schema/ | T03.1 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
signal_records immutable; actionability set once (research_only|candidate_only) and enforced by trigger; clusters/memberships append-only with `superseded_by`. Full spec: T6 design sections 3-4.

## 8. External dependencies and permissions
- Owner decisions D-006 (freshness window, tolerances, backfill).

## 9. Tests
- **Unit:** Fingerprint and clustering rule tests with labelled duplicate fixtures.
- **Integration:** Real-PostgreSQL privilege and trigger tests; backfill idempotency.
- **End-to-end:** options_claims -> library -> cluster view on rehearsal DB.
- **Failure-path:** Attempted UPDATE of actionability is refused (SQLSTATE 23001).; Duplicate ingest is a no-op.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-03.1 A historical_import row can never be referenced by a recommendation/proposal row (trigger test).
- A-03.2 Re-running ingest creates 0 rows.
- A-03.3 Labelled duplicate fixtures cluster as expected; both records retained.
- A-03.4 Library roles cannot write any non-library table (privilege test).
- A-03.5 A revised source claim creates a new claim_version under the same case_id and never overwrites; parent links resolve.
- A-03.6 UPDATE of a stored SOURCE_PLAN/claim column is refused (trigger test); authority-boundary test for library roles passes (GV-01).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Migration hash pinned in a test, integration logs, privilege report.

## 12. Rollback / recovery approach
Migrations are frozen once applied; rollback is by restore from the pre-migration backup (drill proven) — no down-migration is offered.

## 13. Exit gate and handoff
User reviews and authorizes next phase; staging migration is a separate approval.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
