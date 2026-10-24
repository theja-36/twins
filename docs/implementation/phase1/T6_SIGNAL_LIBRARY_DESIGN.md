# T6 - Signal Library (DESIGN ONLY - not approved, nothing built or deployed)

Status: proposal for owner review. No code, migration, role or deployment exists for this layer. LIVE_TRADING stays false; F1 and R0B stay open.

## 1. Purpose
A shared, append-only library of **signal records** from any origin - Telegram-derived claims today, TWINS-generated candidates later - with provenance,
deduplication, historical research and outcome tracking. The library answers "what was claimed, by whom, when, and what happened afterwards". It does not say
"what to do". Doing anything with a record is a different layer.

## 2. Layers and the one-way chain
Each layer is its own set of tables. A later layer references an earlier one by foreign key; an earlier layer never references or is changed by a later one.

```
L0 raw evidence      telegram_messages, telegram_message_events           (exists; untouched)
L1 source claims     options_claims (exists)  ->  signal_records (NEW, the library)
L2 research          signal_clusters / members, signal_outcomes            (NEW, derived, versioned, re-computable)
-- nothing below is created by the library --------------------------------------------------------------
L3 recommendations   recommendations      (later design; created only by an explicit recommender run)
L4 review decisions  claim_reviews (exists, approval bot) -> later also reviews of recommendations
L5 paper trades      paper_trades         (later design; simulated only)
L6 real orders       orders               (exists; out of scope; LIVE_TRADING=false; needs its own approval)
```
Rules enforced in the database, not only in code: each layer has its own write role; L1/L2 roles have no privilege on L3-L6 tables; the library tables carry no
`approved`, `recommended`, `order_id` or `trade_id` column; no foreign key points from L1/L2 to L3-L6.

## 3. Tables (proposed)
**signal_origins** - registry of where records come from: `id, kind (telegram_channel | twins_generator | manual_note), ref (telegram_sources.id | generator name+version), trust_tier, created_at`. Append-only.

**signal_records** - one immutable row per *observation of a signal*:
- identity: `id, origin_id, origin_ref (options_claims.id | generator_run_id), schema_version`
- what was said: `instrument_key` (underlying, expiry, strike, right), `direction`, `entry/target/stop` as claimed (nullable, exactly as stated, never filled in), `claim_snapshot` (copy of the parsed claim), `fingerprint` (sha256 of the normalized economic content)
- when: `observed_at` (when the claim became visible = message timestamp / generation time), `ingested_at` (when we stored it). Never equal by assumption.
- how it arrived: `ingestion_mode` = `live | historical_import | generated`
- **`actionability`** = `research_only | candidate_only` - set once at insert, never updated (trigger). `historical_import` => `research_only`, enforced by a CHECK. A record that arrives live but is already older than the freshness window at insert time is also `research_only`.
- provenance (jsonb, immutable): telegram message id, channel source id, capture_method (api_live / api_history / bot_webhook), content sha256, parser version, assessment outcome; for generated: strategy name+version, code commit, input snapshot hash, parameters.
- Edited or deleted source messages never change a record: an edit creates a *new* record linked by `revises_record_id`; a deletion is an event row, not an update.
- Ambiguous and unsupported parses are stored as `kind = non_claim` (for coverage statistics) and never get outcomes.

**signal_clusters / signal_cluster_members** - deduplication without deleting anything.
- Exact duplicate (same origin, same fingerprint): the second observation is rejected by a unique key; the ingest is idempotent.
- Near/cross-source duplicate (same instrument key and direction within a time window, entry within a tolerance): both records stay; membership rows put them in one cluster with `match_rule`, `rule_version`, `confidence`. Memberships are append-only; a re-clustering with a new rule version adds new rows and marks the old ones superseded.
- The "first observed" record of a cluster is the research reference; later members measure how fast an idea spreads.

**signal_outcomes** - append-only measurements: `record_id, method_version, horizon (eod | d1 | d5 | expiry), market_data_source, entry_basis, max_favourable, max_adverse, hit_target, hit_stop, result, data_completeness, computed_at`.
- Point-in-time only: a measurement may use market data dated at or after `observed_at`, never earlier or after the claimed validity.
- The entry basis is the first available price at/after `observed_at`, not the claimed entry; the claimed entry is compared separately.
- Missing or incomplete data gives `result = unresolved`, never a guess. Re-running with a new method adds rows; old rows stay.
- Applies equally to Telegram claims and TWINS candidates, so the two are comparable on one method.

## 4. Historical imports never become actionable
- Imports (history import, backfill of existing `options_claims`) enter as `ingestion_mode = historical_import`, `actionability = research_only`. The 45 existing claims would be backfilled this way.
- There is no promotion path: nothing updates `actionability`. To act on an idea, a *new live* record must exist.
- The future recommender (L3) may read only `actionability <> research_only` and age within the freshness window; the database refuses a recommendation row that points at a research-only record (trigger), so a bug in the recommender cannot bypass it.
- Research jobs, backtests and channel scorecards read all records; they write only L2 tables.

## 5. TWINS-generated candidates
They enter the library as `ingestion_mode = generated`, `actionability = candidate_only`, with the strategy version and an input snapshot hash. A candidate is a hypothesis to be tracked, not a recommendation. It becomes a recommendation only through the same L3 gate and the same owner approval as any other record, and gets the same outcome tracking, so "does the channel beat our generator" is a query, not a debate.

## 6. Access (roles)
`twins_library_ingest` inserts origins/records/events; `twins_library_research` inserts clusters and outcomes and reads everything in L0-L2; the approval-bot role `twins_bot` is unchanged and gets no library access; no role gets UPDATE/DELETE on records, memberships or outcomes (append-only triggers as in migration 0008).

## 7. Phased plan (each step needs its own approval)
- S0 (this document): approve or change the design.
- S1: schema + migration + ingest from existing `options_claims` (research-only backfill) + tests. No recommender, no bot change.
- S2: clustering with versioned rules + tests on labelled duplicates.
- S3: outcome method + point-in-time tests (lookahead, missing data, holidays).
- S4: separate design for L3 recommendations and L5 paper trades. Real orders stay a third, separate approval.

## 8. Risks and how the design answers them
| Risk | Answer |
|---|---|
| Look-ahead bias in outcomes | point-in-time rule, `observed_at` vs `ingested_at`, tests with future data present |
| Survivorship (deleted/edited posts) | edits = new linked records; deletions recorded as events; coverage stats include non-claims |
| A channel's own reported results treated as truth | outcomes come only from market data we hold, never from channel text |
| Duplicates inflating a channel's score | clusters; scorecards count clusters, not records |
| Historical data leaking into live use | immutable `actionability`, CHECK + trigger, recommender reads only eligible rows |
| Quiet scope creep toward execution | no L3-L6 columns/privileges in L1/L2; static test like the bot's |

## 9. Decisions needed from the owner
1. Freshness window after which a live record becomes research-only (proposal: 30 minutes for intraday option claims).
2. Outcome horizons (proposal: end of day, 1 day, 5 days, expiry) and entry basis (first price at/after observation).
3. Dedup tolerances (proposal: same instrument key and direction within 60 minutes, entry within 2%) - used only for clustering, never to drop data.
4. Keep ambiguous/unsupported parses as `non_claim` records for coverage stats (proposal: yes).
5. Backfill the 45 existing claims as research-only history (proposal: yes).
6. Library roles as listed in section 6.
