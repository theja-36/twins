# Risk decision API and approval workflow - Stage 3 / Task 6

> **Stage 4 / Task 5:** approval eligibility additionally requires valid source intelligence (`source_intelligence_not_valid`; also enforced inside `twins_record_risk_approval`, migration 0024) - see [SOURCE_INTELLIGENCE_INTEGRATION.md](SOURCE_INTELLIGENCE_INTEGRATION.md).

> Decision [D-060](DECISION_LOG.md); requirement [SZ-17](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [RISK_DECISIONS.md](RISK_DECISIONS.md), [POSITION_SIZING.md](POSITION_SIZING.md), [PORTFOLIO_RISK_LIMITS.md](PORTFOLIO_RISK_LIMITS.md), [CIRCUIT_BREAKERS.md](CIRCUIT_BREAKERS.md), [MARKET_RISK_GATES.md](MARKET_RISK_GATES.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/risk/src/approval/`, `apps/api/src/riskApi.ts`, `services/approval-bot/` (risk-card path), migration `0019_risk_approvals`, role scripts in `infrastructure/staging/`.

**An approval records a human decision about ONE decision version. It creates no order, fill, position or broker call, and enables nothing.** `LIVE_TRADING` stays false, `TWINS_BOT_ACTIVE` stays false in the repository, no real Telegram signal channel is connected, and no external call is made by this code (the bot's only network client remains its Bot API client).

## 1. Eligibility - when a decision may be presented, and approved
All must hold **at that moment** (`assessApprovalEligibility`, read-only, with fixed reason codes):
| Condition | Reason when unmet |
|---|---|
| it is the current, un-superseded version | `decision_superseded` |
| status `APPROVED_FOR_REVIEW` (so sized + portfolio-passed + market-passed, enforced by the 0015/0016/0018 database checks) | `decision_not_approved_for_review` |
| inside its validity window (version creation + 15 min, `TWINS_RISK_EXPIRY_APPROVED_MINUTES`) | `decision_expired` |
| the latest stop-loss validation is the cited one and `VALID` | `stop_loss_not_valid` |
| sizing succeeded / portfolio passed / market gates passed (re-read from the stored evaluations) | `sizing_missing` / `portfolio_not_passed` / `market_not_passed` |
| no open loss circuit breaker | `circuit_breaker_open` (`breaker_state_unavailable` if unreadable) |
| kill switch off, runtime state readable | `kill_switch_active` / `state_unavailable` |
**Never from stale state:** the same rules are enforced again **inside the database at the instant an approval is recorded** (`twins_record_risk_approval`), so a card shown earlier cannot approve a decision that has since expired, been superseded, lost its valid stop-loss, or met a breaker / kill switch. If a condition changes the card is expired, never approved.

## 2. The approval card (contract)
Created by `createApprovalCard` (application role) only for an eligible decision, idempotent per decision version; rendered **plain text** (no markup is interpreted) from the decision's structured fields and stored evaluations, with its SHA-256; it expires with the decision. Contents: market; instrument (symbol, expiry, strike, option type); side; entry / premium; stop-loss and basis; targets; planned quantity and notional; planned maximum loss (amount and % of capital); risk-reward; confidence tier and score; source-trust tier; portfolio planned risk before → after and active count; correlation-group exposure before → after and same-underlying after; market-session status; liquidity / spread / data-age summary; event-blackout status; daily / weekly breaker status; validity time; up to eight **key risks** derived from the numbers (stop distance and gap risk, option premium risk, expiry, WARNING window, session, spread, concentration, LOW tiers, validity); short **evidence references** (decision, stop-loss validation, previous version, portfolio and market input hashes); and the statement *"This is a risk-reviewed proposal, not investment advice. Approving only records your decision; no order is placed and nothing is traded."*
**Never shown:** the Telegram message text, channel identifiers, credentials, tokens, keys, idempotency keys or snapshots - none of them reach the card (every free-form value is replaced by `[withheld]` unless it is a short plain token). Tested with a hostile fixture.

## 3. Lifecycle
`risk_approval_cards`: `pending` → `sent` → `decided` | `expired` (forward only, content immutable, never deleted; trigger-enforced).
1. API / service creates the card (`pending`). 2. The approval bot (only while active; kill switch off) delivers the stored text with **Approve (record only)** and **Reject** buttons, bound to the card nonce by HMAC and to the Telegram message id; `twins_risk_card_mark_sent` → `sent`. 3. The approver taps; the bot checks approver / chat / HMAC / message, refuses an approval under the kill switch or unreadable state without touching the database, and calls `twins_record_risk_approval`. 4. The function records the approval and marks the card `decided`, or refuses (`refused:<reason>`) and marks the card `expired`; the bot tells the approver nothing was approved and edits the message. 5. Unanswered cards are expired by `twins_risk_card_expire_due` when their validity passes (message edited to "expired"). A **REJECT is risk-reducing**: it is recorded even under the kill switch or for a decision that is no longer current.
**Duplicate handling:** one approval record per decision version (unique); a second tap, or a conflicting second action, reports `duplicate` and records nothing. **A changed decision (new version) is a different row and needs its own card and approval.**

## 4. Persistence - `risk_approvals` (the eleventh audit chain)
Append-only and hash-chained (UPDATE / DELETE / TRUNCATE rejected, also under replica role). Columns: approval id, risk decision id, **decision version**, card id, **action** (`APPROVE` / `REJECT`), **actor** (`telegram:<id>` / `operator:<name>`), actor context (card message id, update id, channel of entry), **reason** (mandatory for REJECT, ≤ 500), **decision snapshot** (the decision's fields and stored gate evaluations at that instant), **evidence references**, validity, card text hash, created-at. The table guard refuses a wrong version and an APPROVE of a decision that is not a current `APPROVED_FOR_REVIEW`, or while a breaker is open - for any inserter. **The future execution extension point:** the orders trigger now also requires a recorded `APPROVE` for the order's decision (no order path exists).

## 4b. Who can write what (security boundaries)
* **Only `twins_record_risk_approval` writes `risk_approvals`** (SECURITY DEFINER, fixed `search_path`, `REVOKE ... FROM PUBLIC`). Neither the runtime role nor the bot has INSERT on it; the runtime role is granted SELECT only.
* **Bot role (`twins_bot`):** SELECT on `risk_approval_cards` (the text is already rendered, so it never reads a decision); EXECUTE on exactly three functions (`mark_sent`, `expire_due`, `record_risk_approval`). No privilege on `risk_decisions`, `risk_approvals`, any audit/chain table, `orders`, `fills`, `positions`, raw message text or controls (read-only values as before). Its startup self-check fails closed if it can write the cards or lacks a door.
* **Runtime role (`twins_app`):** INSERT-only on `risk_approval_cards` (creates cards), SELECT on approvals, EXECUTE on the approval function for the API path.
* **API:** six internal routes, **all bearer-protected** (`TWINS_API_KEY`, same as the other protected routes; none unauthenticated): `GET /risk/decisions/:id/approval-eligibility`, `GET /risk/decisions/:id/summary`, `GET /risk/decisions?limit&status`, `GET /risk/approvals?limit`, `POST /risk/decisions/:id/approval-card`, `POST /risk/decisions/:id/approval` (`{action, actor: "operator:<name>", reason?}`). Responses are safe read models: no snapshots, idempotency keys or raw inputs; the approver's identity is masked (`***1234`); errors are fixed codes. The operator identity is self-declared (like the other operations paths); the bearer token is the authorization.

## 5. Safety integration
Runtime state is evaluated first for card creation and for an APPROVE (fail closed: unreadable ⇒ refused); circuit breakers and the kill switch are checked in the assessment and again in the database; the approval path never reads `LIVE_TRADING`, never touches a control and cannot lift a breaker. No order / fill / position / broker call / approval of the legacy `claim_review_cards` is written (tested by row counts and source scans).

## 6. Limits and remaining risks
* **Nothing reaches `APPROVED_FOR_REVIEW` on real data** (no market-data provider, Task 5), so in practice no card is created outside tests/drills.
* The bot is not activated and no approver chat is used here; the bot paths are covered with synthetic fakes and the real database functions, not by a live Telegram round trip.
* The operator API identity is self-declared; two-person approval, per-user authorization and rate limits are not modelled.
* A card of a decision that was superseded stays `sent` until it expires or is tapped (the tap is then refused and the card expired); no job proactively edits such a message.
* Approval validity equals the decision's 15-minute window; a short window for a human to react is a policy to confirm.
