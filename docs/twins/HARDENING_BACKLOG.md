# Stage 5 hardening backlog

> Written 2026-10-30 from the Stage 5 closing review ([STAGE5_CLOSING_REVIEW.md](STAGE5_CLOSING_REVIEW.md)). **Nothing here is scheduled or authorized**: it is a prioritized, evidence-based proposal for the owner (D-075). No time estimates are given. Each item names the current behaviour (verified in the repository at the merge of PR #45), the risk, the proposed work and an acceptance test. Requested areas: process isolation / CPU limits HB-07; agent code-hash detection HB-08; learned / adaptive weights HB-09; DST-aware calendars HB-14; time-of-day volume HB-15; volatility surface and implied-versus-realised HB-16; exchange-calendar expiry HB-17; alert routing HB-18; snapshot exporter / scheduler HB-11; provider settings / snapshot directory unification HB-12; concurrent snapshot writes HB-13; approval-eligibility edge cases HB-01 .. HB-04 and the consolidated table at the end. HB-05, HB-06, HB-10, HB-19, HB-20 and HB-21 were found during the review.

## Priority scale
* **P0 - before the engine is enabled on anything but synthetic data in staging.** Closes a way an unacceptable decision could become approvable or a halt could be bypassed.
* **P1 - before any enablement with real data.** Operational safety and supply of data.
* **P2 - model fidelity.** Improves judgement quality; does not open a safety gap.
* **P3 - governance-heavy or speculative.**

## Summary
| ID | Item | P | Depends on |
| --- | --- | --- | --- |
| HB-01 | Bind an approval to the specific assessment run it relied on | P0 - **CLOSED** (migration 0028) | - |
| HB-02 | "Latest assessment wins" can launder an ADVERSE / BLOCKED result | P0 - **CLOSED** (migration 0028; the explicit operator supersede record remains an option) | HB-01 |
| HB-03 | Make "engine enabled" visible to the database so a missing assessment is refused there too | P0 - **CLOSED** (migration 0028) | - |
| HB-04 | Role grants for the agent tables and `risk_decisions` in eligibility checks | P0 - **CLOSED in code** (grants and probe exist; the grants are applied only when `app-role.sql` is run at a deployment) | deployment |
| HB-05 | Challenger dependency on every agent; all-or-nothing activation | P1 | - |
| HB-06 | Staged / shadow activation (engine enabled without halting) | P1 | HB-05 |
| HB-07 | Process isolation and CPU / memory limits for agents | P1 | - |
| HB-08 | Agent code-hash detection | P1 | - |
| HB-09 | Calibration of thresholds and weights; learned / adaptive weights | P2 / P3 | outcome data |
| HB-10 | Single-agent ADVERSE veto policy review | P1 | HB-09 |
| HB-11 | Snapshot exporter and scheduler | P1 | owner: Q-004 |
| HB-12 | Unify provider settings and the snapshot directory | P1 | - |
| HB-13 | Concurrent snapshot write policy | P1 | HB-12 |
| HB-14 | DST-aware / per-market calendars | P2 | - |
| HB-15 | Time-of-day volume adjustment | P2 | - |
| HB-16 | Volatility surface and implied-versus-realised comparison | P2 | - |
| HB-17 | Exchange-calendar expiry handling | P2 | HB-14 |
| HB-18 | Alert routing for `agent_engine.*` events | P1 | owner: Q-018 / D-042 |
| HB-19 | Challenger, agent and indicator calibration evidence | P2 | HB-09 |
| HB-20 | Test gaps: real data, performance, bot callback end-to-end | P1 | - |
| HB-21 | Synthesis version and old rows | P3 | - |
| HB-22 | Longer retention for audit evidence in the host journal (relay delivery records, host job logs) | P2 | owner decision |
| HB-23 | Dead-letter replay needed the manual job-record cleanup until the replay job-id fix was deployed (**CLOSED 2026-11-03**, Deploy 3, D-085) | P1 | - |
| HB-24 | Capture-gap window tuned to the channel's real cadence (default 14 days) | P2 | observation |
| HB-25 | Durable shadow-run table (shadow output is log-only, 7-day journal) | P2 | owner decision (deferred 2026-11-05, D-094) |
| HB-26 | Diagnose 3 local integration failures (offhostBackup restore, 2x expiryBreakers) that pass on fresh hosted CI | P2 | - |

## P0

> **Closure note (P0 hardening task, 2026-10-31; decision D-077).** HB-01 .. HB-04 are implemented and tested on branch `feat/p0-hardening` (migration 0028). The sections below keep the original "Now / Risk / Work / Acceptance" text for the record; "Now" describes the behaviour BEFORE this task. What was built: (HB-01) `risk_approval_cards` carry `research_run_id`, `research_assessment` and `research_synthesis_sha256` (immutable), the card text shows the assessment and a short run id, `twins_record_risk_approval` refuses `research_assessment_changed` / `research_reference_missing`, and the approval row stores the run in `decision_snapshot.research` and `evidence_references.researchRun*` (inside the hash-chain payload). The API path (no card) cites the run in the context; when the caller names none, the run that stands is cited and recorded. (HB-02) `twins_research_assessment` - used by the database function AND the application layer - treats an earlier ADVERSE / BLOCKED run as standing unless a later run's adverse agents cite different, non-empty evidence (`research_adverse_not_superseded` / `research_blocked_not_superseded`); a configuration change, a re-run or a new decision version over the same evidence does not clear it. (HB-03) `agent_engine_state` (one audited row, seeded `false`, changed only by `scripts/ops/agent-engine-control.ts`) lets the function refuse `research_assessment_missing` while it is true; the start-up probe refuses `TWINS_AGENT_ENGINE_ENABLED=true` while it is false. (HB-04) `infrastructure/staging/app-role.sql` grants SELECT on the agent tables, `risk_decisions` and `agent_engine_state` and EXECUTE on the two helper functions; `runResearchProbe` runs at API and worker start-up and stops the process (`agent_engine.config.invalid`) when the check applies and a grant or the flag is wrong. **Remaining (not closed):** there is no explicit audited operator "supersede" record (only changed evidence clears an adverse result); evidence fingerprints are only as discriminating as the evidence references agents cite (an agent that cites none can never clear its own adverse result); nothing here is deployed or enabled.

### HB-01 Bind an approval to the specific assessment run it relied on
* **Now:** eligibility re-checks "the latest assessment of the lineage" at the moment of approval; the approval record does not say which run that was, and the card does not show it.
* **Risk:** the audit trail cannot prove which research result an approval relied on; two operators could see different "latest" results.
* **Work:** record the orchestrator run id and its synthesis hash in the approval's decision snapshot (the approval function already stores a snapshot); show the assessment category and run id on the approval card; refuse an approval whose card cites a run that is no longer the latest.
* **Acceptance:** a test creates a card on run A, creates a newer run B, and the tap is refused (`research_assessment_changed`); the approval row carries run id and hash; audit chain verifies.

### HB-02 "Latest assessment wins" can launder an ADVERSE / BLOCKED result
* **Now:** a newer run on a newer version supersedes an older one in either direction (D-073 a). Re-running with a different configuration (for example another weight set or halt list) creates a new run key and may turn ADVERSE into CAUTION.
* **Risk:** an operator or a configuration change can remove an adverse finding without any evidence changing; the earlier run stays in the audit trail but no longer stops the approval.
* **Work:** policy options for the owner: (a) keep latest-wins but require the newer run to use the **same agent set, configuration hash and input hash family** as the one it supersedes, or an explicit, audited `supersede` record by an operator; (b) refuse if **any** run in the lineage is BLOCKED / INCOMPLETE / ADVERSE unless superseded by such a record. Implement in the application layer and the database function together.
* **Acceptance:** a test with a config-change re-run that improves the verdict is refused without the supersede record; with it, allowed; both layers agree.

### HB-03 Make "engine enabled" visible to the database
* **Now:** the database function refuses a bad assessment but cannot refuse a missing one, because "engine enabled" is an environment setting of the worker; only the application layer refuses `research_assessment_missing`. A direct call to the function (not via the service or the bot) for a decision with no assessment is not refused for that reason. (A card cannot exist for a decision that failed the application check, so the bot path is covered in practice.)
* **Work:** a `system_controls`-style flag (`AGENT_ENGINE_ENABLED`, audited like the kill switch) written by an operator command; the function refuses a missing assessment while it is set. Keep the environment setting as the source for the worker and add a start-up consistency check.
* **Acceptance:** with the flag set, a direct function call for a decision with no run returns `refused:research_assessment_missing`; with it clear, behaviour is unchanged.

### HB-04 Role grants for the agent tables and `risk_decisions`
* **Now:** the application-layer check reads `agent_orchestrator_runs`, `agent_orchestrator_syntheses` and `risk_decisions` with the evaluating role. If the role lacks SELECT, the check fails closed (`research_assessment_unavailable`) while the engine is enabled and is skipped while it is disabled.
* **Risk:** a deployment without the grants either refuses everything or silently skips the check.
* **Work:** add the grants to the role setup scripts, a deployment verification step (`verify-migrations`-style) that reads each table as the runtime role, and a start-up probe in the API / worker that logs `agent_engine.config.invalid` if the probe fails with the engine enabled.
* **Acceptance:** a test creates the runtime role with and without the grant; the probe reports the difference.

## Closed outside the original list
* **Runtime role could write the execution tables (found 2026-11-01; D-079; migration 0029).** `twins_app` / `twins_bot` lose INSERT / UPDATE (and the rest) on `orders`, `fills`, `positions`; `app-role.sql` keeps them read-only. Open follow-up (P2): consider adding the same rule to the start-up privilege self-check (`checkRuntimeRolePrivileges`) so a role that regains the grant makes the process refuse to start.
* **Audit-chain verifier empty-chain anchor (found 2026-11-01 on staging; D-078).** An empty chain's anchor (index 0) made the next run report a deleted row. Fixed in `evaluateAnchor` with regression tests. Not deployed: staging keeps reporting the false failure until the fixed verifier is deployed. Follow-up (open, P1): alert-fatigue review - a permanently failing hourly check hid for 2.6 days that it was a false positive; confirm failure alerts were delivered and add "failing for more than N runs" escalation.

## P1

### HB-05 Challenger dependency on every agent; all-or-nothing activation
* **Now:** the challenger depends on every other registered agent; disabling one without the challenger makes the engine refuse to start (`DEPENDENCY_DISABLED`); all twelve are required by default; one missing snapshot makes every decision INCOMPLETE.
* **Work:** let the challenger declare *optional* dependencies (it skips an agent that is disabled, but a *required* agent that did not complete still skips it); a required-agent profile per activation stage (HB-06).
* **Acceptance:** disabling a non-required agent no longer requires disabling the challenger; a required agent's failure still yields INCOMPLETE.
* **Status 2026-11-05 (D-093, D-094):** OPEN for enforcing mode. **Owner decision 2026-11-05: shadow scope only** - the challenger dependency stays as it is for shadow (an INCOMPLETE assessment is only logged); relaxing it is deferred to the enforcing stage (ENGINE_SHADOW_MODE.md section 2).

### HB-06 Staged / shadow activation
* **Now:** enabled means halting. There is no mode that records assessments without halting.
* **Work:** a `SHADOW` mode: the engine runs and records, the worker never halts on it, eligibility ignores it; the observability record says `shadow`. Switching from shadow to enforcing is an audited control change.
* **Acceptance:** in shadow mode an ADVERSE assessment is recorded and logged but the flow continues and eligibility is unchanged; in enforcing mode both halt.
* **Status 2026-11-05 (D-093):** IMPLEMENTED in code (`TWINS_AGENT_ENGINE_SHADOW`, `runAgentEngineShadow`; logs only, no table; mutually exclusive with enforcing), merged only after owner approval; NOT deployed, NOT activated. Activation path: ENGINE_SHADOW_MODE.md section 3.

### HB-07 Process isolation and CPU / memory limits
* **Now:** agents run in the worker process; the timeout is cooperative (the result is ignored, but a CPU-bound agent blocks the event loop). Today every agent is first-party and deterministic.
* **Work:** run agents in worker threads or a child process with a hard kill timeout, memory limit and no network / no filesystem beyond the snapshot directory; required before any agent not written and reviewed in this repository, or any LLM-assisted agent, is allowed.
* **Acceptance:** an agent in an infinite loop is killed at its timeout without delaying other agents; resource limits are enforced; results cross the boundary only as validated JSON.

### HB-08 Agent code-hash detection
* **Now:** the registry stores a hash of each agent's *contract*; a change to the agent's code with the same version is not detected.
* **Work:** hash the agent's compiled module (or a source manifest) at build time, store it in `agent_definitions`, and refuse to start (or log an error) if a registered agent's hash differs from the pinned manifest for its version.
* **Acceptance:** changing an agent's logic without bumping its version fails the start-up check.

### HB-10 Single-agent ADVERSE veto policy review
* **Now:** an ADVERSE verdict from any scoring agent of weight >= 50 halts the flow (eleven of the twelve agents have weight >= 50; the challenger has 30). One miscalibrated agent can therefore halt every decision, and the thresholds that decide ADVERSE are uncalibrated.
* **Work:** owner review of which agents may veto; per-agent veto flag separate from weight; evidence from shadow runs (HB-06) to set it.

### HB-11 Snapshot exporter and scheduler
* **Now:** snapshots must be produced elsewhere and installed with `agents:snapshots write`. No exporter, no scheduler, no external fetch.
* **Work (separately reviewed, after Q-004):** one exporter per provider, each writing through `writeSnapshot`; a scheduler (or an operator runbook) with an explicit freshness SLO and failure alert; egress allow-list for the exporter only; no exporter inside the worker.
* **Acceptance:** each exporter produces a snapshot that `validate` accepts; a failed export leaves the previous snapshot in place and raises an alert.

### HB-12 Unify provider settings and the snapshot directory
* **Now:** the worker reads the files named by `TWINS_AGENT_*_PROVIDER`; the manager validates `<dir>/<kind>.json`; the manager reports a setting that does not read the managed file (`notServed`) but nothing makes them agree.
* **Work:** a single `TWINS_AGENT_SNAPSHOT_DIR` resolving each provider to `<dir>/<kind>.json` unless explicitly overridden; the worker validates the required snapshots at start-up and refuses to enable the engine if they are not acceptable under the configured strictness (log `agent_engine.config.invalid`).
* **Acceptance:** with the engine enabled and a required snapshot expired, the worker does not start the engine and says why.

### HB-13 Concurrent snapshot write policy
* **Now:** writes are atomic and need a typed confirmation, but two operators confirming the same kind both succeed; the last write wins and the first previous-version copy is overwritten (`.previous/` keeps one generation).
* **Work:** an exclusive lock file per kind, a compare-and-swap option (`--expect-sha256`), and more than one retained generation with an audit log line per write.
* **Acceptance:** a concurrent write is refused or serialized; `--expect-sha256` with a stale hash is refused.

### HB-18 Alert routing for `agent_engine.*` events
* **Now:** records go to the structured log only. The alert destination is deferred (Q-018 / D-042).
* **Work:** map `agent_engine.run.failed`, `config.invalid`, repeated `run.completed` with INCOMPLETE, and a missing-provider `providers` warning to the existing alerting package once the destination is approved; rate-limit and de-duplicate.
* **Acceptance:** a simulated failure produces exactly one alert per window; nothing is sent while the destination is unconfigured.
* **Status 2026-11-05 (D-093):** rules for `agent_engine.config.invalid`, `agent_engine.run.failed`, `agent_engine.shadow.failed` added (unit-tested); delivery proven through the host relay to Telegram. Not alerted by design: per-decision INCOMPLETE / would-halt. The destination (owner Telegram via relay) is the existing approved one.

### HB-20 Test gaps
Real-provider data (none exists), performance with many agents and large snapshots (16 MB cap, 200k-bar series), the approval bot's callback end-to-end with the new refusal codes against a running bot, and a deployment rehearsal of migrations 0025-0027 on a copy of the staging database.

## P2 - model fidelity

### HB-25 Durable shadow-run table
* **Now (owner decision 2026-11-05):** shadow evaluations are written to the structured log only (journald, 7-day retention). Deferred on purpose.
* **Work (when asked):** a non-chained `agent_shadow_runs` table (migration, write-only for `twins_app`) holding decision id, assessment, `wouldHalt`, per-agent status / verdict / confidence, duration; needed for scoring and weight evidence (HB-09, HB-19) beyond one week.
* **Acceptance:** a shadow run leaves exactly one row; the live tables are still untouched; retention policy documented.

### HB-26 Diagnose three local integration failures
* **Now:** on 2026-11-05 a full local integration run against a 6-day-old local Postgres failed 3 tests (`offhostBackup` scratch restore, two in `expiryBreakers`); the same suite passes on the fresh hosted-CI database, and none of the code involved was changed. Cause not diagnosed: likely stale local database state (rows left by earlier runs) and/or a missing or mismatched `pg_dump`/`pg_restore`.
* **Work:** re-run against a freshly created local database with matching client tools; if they still fail, fix the tests' isolation or document the local prerequisites.
* **Acceptance:** the full integration suite passes locally on a fresh database, or the prerequisites are written into the test-target documentation.

### HB-22 Longer retention for audit evidence in the host journal
* **Now (decision 2026-11-03: keep 7 days for now):** the alert relay logs to the host journal (D-084). `/etc/systemd/journald.conf` keeps `MaxRetentionSec=7day`, `SystemMaxUse=1G` (about 174 MB used), so the record of whether an alert reached Telegram, and the host jobs' logs, age out after a week. The two backup-failure alerts of 2026-11-02 / 11-03 could not be proven delivered partly because their log was already gone.
* **Risk:** audit questions about an alert, a backup or a verification older than seven days cannot be answered from logs.
* **Work:** evaluate (owner decision) a longer retention, either for the whole journal or only for TWINS: a persistent copy of the delivery lines (a small append-only file or the status export), a `MaxRetentionSec` of 30-90 days with a size cap check, or a journal namespace for the TWINS units. Weigh disk (the journal and the 193 GB disk), the privacy rule that alert lines carry codes only, and whether the audit-chain `audit_events` should also receive an alert-delivery event.
* **Acceptance:** a stated retention target with its reason, a test or runbook step that reads an alert's delivery record after the old window, and a disk-use check.


### HB-14 DST-aware / per-market calendars
* **Now:** sessions are configuration with fixed UTC offsets (default NSE / BSE 09:15-15:30 IST, no DST); weekends are Saturday / Sunday; the macro agent treats global sessions as open or closed from the snapshot.
* **Work:** per-market time zones (IANA) with DST, market-specific weekends and half days from the holiday snapshot; tests across DST changes.

### HB-15 Time-of-day volume adjustment
* **Now:** the liquidity agent compares volume with the average without regard to the time of day, so early-session volume looks thin (CAUTION only).
* **Work:** an intraday volume profile (cumulative fraction expected by time), applied to the thin-volume ratio.

### HB-16 Volatility surface and implied-versus-realised comparison
* **Now:** the options agent takes IV, greeks and the chain as supplied; it compares IV with the previous session and the at-the-money IV only; it does not recompute greeks, build a surface or compare with realised volatility.
* **Work:** realised volatility from the OHLC snapshot, an IV percentile / term-structure view from the chain, skew; thresholds calibrated on history.

### HB-17 Exchange-calendar expiry handling
* **Now:** the expiry is the configured close time (10:00 UTC) of the expiry date; a holiday-shifted expiry is not applied (the calendar agent flags the day, the options agent does not move the expiry).
* **Work:** resolve the effective expiry from the exchange calendar and the contract record; tests for holiday-shifted weekly and monthly expiries.

### HB-19 Calibration evidence
Agent thresholds (spread, IV, theta, gamma, trend, RSI, pattern, news) are conservative round numbers. Work: back-test the verdict distribution on historical data, report false-halt and miss rates per agent, and adjust only through reviewed configuration changes.

## P3

### HB-09 Learned / adaptive weights
* **Now:** weights are static configuration (50 / 60 / 30). Nothing learns.
* **Work:** only after outcome data, shadow runs and governance exist: propose weight changes offline, review them, apply them as a versioned configuration with the audit trail. **No online adaptation, and no weight change that can lower a veto, without owner approval.** The synthesis output must keep stating the weights used.

### HB-21 Synthesis version and old rows
Runs stored under `research-synthesis-v1` have no `halt` block (`haltReasonCode` is `UNKNOWN` for them). Work, only if needed: a read-time adapter, never a rewrite of append-only rows.

## Approval-eligibility edge cases (consolidated)
| Case | Current behaviour | Item |
| --- | --- | --- |
| Newer run improves the verdict | allowed only if the adverse agents cite different evidence; otherwise `research_*_not_superseded` (closed) | HB-02 |
| Approval relies on a run that is later superseded | the run is recorded in the approval; a card citing a no-longer-latest run is refused `research_assessment_changed` (closed); a superseding run AFTER the approval is still not detected | HB-01 |
| No assessment, engine enabled, direct function call | refused `research_assessment_missing` when `agent_engine_state` is true (closed) | HB-03 |
| No assessment, engine disabled | unchanged (by design) | - |
| Engine disabled after a bad assessment exists | still refused (by design) | - |
| `ENFORCED=false` | only the application layer is off; the database floor stays | D-073 c |
| Customised halt list | does not weaken eligibility (three mandatory refusals) | - |
| Role cannot read the agent tables | the start-up probe stops the process when the check applies (closed); per request still `unavailable` / skipped | HB-04 |
| Assessment older than the decision's validity | not checked; the decision's own window applies | HB-01 |
| Run on a version older than the approvable one with unchanged inputs | counted (lineage rule) | D-073 a |
