# Engine shadow mode (HB-06) and activation path

> Prepared 2026-11-05. **Nothing here is enabled.** The engine stays disabled in the live path (`TWINS_AGENT_ENGINE_ENABLED` unset), `LIVE_TRADING=false`. Shadow mode is code that is merged but OFF until the owner sets `TWINS_AGENT_ENGINE_SHADOW=true` on a deployed worker. Decision record: D-093.

## 1. What shadow mode is
`TWINS_AGENT_ENGINE_SHADOW=true` (default false) makes the worker evaluate each new risk decision with the agents - the same registry, weights, required set and thresholds as enforcing mode - and **log** the result. It is mutually exclusive with `TWINS_AGENT_ENGINE_ENABLED=true`: setting both is a configuration error (`INVALID_ENGINE_CONFIG`), so the worker does not start.

| | Enforcing (`ENABLED=true`) | Shadow (`SHADOW=true`) |
|---|---|---|
| Agents run | yes | yes |
| Writes `agent_*` tables (6 hash-chained tables) | yes | **no - reads only** |
| Halts the risk flow (`haltOn`) | yes | **never**; reported as `wouldHalt` |
| Approval eligibility re-check uses it | yes | **no** (no row exists) |
| Needs the runtime-state check | fails closed (throws) | refused -> `skipped: SHADOW_REFUSED`, flow continues |
| An error inside | propagates, job retried | swallowed, `agent_engine.shadow.failed` logged, flow continues |
| Output | tables + `agent_engine.run.*` logs | one `agent_engine.shadow.assessed` log line per decision |

Implementation: `runAgentEngineShadow` in `packages/agents/src/record.ts` (reads the decision and its parsed inputs, resolves the registry, runs the orchestrator in memory, returns counts and codes), called from `recordPendingRiskDecision` in the worker after the enforcing hook inside a try/catch that ignores every outcome. It never throws, writes nothing and creates no decision, card, approval, order, fill or position (integration test: row counts of all six agent tables and the live tables are unchanged, and `getLatestAgentAssessment` is empty).

**Where the shadow output goes: the structured log only (journald, 7-day retention), not a table.** A shadow table would need a migration, an append-only/hash-chain decision and its own review; the first shadow stage is about learning whether the agents run at all on real data (timeouts, missing providers, INCOMPLETE rates), which counts in the log answer. If the owner wants durable shadow history for scoring (HB-09 evidence), a `agent_shadow_runs` table is the follow-up (migration 0030, non-chained, write-only for `twins_app`).

Log fields (allow-listed, no text): `riskDecisionId`, `status`, `assessment`, `wouldHalt`, `durationMs`, counts of agents by status (`completed`, `failed`, `timedOut`, `skippedAgents`, `unavailable`) and a bounded `perAgent` string `agentId:status:verdict,...`.

## 2. HB-05: scope limit chosen, relaxation deferred
The challenger still depends on every agent and all twelve stay required by default. In shadow mode this is harmless: an INCOMPLETE assessment is only logged, never acted on, so one missing snapshot cannot stop anything. **Decision proposed (owner to confirm): take the "shadow-mode scope limit" option now and defer the optional-dependency relaxation to enforcing mode (HB-05 stays open for that stage).** Reason: relaxing the challenger's dependencies changes the safety-relevant ordering and veto semantics and needs its own review (F1 scope); it is not needed to learn from shadow runs.

## 3. Activation path (each step needs an explicit owner go-ahead)
1. Merge and deploy the code (shadow OFF; no behaviour change). Verify V1-V13 as usual.
2. Give the **worker** what the agents need to read: a read-only mount of `/var/lib/twins-snapshots` and the agent rules/provider variables (`TWINS_AGENT_SNAPSHOT_DIR`, calendars, reference) - a compose change reviewed in its own PR. Until then agents report UNAVAILABLE providers and the assessment is INCOMPLETE (a valid, harmless shadow result).
3. Approve Q-009 (see `Q009_PRIVACY_PROPOSAL.md`): shadow mode reads parsed fields only, no message text, no model, no disclosure.
4. Set `TWINS_AGENT_ENGINE_SHADOW=true` on the worker, recreate the worker. Watch `agent_engine.shadow.assessed` / `.failed` for a defined period (suggested: one full market week) and review INCOMPLETE rate, timeouts and `wouldHalt` share. `ENABLED` stays unset.
5. Rollback at any step: unset the variable and recreate the worker (no data to undo - shadow writes nothing).
6. Moving to enforcing (`ENABLED=true`, `SHADOW` unset) is a separate, audited decision that additionally requires the F1 review, HB-05 relaxation or an accepted all-twelve profile, and Stage 6 prerequisites. **Not part of this task.**

## 4. Alert routing for engine events (HB-18, implemented)
Rules added to `packages/alerting/src/rules.ts` (the worker logger already carries the alerting sink):

| Log event | Alert | Severity | De-dupe key |
|---|---|---|---|
| `agent_engine.config.invalid` | `agent_engine.config_invalid` | CRITICAL | `engine_config` |
| `agent_engine.run.failed` (enforcing only) | `agent_engine.run_failed` | CRITICAL | `engine_run` |
| `agent_engine.shadow.failed` | `agent_engine.shadow_failed` | WARNING | `shadow:<reason>` |

Alerts use the existing fixed templates, the detail allow-list and the per-key throttling of the alerter; nothing is sent while no destination is configured. Not alerted: per-decision `INCOMPLETE`/`wouldHalt` (high volume by design while snapshots are not mounted; reviewed from the log instead). Delivery test: an INFO `agent_engine.alert_routing_test` through the host script and loopback relay was delivered to Telegram on 2026-11-05 06:36Z (relay `relay.forwarded`); the rule-to-payload mapping is unit-tested.
