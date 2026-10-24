# P09 - Candidates, proposals, approval binding and pre-flight

- **State:** NOT_STARTED
- **Depends on:** P03, P06, P07
- **Primary requirements:** LC-02, LC-03, LC-04, AP-01, AP-02, AP-03, AP-04, AP-05, AP-06, SC-01
- **Also checked here (cross-phase dependencies/acceptance):** CL-04, CS-01, CS-02, CS-03, EX-02, EX-09, GV-01, LC-01, MA-01, OP-01, PL-02, RE-08, SV-06, SY-03, SZ-11, TG-08
- **Findings (primary owner):** F-011
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Turn qualified candidates into versioned, risk-sized proposals; bind human approval to the exact proposal version; and pass every proposal through a fresh pre-flight gateway before any order intent can exist.

Scope:
- 9A Telegram-origin candidates (needs no strategies): candidate -> proposal with lots from P06.
- 9B Scanner generating candidates only from `eligible` strategy versions (needs P08).
- Proposal contract and versioning; material change invalidates approval.
- Approval bot extension: cards from proposal versions, cancellation, stale handling.
- Pre-flight gateway: fresh price, data, funds, exposure, market state; tolerances from approved policy; approval cannot bypass failure.
- No-trade records; provider rejection does not trigger alternatives.

## 2. Explicit non-goals
- No order submission to any venue (that begins in P10 paper, P12 live).
- Bot activation remains a separate owner action.

## 3. Required inputs and entry gates
- P06 verified, P07 approved.
- Q-020, Q-021, Q-024 ANSWERED (D-027, D-028, D-032). Q-028 defined (D-035) but its components (D-011 management policy, D-021 emergency-position policy) are UNRESOLVED, so no open-position automation can be activated.
- D-010 (pre-flight tolerances) UNRESOLVED: no numerical tolerance is selected anywhere (D-032 selects none).
- 9B additionally requires P08 eligible strategies. Alternative search (T09.6) stays DISABLED: activation is explicitly DEFERRED (D-034) until Q-002 and D-023 define and authorize its market, instrument, strategy and budget scope.

## 4. Existing reusable components and evidence
- `services/approval-bot/*` - gates, HMAC callbacks, single-use decide, expiry, restricted role
- `migration 0008 tables` - extend or add proposal-bound review tables

## 5. Subphases (independently testable)
- **9A** Telegram-origin proposals
- **9B** Scanner (strategy-driven)
- **9C** Approval binding and cancellation
- **9D** Pre-flight gateway

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T09.1 | proposals + proposal_versions tables; builder using P06 sizing; no_trade records. | packages/risk, packages/database/ | - |
| T09.2 | Approval bot: card generator from a proposal version; version-bound HMAC; re-approval on change; cancel. | services/approval-bot/src | T09.1 |
| T09.3 | Pre-flight gateway service/library with injected clocks and data providers. | packages/risk, services/ | T09.1 |
| T09.4 | Scanner enforcing strategy eligibility. | services/scheduler or new services/scanner | T09.1 |
| T09.5 | claim-card decide() integration test on real PostgreSQL (closes AP-03 gap). | tests/integration/approvalBot/ | - |
| T09.6 | Alternative search (Agent 13): disabled by default; permission and scope check after Q-002 and D-023; bounded search; no-opportunity -> no_trade; found alternative -> new TWINS_GENERATED case through the full research chain with no lower bar. Implementation does not enable it. | services/scheduler or services/scanner, packages/decision-intelligence | T09.1 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Proposal(version, instrument_id, side, lots, order_constraints, planned_risk, stressed_loss, management_policy_id, expires_at, state). Approval(proposal_version_id, approver, nonce, used_at). Transitions: draft -> sized -> proposed -> approved|rejected|expired|cancelled -> preflight_passed|preflight_failed. Approval is single-use and version-bound. Mandate v1 (D-027): one resolved contract, fixed approved quantity, entry trigger/range, management-policy version, mandate expiry; no scale-in, quantity increase or re-entry; bounded dynamic exits and protective-stop adjustments only within the approved management policy; any partial-exit permission explicit and lot-feasible. Source-change handling (D-028): reliably linked cancel/material revision before entry invalidates the mandate (replacement = fresh recommendation + fresh approval); outstanding entry order cancelled where applicable with fills reconciled; after entry the source is evidence only; ambiguous linking stays unresolved. Material changes (D-032): resolved contract/expiry and side; approved quantity; entry trigger or permitted range; risk allowance; management-policy version or permissions; mandate expiry extension; reliably linked source cancellation or material revision. Not material: ordinary market movement inside the entry constraints; actions the approved management policy explicitly permits (bounded stop tightening, activating an approved continuation objective). A price-range breach blocks entry and never authorizes chasing or range expansion. No numerical tolerance is selected.

## 8. External dependencies and permissions
- Telegram Bot API (existing bot); activation is an owner action.

## 9. Tests
- **Unit:** Builder and card fixtures; HMAC binds version.
- **Integration:** Real-PostgreSQL decide() and gateway tests.
- **End-to-end:** Candidate -> proposal -> test card -> approval -> pre-flight (fake data) -> order intent record only.
- **Failure-path:** Change after approval invalidates it.; Approved + failed pre-flight -> no intent.; Replay/double-tap -> one decision.; Stale card -> refused.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-09.1 Every field listed in AP-02 appears on the card from stored data.
- A-09.3 Approval + failed pre-flight yields no order intent (test per check: prices, mandate validity, current risk, source changes after approval, connectivity, duplicates).
- A-09.4 Scanner refuses non-eligible strategy versions.
- A-09.5 A rejected candidate produces `no_trade` and no substitute.
- A-09.7 Source-change fixtures (SC-01): cancel before entry, material revision before entry, cancel after partial fill, 'exit now' after entry (alert only), ambiguous link (unresolved) - each behaves as D-028 specifies.
- A-09.8 Mandate v1 is enforced: scale-in, quantity increase and re-entry are rejected (EX-09).
- A-09.2 Changes to each D-032 mandate-bound field invalidate the card and approval (one test per field); movement inside the approved entry constraints does not; explicitly permitted management actions need no fresh approval; a change outside the mandate needs a new eligible recommendation and fresh approval.
- A-09.6 Alternative search cannot run while disabled; enabling requires an explicit scope record (market, instrument, strategy, budget) after Q-002 and D-023; a rejected source candidate with no permitted search yields no_trade; a found alternative has its own case id, TWINS_GENERATED origin and the full evidence chain.
- A-09.9 A price-range breach blocks entry and never expands the range or chases (D-032).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Test logs; sample cards; gateway truth table.

## 12. Rollback / recovery approach
Bot stays off; proposal tables additive; gateway not connected to any execution adapter yet.

## 13. Exit gate and handoff
User approves the approval-to-intent chain; no execution implied.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
