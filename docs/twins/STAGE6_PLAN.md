# Stage 6 plan - activation readiness and the proposal-bound approval path (no orders)

> Written 2026-10-30. A **proposal for the owner**; nothing in it is authorized or started (D-075). It follows the project's dependency order ([roadmap/MASTER_ROADMAP.md](roadmap/MASTER_ROADMAP.md), [roadmap/RELEASE_GATES.md](roadmap/RELEASE_GATES.md)): Stage 5 produced the research engine (gate G5 evidence in part); Stage 6 makes it **safe to run** and binds a human approval to an exact, immutable proposal (gate G6 - "Approval path (no orders)"). Paper trading (G7), the broker (G8) and anything live (G9) are later stages and **stay disabled**.

## 1. What Stage 6 should build
1. **Hardening that must precede activation:** the P0 and the activation-relevant P1 items of [HARDENING_BACKLOG.md](HARDENING_BACKLOG.md).
2. **Activation machinery for the research engine:** shadow mode, snapshot validation at start-up, provider/snapshot unification, alert routing (code only, inactive until the destination is approved).
3. **A proposal object and proposal-bound approval:** a trade *proposal* (levels, size, expiry, assessment run, snapshot hashes) with a hash; an approval that binds to that hash and is invalidated by revision, staleness or a newer assessment. Output is a reviewed, recorded approval - **not an order**.
4. **A deterministic pre-flight check** on the proposal (data freshness, instrument status, levels, size, limits) that produces a pass / fail record; it calls nothing external.
5. **A rehearsal and evidence package** for the owner: a staging rehearsal with synthetic snapshots, a drill report, and the updated decision log.

## 2. What Stage 6 must not build
No broker adapter or credentials, no Zerodha integration, no order placement or modification, no order objects that could be sent, no emergency flatten, no position or fill handling, no paper-execution simulator (Stage 7), no LLM or model-based agent, no learned or adaptive weights, no external data fetching in the worker, no exporter that runs unattended, no change to `LIVE_TRADING` or `TWINS_BOT_ACTIVE`, no relaxation of any existing refusal. The proposal must have **no executable representation**: it is not convertible to an order request by any function in the repository.

## 3. Task breakdown and acceptance criteria
Each task ends with the standard verification (`npm ci`, lint, `tsc -b`, unit and integration tests, migrations, `verify-migrations`, `audit:verify --require-ddl-watch`, `scan:secrets`) and hosted CI green on its pull request; each stops for owner approval.

| Task | Scope | Acceptance criteria |
| --- | --- | --- |
| **6.1** Assessment binding and laundering guard (HB-01, HB-02) | Approval records the run id and synthesis hash; card shows the category; a newer run that changes the outcome needs the policy chosen by the owner (same-config rule or audited supersede record); application + database function agree | Tests: stale-card tap refused; config-change re-run cannot clear an ADVERSE without the supersede record; approval row carries run id/hash; chains verify; disabled engine unchanged |
| **6.2** Engine-enabled control and grants (HB-03, HB-04) | Audited `AGENT_ENGINE_ENABLED` control readable by the approval function; missing assessment refused in the database when set; role grants + start-up probe | Direct function call without an assessment refused when set, unchanged when clear; probe detects a missing grant; migration verified by `verify-migrations` |
| **6.3** Staged activation (HB-05, HB-06, HB-10 inputs) | Shadow mode, optional challenger dependencies, per-stage required-agent profiles, per-agent veto flag | Shadow mode records but never halts and never affects eligibility; enforcing halts as today; disabling a non-required agent works; a required failure is INCOMPLETE |
| **6.4** Snapshot unification and start-up gate (HB-12, HB-13) | Providers resolve from the managed directory; the worker validates required snapshots at start-up and refuses to enable the engine if they fail; lock + compare-and-swap for writes | Expired required snapshot -> engine does not start and logs why; concurrent write refused; `notServed` cannot occur by construction |
| **6.5** Isolation and code pinning (HB-07, HB-08) | Agents run in a sandboxed worker thread / child with hard timeout and memory limit; code-hash manifest checked at start-up | A looping agent is killed at timeout without delaying others; changed agent code without a version bump fails start-up; results cross only as validated JSON |
| **6.6** Alert routing, inactive (HB-18) | Map `agent_engine.*` events to the alerting package with rate limit and de-duplication; disabled until the destination is approved | Simulated failure -> exactly one alert per window when enabled; nothing sent while unconfigured |
| **6.7** Proposal and proposal-bound approval (no orders) | `trade_proposals` (append-only, hash-chained): levels, size, expiry, assessment run, snapshot hashes, hash of all of it; approval binds to the proposal hash; revision / staleness / newer assessment invalidates; Telegram card shows the proposal | Replay and stale tests; approval of a superseded proposal refused; no function converts a proposal to an order (static test); 0 order / fill / position rows; real-PostgreSQL decide() test |
| **6.8** Pre-flight (deterministic, offline) | A pass / fail record per proposal: freshness of snapshots and assessment, instrument status, level / size coherence, limits, kill switch and breakers | Truth-table tests; every failure code asserted; no network; fail closed on unreadable state |
| **6.9** Staging rehearsal and Stage 6 closing review | Deploy migrations to staging with the engine **disabled**, verify; rehearse with synthetic snapshots in shadow mode; drill report; Stage 6 review, updated backlog and the Stage 7 plan | Owner receives the drill evidence; every activation gate in section 5 is listed with its state; nothing left enabled |
Order: 6.1-6.2 first (they close P0); 6.3-6.6 can proceed in parallel after them; 6.7 needs 6.1; 6.8 needs 6.7; 6.9 last. HB-11 (exporter) is **not** in Stage 6: it needs the market-data decision (Q-004) and its own reviewed task.

## 4. Safety gates (apply to every Stage 6 task)
1. Fail closed: an unreadable state, missing data, a malformed snapshot or an unknown value refuses; nothing is guessed.
2. Defaults stay off: every new capability is disabled by default and enabled only by an explicit setting.
3. No raw message text in any new input, output, log or table; the marker-text tests are extended to each new surface.
4. No order, fill, position, broker call or network call in any new code path; asserted by tests that count rows and stub `fetch`.
5. Approval records a decision about one immutable proposal; nothing an agent says grants approval.
6. Every new table is append-only and hash-chained, covered by `audit:verify` and `verify-migrations`.
7. Hosted CI green, no history rewrite, pull-request merge, owner approval between tasks.

## 5. Deployment and activation gates
| Gate | Condition | State after Stage 5 |
| --- | --- | --- |
| A0 | Owner has confirmed or amended D-066 .. D-075 | open |
| A1 | Migrations 0025-0027 (and any Stage 6 migration) rehearsed on a copy of the staging database and applied to staging with the engine **disabled** | not done |
| A2 | Runtime role grants verified (HB-04) | not done |
| A3 | Synthetic snapshots for all fifteen kinds validate under STRICT in staging | not done |
| A4 | Shadow mode run on staging for an owner-set period; verdict distribution and false-halt rate reviewed (HB-19) | not done |
| A5 | Alert destination approved (Q-018 / D-042) and routing tested | deferred |
| A6 | Real data source decided (Q-004), exporter task approved and delivered | open |
| A7 | Enforcing mode switched on in staging by an audited control change, with the kill switch and rollback drilled | not done |
| A8 | The independent security review (F1, Q-012) of the safety-critical code | unresolved; not self-certified |
Production activation of the research engine is a separate, explicit owner decision after A0-A8; it does not authorize paper trading, a broker or live trading.

## 6. What remains disabled throughout Stage 6
`LIVE_TRADING=false`; `TWINS_BOT_ACTIVE=false` (the approval bot stays inactive on staging; its function-level refusals are tested); `TWINS_AGENT_ENGINE_ENABLED=false` by default (enabled only on staging for rehearsal, in shadow mode); broker and execution adapters (empty registries); emergency flatten; order construction; paper execution; the outcome-learning loop; every model-based component; external data fetching; the scheduler; alert delivery until the destination is approved.

## 7. Open owner decisions that gate Stage 6
D-066 .. D-075 confirmations (in particular D-073 a - the lineage rule - and the HB-02 policy); Q-004 (data vendor / budget); Q-018 / D-042 (alert destination); Q-002 / D-034 (instrument scope); the period and success criteria of the shadow run (A4); who performs the F1 review (Q-012); Q-014 (what result would stop the project).
