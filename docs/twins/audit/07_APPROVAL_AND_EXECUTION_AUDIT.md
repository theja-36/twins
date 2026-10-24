# 07 Approval and execution audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Approval bot (services/approval-bot) - verified facts
- Gates on every callback: approver id, private chat, bot-sender refusal, message-id match, HMAC over card+action+nonce (`bot.ts:167`, `callback.ts`). Weakening each of four gates was mutation-tested (tests failed each time).
- Single-use decision in one transaction conditioned on `state='sent'`, not expired and matching message id (`db.ts:211`); append-only review and event tables (migration 0008 triggers); restricted role `twins_bot` verified on real PostgreSQL (`tests/integration/approvalBot/rolePrivileges.test.ts`).
- Cards show parsed fields only; control characters stripped; 4 h expiry; rate caps; fail-closed egress canary; fatal hold of 15 minutes.
- Dated observation (2026-10-24, historical): TEST-card handshake events recorded (1 `handshake_card_sent`, 1 `test_decision`; no claim reviewed). Bot activation stays a separate owner action (D-018).

## Gaps against the baseline
No proposal object, lots, order constraints, risk, management policy or proposal version; no version binding; no cancellation flow; no pre-flight gateway; the claim-card `decide()` SQL has not run on real PostgreSQL with a real claim (AP-02..AP-06, F-011).

## Execution and management
- Guards: `LIVE_TRADING` must be literal "true" and requires `TRADING_MODE=live` (`packages/config/src/index.ts:31-46`); worker and scheduler exit if true; compose literal false.
- Contracts only: `BrokerProvider` and `ExecutionProvider` are separate interfaces (`adapters/broker/src/index.ts`); no implementation.
- Schema only: `orders` (status enum pending..rejected; unique `idempotency_key`), `fills`, `positions` - unused; no `unknown/needs-reconciliation` state, no protection-order concept.
- No reconciliation, kill switch, emergency modes (only a specification mention at docs/SPECIFICATION.md:791), no exit/charge accounting.

## Broker facts not to assume
Supported order types, protection (stop/target) behaviour, partial-fill semantics, rate limits, static-IP/registration requirements and API terms are unknown until a broker is chosen and probed (EX-04, Q-010).
