# F1 independent security review: engine packet (PREPARED, NOT REVIEWED, NOT CERTIFIED)

> Prepared 2026-11-05 for an independent reviewer. **The reviewer is unassigned (Q-012, D-036). This packet is not a review result and nothing in it certifies F1.** It extends the standing package `docs/implementation/review/F1_REVIEW_PACKAGE.md` with the code that matters before the engine may run on real data.

## 1. Reviewer profile (D-036)
Independent of the implementation; Node.js/TypeScript backend; authentication, webhook/input handling, cryptography use, secret handling; PostgreSQL connection/transaction lifecycle and shutdown behaviour; fail-closed decision guards.

## 2. Scope, in priority order
| # | Area | Files | Question to answer |
|---|---|---|---|
| 1 | Shadow isolation | `packages/agents/src/record.ts` (`runAgentEngineShadow`), `services/worker/src/index.ts` (`agentShadowFor`, hook in `recordPendingRiskDecision`) | Can shadow mode write, halt, throw into, or slow the live flow? Is the kill-switch/intake check sufficient? Is a timeout bound needed on the whole evaluation? |
| 2 | Configuration exclusivity | `packages/agents/src/config.ts` | Can shadow and enforcing ever both be active? Are malformed values fail-closed? |
| 3 | Enforcing hook and synthesis | `record.ts` (`runAgentEngine`), `synthesis.ts`, `orchestrator.ts` | Does any path grant approval or bypass a later gate? Idempotency key coverage; concurrency. |
| 4 | Approval re-check | `packages/risk/src/approval/researchEligibility.ts`, migration 0027 (DB function) | Is the research assessment re-checked at approval time, in the DB as well as the app? |
| 5 | Inputs and privacy | `record.ts` (`buildDecisionInputs`, `buildSignalContext`), `sanitize.ts`, `observability.ts` | Is message text excluded everywhere? Are logs/alerts allow-listed? |
| 6 | Kite read-only boundary | `packages/kite/src/*` (allowlist, client, token store), `scripts/ops/kite-login.ts`, `kite-ticker.ts` | Can any order/GTT/portfolio-write path be sent? Token handling (0600, never logged); the one POST. |
| 7 | Egress and host | `infrastructure/staging/twins-kite-egress.sh`, compose services `kite-login`, `kite-ticker` | Is the allow-list fail-closed; are the containers least-privilege? |
| 8 | Database privileges | migrations 0028, 0029, `app-role.sql` | `twins_app`/`twins_bot` cannot write orders/fills/positions. |

## 3. Known risks and limitations (stated, not hidden)
* A buggy agent can consume CPU until its timeout (no process isolation, HB-07); shadow mode runs agents in the worker process, so a slow agent can delay a job (bounded by per-agent timeouts, default concurrency 4).
* Agent code changes without a version bump are not detected (HB-08).
* HB-05 (challenger depends on all agents) is open: INCOMPLETE is common until all snapshots exist.
* Kite packet layouts are taken from published client libraries and verified against live data only by two bounded runs on 2026-11-05 (0 rejected packets in the second run, 14,236 accepted ticks); the first run showed a decoder bug (D-092). Which layouts were exercised per instrument kind was not recorded and is not independently verified against exchange documentation.
* The previous-close OHLC check bug (D-092) shows live data can contradict assumptions; reviewer may want a property test over real captured frames (not stored; counts only).
* Shadow output lives only in the journal (7 days).

## 4. Evidence available
CI (7 jobs, `ci-gate`) green on every merge; 3,086 unit and the integration suite incl. `agentEngine.test.ts` shadow cases; `STAGE5_CLOSING_REVIEW.md`, `STAGE5_CLOSURE_PROOF.md`; `KITE_EGRESS_ALLOWLIST_DESIGN.md` section 8 (acceptance results); deploy reports in `deployments.jsonl`; decision log D-066..D-093.

## 5. Out of scope
Stage 6 / order paths (none exist), model use (none), the Telegram capture client's own host.

## 6. Deliverable expected from the reviewer
Findings by severity with file/line, a pass/conditional/fail statement per scope row, and any additional tests required. The owner records the outcome in the decision log; the assistant records nothing as passed.
