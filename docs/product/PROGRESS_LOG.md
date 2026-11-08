# Development progress log

## 2026-11-08
- Stage 00: spec read in full; audit verified against the repo (one correction: `decisions` is in use); preservation map written; tracker generated (386 requirements, 77 recorded as already IMPLEMENTED, none VERIFIED).
- Stage 01: started (see MODULE_COMPLETION_REPORTS.md).

- Stage 01: contracts and tests written (32 platform tests + 5 tracker tests); tracker updated; enforcement layers deferred to Stage 02.
- Stage 02: migration 0033 written (24 tables, RLS, append-only triggers, live-mode lock); withUser helper; static tests; unit suite green. Not applied to any database.
- Pre-push review: `tsc -b` clean (forced rebuild). Migration 0033 reviewed and hardened (see DATABASE_CHANGE_LOG). QUALIFIED-producer proof test added.
- Stage 02 VERIFIED in CI (run 42445765317). Starting Stage 03.
- Stage 03 item 1 (Module 02): rule-based classifier, context reconstruction, idempotent storage, owner-run backfill CLI (not wired into live intake). 21 unit tests + 2 integration tests written; accuracy on real messages unmeasured.
- Stage 03 item 2 (Module 03): similar-signal matcher, outcome aggregation, evidence completeness check (pure, 17 unit tests). History loader and real cases pending.
- Stage 03 items 3-4 (Modules 06, 07): channel profile inference, playbook content, versioned lifecycle with owner-only activation and rollback (migration 0034: one ACTIVE per playbook). CI pending.
- Stage 03 item 5 (Modules 06, 07): performance by condition, drift/degradation detection and alert recording, stop behaviour, reason and revision analysis, counterfactual review, out-of-sample evaluation for activation. Pure logic + one DB writer (drift events).
- Stage 03 complete in code; CI green on ce1ee58 (items 1-5). See GAP_REGISTER for what is not wired.
- Stage 03 wiring: classification at intake behind TWINS_CLASSIFY_ON_INTAKE (default false), failure-isolated and idempotent; CI for 824593d confirmed green. Stage 04 started.
- Stage 04 (2026-11-09): market regime detection (`market-regime-v1`), Market Context Agent (13th agent, advisory), spec role mapping + report adapter, research package builder, candidate research runner (both pipelines), hosted-AI gateway with fixtures, migration 0035 `ai_usage_records`, stores for regimes / research packages / AI usage. CI green on 2fc8c28 (run 42452595965). CI on 6a9a7ba failed in integration (agent-enumeration tests did not disable the new agent): fixed in ce118b4. Unit suite 214 files / 3639 tests green locally; real-database tests await CI.
- Stage 05 (2026-11-08): Independent Opportunity Engine (Module 16): `packages/opportunity` (config, setups incl. new reversal/momentum + resampler, rank, candidate drafts, lifecycle/revalidation, scan, dispatch, cycle), migration 0036 (lifecycle guard + history, dedupe, slot-keyed scans), opportunityStore, scheduler job effect `research_intake`, `opportunity_queue` worker + cron enqueue (OFF by default). 35 unit tests; 12 integration tests written (CI pending). tsc -b clean; full unit suite 3676 passing. G-17 dispatch half resolved; G-19..G-21 recorded.
