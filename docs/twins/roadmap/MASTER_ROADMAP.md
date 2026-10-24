# Master roadmap

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

All phases are `NOT_STARTED`. No time estimates are given (none can be supported by evidence). Only the user authorizes advancement. Each phase has PLAN, TASKS, ACCEPTANCE, TEST_EVIDENCE and HANDOFF files.

| Phase | Title | Depends on | Primary requirements | Notes |
|---|---|---|---|---|
| [P00](../phases/00-baseline-and-governance/PLAN.md) | Baseline, governance and open decisions | - | 3 | Process blockers; no code. |
| [P01](../phases/01-operations-foundation/PLAN.md) | Operations foundation: provenance, monitoring, backups, CI | P00 | 6 | Safety/ops foundation; can run in parallel with P02/P04/P06. |
| [P02](../phases/02-telegram-intake-completeness/PLAN.md) | Telegram intake completeness, classification and source health | P00 | 15 | Completes intake; parser baseline needs owner labels. |
| [P03](../phases/03-signal-library-and-identity/PLAN.md) | Signal library, case identity and claim versions (T6) | P00 | 7 | Needs T6 owner decisions. |
| [P04](../phases/04-instruments-and-market-data/PLAN.md) | Instruments and market data | P00 | 9 | Externally blocked on vendor/entitlement decision. |
| [P05](../phases/05-outcome-conventions-and-case-reconstruction/PLAN.md) | Outcome conventions and case reconstruction | P03, P04 | 6 | Needs conventions BEFORE code. |
| [P06](../phases/06-risk-policy-and-sizing-core/PLAN.md) | Risk engine scaffolding, production-budget gating and emergency controls | P00 | 13 | Scaffolding (6A) needs no budgets; production stays fail-closed until D-007 is supplied. |
| [P07](../phases/07-decision-states-and-research-engine/PLAN.md) | Eligibility states, case orchestration and research engine | P03, P04, P06 | 28 | Largest phase: 7A-7D deterministic; 7E model-based part optional and never blocks. |
| [P08](../phases/08-strategy-research-and-validation/PLAN.md) | Strategy research and validation | P05, P07 | 11 | Strategy-driven scanning needs this; the paper pipeline does not. |
| [P09](../phases/09-candidates-proposals-and-approval/PLAN.md) | Candidates, proposals, approval binding and pre-flight | P03, P06, P07 | 10 | 9A (Telegram-origin) needs no strategies; 9B needs P08. |
| [P10](../phases/10-paper-execution-and-reconciliation/PLAN.md) | Paper execution, order lifecycle and reconciliation | P06, P09 | 10 | Paper only; simulated fills are not live evidence. |
| [P11](../phases/11-outcome-learning-and-governance/PLAN.md) | Outcome learning and governance | P08, P10 | 8 | Governance; cannot change risk or promote strategies. |
| [P12](../phases/12-broker-integration-and-controlled-live/PLAN.md) | Broker integration and controlled live | P10, P01, P00 | 1 | Every step separately approved; LIVE_TRADING stays false until then. |

## Development order vs runtime workflow
- **Development order** is by dependency and safety: process blockers (P00) -> operations and durability (P01) and deterministic risk (P06) early, because everything dangerous depends on them -> intake completeness (P02) -> library (P03) -> data (P04) -> outcomes (P05) -> decision states (P07) -> strategies (P08) -> proposals/approval (P09) -> paper execution (P10) -> learning governance (P11) -> broker/live (P12).
- **Runtime workflow** (what happens to one signal): intake -> library -> instrument/data verification -> research decision -> sizing -> proposal -> human approval -> pre-flight -> execution -> management -> outcome -> learning.
- Consequences: an isolated paper pipeline (P06, P09A, P10) does **not** wait for historical learning (P05, P08); strategy-driven scanning (P09B) **does** wait for eligible strategy versions; optional AI work (P07C) never blocks deterministic safety work.

## Reuse (do not rebuild)
Capture client and allowlist (TG-01), raw store/revisions/events (TG-03/04/07), options parser and claim store (TG-10, CR-03), data-quality rules (MD-04), as-of context (CR-06), deterministic validation engine (RE), approval bot gates/role/HMAC/expiry (AP-01/03), backup/restore scripts, firewall units, CI workflow, LIVE_TRADING guards.

## First implementation slice (recommendation, not started, NOT authorized)
Nothing starts without a later, separately scoped authorization; **P01 and P06 have not begun**, and local implementation is not authorized by any documentation decision (D-031 interim boundary).
1. **Documentation closure (P00, no code):** the remaining P00 items are the F1 reviewer assignment (A-00.3, BLOCKED) and the owner's exit authorization; D-031 stays unresolved.
2. **Candidate first code slices (unchanged, not authorized):**
   - **P06 subphase 6A (risk-engine scaffolding):** needs no budgets or vendors; production stays fail-closed; directly mitigates the Critical findings.
   - **P01 subphase 1E (durable intake):** design direction D-014a decided; implementation review and failure-test evidence still required. Its companion items are partly blocked by explicit deferrals: off-host backup (1C) by Q-007 / D-040, alert activation (1B) by Q-018 / D-042, retention/pruning by Q-017 / D-041.
Acceptance for any slice is in the phase ACCEPTANCE trackers (A-06.1..A-06.10; A-01.5..A-01.9).

## Decisions/permissions required before the first slice
For 6A: an explicit, separately scoped authorization only (no budgets needed). For 1E: the same plus D-014a implementation review; thresholds, grace period and alert destination stay unconfigured (D-030a, D-042). 1C and alert activation stay blocked by D-040 and D-042. For any commit: D-002 pre-commit review and a separate approval of the exact action.
