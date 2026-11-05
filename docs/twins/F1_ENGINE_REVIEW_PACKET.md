# F1 independent security review: engine packet (PREPARED, NOT REVIEWED, NOT CERTIFIED)

> Prepared 2026-11-05; handoff version 2026-11-05 (after Deploy 7). **This packet is not a review result and nothing in it certifies F1.** Reviewer assigned by the owner on 2026-11-05: **theja** (Q-012). Independence note: the reviewer did not write the code under review (it was written by the AI assistant); the owner records whether that satisfies D-036. The assistant records nothing as passed.

## 0. Read this first
**What is being reviewed.** TWINS is a Telegram-signal intake and risk pipeline for an Indian-market trading assistant. It has **no order path**: `LIVE_TRADING=false`, `TRADING_ENABLED=false`, and no broker order code exists. A "research engine" of twelve deterministic agents scores each risk decision; a Kite Connect read-only market-data feed supplies snapshots. The engine is **disabled** and a new **shadow mode** (evaluate and log only) exists but is **off**. The review decides whether the engine may later run on real data (shadow first, enforcing much later).

**Exact code state.** Repository `github.com/theja-36/twins` (private), branch `main`, commit **`9ae70bb7f72b9565aba283922307decfcee8d2a6`** - this is the code deployed to staging as image `main-9ae70bb7` (Deploy 7). Review that commit (`git checkout 9ae70bb7`). Staging host facts, not the repo, are listed in section 7.

**How to get it running (read-only review needs none of this, tests are optional).**
```
git clone https://github.com/theja-36/twins && cd twins && git checkout 9ae70bb7
npm ci                      # Node 22 (.nvmrc)
npm run lint && npm run typecheck && npm test        # 157 unit files, ~3,090 tests, no database
# integration (needs PostgreSQL 16 + Redis 7 on loopback, synthetic data only; see tests/integration/targetConfig.ts):
#   TWINS_CI=1 NODE_ENV=test LIVE_TRADING=false DATABASE_URL=postgresql://twins_ci:<pw>@127.0.0.1:5432/twins_ci REDIS_URL=redis://127.0.0.1:6379
#   npm run db:migrate -w @twins/database && node scripts/ci/verify-migrations.mjs && npm run test:integration
```
Hosted CI (GitHub Actions, 7 jobs + `ci-gate`) is green on this commit. Known: 3 integration tests failed on one reviewer-side-style stale local database but pass on a fresh one (backlog HB-26, not engine-related).

**Glossary.** *Risk decision*: a versioned DB row for one parsed signal. *Agent*: a pure function returning a verdict (SUPPORTIVE..BLOCKING), confidence, finding codes. *Assessment*: the weighted synthesis (SUPPORTIVE/NEUTRAL/CAUTION/ADVERSE/BLOCKED/INCOMPLETE). *Halt*: enforcing mode stops the flow before sizing when the assessment is in `haltOn`. *Shadow*: same evaluation, logged only. *Snapshot generation*: the set of JSON files the Kite feed publishes atomically.

**Security properties the owner needs confirmed** (the review's questions, in plain terms): (a) nothing in the engine or feed can place or modify an order; (b) shadow mode cannot affect the live flow; (c) enforcing mode cannot grant approval or bypass a later gate; (d) no message text, credential or token reaches logs, alerts, snapshots or agent inputs; (e) failures fail closed where they must and are contained where they must.

## 1. Reviewer profile (D-036)
Independent of the implementation; Node.js/TypeScript backend; authentication, webhook/input handling, cryptography use, secret handling; PostgreSQL connection/transaction lifecycle and shutdown behaviour; fail-closed decision guards.

## 2. Scope, in priority order (line numbers are at commit 9ae70bb)
Key anchors: shadow `packages/agents/src/record.ts:180`; enforcing `record.ts:97`; inputs builder `record.ts:32`; worker shadow hook `services/worker/src/index.ts:376` (helper) and `:422` (call site, try/catch); exclusivity `packages/agents/src/config.ts:57`; engine alert rules `packages/alerting/src/rules.ts:34`; orchestrator `orchestrator.ts:43`; synthesis `synthesis.ts:89`; Kite allowlist `packages/kite/src/allowlist.ts:36`.

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

## 7. Facts about the deployed staging system (not in the repo)
* Host: one VPS, Docker Compose project `twins-staging`; services api, worker, alert-relay, capture, postgres, redis on the app image; Kite services (`kite-login`, `kite-ticker`) exist but are **not running** except in bounded supervised runs (two on 2026-11-05).
* Flags on staging: `TWINS_AGENT_ENGINE_ENABLED` and `TWINS_AGENT_ENGINE_SHADOW` are unset; `LIVE_TRADING=false`; system controls `TRADING_ENABLED=f`, `KILL_SWITCH_ACTIVE=f`, `INTAKE_ENABLED=t`.
* Egress: a host firewall allow-list limits the Kite container network to `api.kite.trade` and `ws.kite.trade` on 443 (design + acceptance: `docs/twins/KITE_EGRESS_ALLOWLIST_DESIGN.md` sections 7-8).
* Database roles: `twins_app` and `twins_bot` have no INSERT on `orders`, `fills`, `positions` (migration 0029); verified after each deploy.
* Deploy evidence: `docs/twins/STAGING_DEPLOY_PLAN.md` sections 11-15, `docs/twins/DECISION_LOG.md` D-077..D-094.
* The reviewer is **not** given host access, credentials, the Kite API key/secret or the token. Everything needed is in the repository; if live behaviour must be demonstrated, the owner runs the command and shares counts only.

## 8. How to report (template)
For each row of section 2: **Result** (pass / conditional / fail / not reviewed), **Findings** (severity critical-high-medium-low-info; file:line; what, why it matters, suggested fix), **Tests requested**. Then an overall statement and any conditions before shadow mode and before enforcing mode (these are separate gates). Send the report to the owner; the owner records it in the decision log. The assistant will not edit or pre-answer it.

## 9. Related documents
`docs/twins/ENGINE_SHADOW_MODE.md` (design + activation), `docs/twins/Q009_PRIVACY_PROPOSAL.md` (approved pending this review), `docs/twins/AGENT_ENGINE.md` (engine reference), `docs/twins/STAGE5_CLOSING_REVIEW.md`, `docs/twins/KITE_INTEGRATION.md`, `docs/implementation/review/F1_REVIEW_PACKAGE.md` (standing F1 package, 2026-10-24 refresh).
