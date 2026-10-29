# TWINS product documentation (docs/twins)

Documentation-only work. **No implementation, deployment, migration, restart, credential change, commit or push was performed.** Phase states are in [STATUS.md](STATUS.md); only the user may authorize a phase to advance.

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Canonical entry points (one source of truth per subject)
| Subject | Canonical document |
|---|---|
| Product architecture and boundaries (received 2026-10-24) | [PRODUCT_BASELINE.md](PRODUCT_BASELINE.md) |
| Requirements, status, evidence, phase ownership, acceptance tests | [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) |
| Findings and recommendations | [audit/10_FINDINGS_AND_RECOMMENDATIONS.md](audit/10_FINDINGS_AND_RECOMMENDATIONS.md) |
| Owner decisions (DECIDED / PROPOSED / OPEN) | [DECISION_LOG.md](DECISION_LOG.md) |
| Information requests to the owner | [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) |
| Baseline state, phase states, release readiness | [STATUS.md](STATUS.md) |
| Runtime safety state, kill switch, fail-closed rules, integration points (Stage 1 / Task 2) | [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md) |
| Immutable audit trail, hash chains, verifier, role separation, operator identity (Stage 1 / Task 3) | [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md) |
| Historical archive import: input contract, identity, dedup, normalization, commands, report (Stage 4 / Task 1) | [HISTORICAL_ARCHIVE_IMPORT.md](HISTORICAL_ARCHIVE_IMPORT.md) |
| Historical outcome evaluation: data contract, rules, outcome taxonomy, options, evidence, commands (Stage 4 / Task 2) | [HISTORICAL_OUTCOME_EVALUATION.md](HISTORICAL_OUTCOME_EVALUATION.md) |
| Source scorecards and trust tiers: identity, metrics, formulas, tiers, thresholds, commands (Stage 4 / Task 3) | [SOURCE_SCORECARDS.md](SOURCE_SCORECARDS.md) |
| Pattern library and calibrated confidence: features, levels, metrics, uncertainty, caps, commands (Stage 4 / Task 4) | [PATTERN_LIBRARY_AND_CONFIDENCE.md](PATTERN_LIBRARY_AND_CONFIDENCE.md) |
| Source intelligence in the live risk flow: service contract, sizing, approval eligibility, failure behaviour (Stage 4 / Task 5) | [SOURCE_INTELLIGENCE_INTEGRATION.md](SOURCE_INTELLIGENCE_INTEGRATION.md) |
| Risk decision API, approval cards, approval persistence and security boundaries (Stage 3 / Task 6) | [RISK_APPROVAL_WORKFLOW.md](RISK_APPROVAL_WORKFLOW.md) |
| Market, liquidity and event-risk gates: sessions, expiry, blackouts, thresholds, outcomes (Stage 3 / Task 5) | [MARKET_RISK_GATES.md](MARKET_RISK_GATES.md) |
| Risk-decision expiry and loss circuit breakers, loss accounting, enforcement, alerts, operations (Stage 3 / Task 4) | [CIRCUIT_BREAKERS.md](CIRCUIT_BREAKERS.md) |
| Portfolio open-risk and correlation limits, exposure model, outcomes, examples (Stage 3 / Task 3) | [PORTFOLIO_RISK_LIMITS.md](PORTFOLIO_RISK_LIMITS.md) |
| Position sizing formulas, tiers, defaults, statuses, examples (Stage 3 / Task 2) | [POSITION_SIZING.md](POSITION_SIZING.md) |
| Risk decision schema, immutability, lifecycle, orders guard, extension points (Stage 3 / Task 1) | [RISK_DECISIONS.md](RISK_DECISIONS.md) |
| Operational alerting, severity policy, payload contract, scheduled verification, status surface, dead-letter operations (Stage 2 / Task 5) | [OPERATIONAL_ALERTING.md](OPERATIONAL_ALERTING.md) |
| Staging redeployment of Stage 1/2, image provenance, runtime verification, rollback (Stage 2 / Task 4) | [STAGING_DEPLOYMENT_VERIFICATION.md](STAGING_DEPLOYMENT_VERIFICATION.md) |
| Off-host encrypted backup, key custody, retention, restore drill, runbook, evidence classes (Stage 2 / Task 3) | [OFF_HOST_BACKUP_AND_RECOVERY.md](OFF_HOST_BACKUP_AND_RECOVERY.md) |
| Durable Telegram intake outbox: flow, statuses, retry, reconciliation, idempotency, failure behaviour (Stage 2 / Task 2) | [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md) |
| Hosted CI workflow, required checks, failure guide, branch-protection policy (Stage 2 / Task 1) | [CI.md](CI.md) |
| Mandatory stop-loss rule, reason codes, options rules, evidence, enforcement layers (Stage 1 / Task 4) | [MANDATORY_STOP_LOSS.md](MANDATORY_STOP_LOSS.md) |
| Phase order, dependencies, gates | [roadmap/](roadmap/MASTER_ROADMAP.md) |
| Per-phase plan, trackers and handoff | [phases/](phases/) |
| Audit evidence and method | [audit/](audit/00_AUDIT_SCOPE_AND_METHOD.md) |

## Three kinds of state (kept separate)
1. **Product-baseline state** - is the architecture known and reconciled? (STATUS.md)
2. **Phase implementation state** - `NOT_STARTED / IN_PROGRESS / BLOCKED / READY_FOR_REVIEW / APPROVED_COMPLETE`. Only the user authorizes changes.
3. **Release readiness** - gates G0-G9 in [roadmap/RELEASE_GATES.md](roadmap/RELEASE_GATES.md). Receiving the architecture does not pass any gate.

## Vocabulary
Requirement status: `VERIFIED_IMPLEMENTED`, `PARTIAL`, `MISSING`, `UNVERIFIED`, `BLOCKED`, `NOT_APPLICABLE`. Tests (separate): `PASS` / `FAIL` / `NOT_RUN`. Design material is labelled `PROPOSED DESIGN`; unresolved choices are `owner decision required` (D-ids in the decision log).

## Untracked local sources (not part of the repository)
- `TWINS_Planning_Pack/` is an **untracked local directory** (an earlier proposal dated 2026-10-19). It is **not available in the repository**, is excluded from the documentation commit candidate, and no requirement or task in these documents depends on reading it. Where its text was needed it is quoted in place (D-016, SZ-06, F-015) and marked as quoted from that local source. Its remaining content has not been inventoried (task T00.6, decision D-002a); these documents make no claim about it.
- The presence checks mentioned in these documents (for example that every requirement ID maps to an architecture element) were run by the assistant with **tooling that is not in this repository**. They are historical assistant-produced evidence, not independent verification, and the repository cannot reproduce them. No tooling or executable code is added by this documentation.

## Runtime figures are dated historical evidence
Any runtime figure in these documents (aggregate row/event counts, migration count, image tags) is a **dated historical audit observation** (staging, read-only, 2026-10-24T21:15:29Z). It is **not current runtime status**, may have changed, and carries the uncertainty stated where it appears. Only aggregate counts and image tags are recorded; no credentials, private identifiers or other operational details are included. Safety posture is stated as owner decisions (for example D-001, D-018), not as runtime status.

## Limits
- Earlier reports (for example `docs/implementation/ROADMAP_AND_AUDIT_2026-10-22.md`) are historical evidence, not proof of current readiness.
- Nothing here is a compliance conclusion; external-terms and regulatory items are work to be reviewed.
- Documentation tracking policy is proposed (D-002); nothing has been committed.
