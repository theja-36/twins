# Source scorecards and trust tiers (Stage 4 / Task 3)

> Decision [D-063](DECISION_LOG.md); requirement [HI-03](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [HISTORICAL_ARCHIVE_IMPORT.md](HISTORICAL_ARCHIVE_IMPORT.md), [HISTORICAL_OUTCOME_EVALUATION.md](HISTORICAL_OUTCOME_EVALUATION.md) and [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md). Code: `packages/historical/src/scorecards/`, `scripts/ops/historical-scorecard.ts`, migration `0022_historical_scorecards`.

An objective, auditable scorecard for every historical signal source, computed **only from evaluated outcome labels** of imported records. It describes evidence about a source's *past signals*; it does not infer intent, never labels anyone fraudulent (the vocabulary is `REVISION_ACTIVITY` / `EVIDENCE_CONFLICT`), approves nothing, sizes nothing, and **no risk decision reads it in this task**. No live Telegram channel, provider, broker or order is involved; imported records and outcome labels are never modified; no live-pipeline table is written.

## Source identity

* **Identity = channel label** (the stable key in the archive). `historical_source_registry` holds one `IDENTITY` entry per label (`register`), keyed by `sha256("channel|" + label)`.
* **Aliases are linked explicitly** (`link-alias`, with a mandatory reason and operator): an `ALIAS_LINK` entry points an alias identity at a canonical one. Nothing is merged automatically or silently. Rules: one link per alias (forever - the registry is append-only), no alias chains, the canonical must not itself be an alias, an alias must not have aliases of its own. A canonical source's scorecard covers its own messages plus those of its linked aliases; asking for an alias shows the canonical source.
* Per scorecard run the **source snapshot** records: member labels, distinct authors/handles (where available; excluded from exports), markets seen, first/last seen, imported messages, revision records, normalized signals, evaluable and unverifiable counts.

## Inputs

Per **original message** (revision 0) of the source: its normalized record (latest normalization), its **latest outcome label** (the most recent evaluation run; `--eval-run` pins specific runs), and its revisions. Revisions never count as separate signals; they feed the behavioural metrics. The exact label ids used are hashed (`label_set_sha256`) and the evaluation runs and dataset references are stored.

## Metrics (fixed R model)

WIN_T1 +1R, WIN_T2 +2R, WIN_T3 +3R, LOSS_SL −1R, NO_ENTRY / EXPIRED_NO_ENTRY 0R, EXPIRED_AFTER_ENTRY 0R. `UNVERIFIABLE` and `INVALID_SIGNAL` carry no R: they are counted and rated but are not *evaluable*.

| Term | Definition |
| --- | --- |
| total evaluated | signals with a label (any outcome) |
| evaluable | labels with a definite outcome (WIN_*, LOSS_SL, NO_ENTRY, EXPIRED_NO_ENTRY, EXPIRED_AFTER_ENTRY) |
| entered | WIN_*, LOSS_SL, EXPIRED_AFTER_ENTRY |
| win / loss / no-entry / expired / unverifiable / invalid **rate** | count ÷ total evaluated |
| win rate (entered), SL hit rate, T1/T2/T3 hit rate | count ÷ entered (a target counts if it was hit before the stop-loss) |
| gross expectancy | total R ÷ evaluable |
| net expectancy | (total R − `costPerTradeR` × entered) ÷ evaluable |
| profit factor | winner R ÷ \|loser R\|; **null** when there are no losses (not meaningful); 0 with losses and no wins |
| average winner / loser R | mean R of wins / of losses |
| max consecutive losses, max drawdown (R) | over entered trades in message-time order (no-entry ignored); drawdown = largest peak-to-trough fall of cumulative R |
| entry reachability | entered ÷ evaluable |
| SL discipline | signals with a stop-loss present, valid, and **not removed / widened by a later revision** ÷ signals |
| revision frequency / edited share | revision records ÷ signals / signals with ≥1 revision ÷ signals |
| revision-conflict rate | signals with an adverse SL revision **or** an `EVIDENCE_CONFLICT` ÷ signals |
| `EVIDENCE_CONFLICT` (hindsight-suspicion score = share) | a revision stamped **before** its original message (impossible timestamp), or a revision made **after the entry was first touched** that changes entry / targets / stop-loss. Objective evidence only. |
| data-quality score | mean over labels of GOOD 1 / DEGRADED 0.5 / INSUFFICIENT 0 (not-applicable skipped) |
| evaluation coverage | total evaluated ÷ normalized signals |
| edit/delete, late-signal | delete rate and late-signal rate are **null** (`DELETIONS_NOT_MEASURED`, `LATE_SIGNAL_RATE_NOT_MEASURABLE`): the import contract has no deletions and the evaluator uses only post-signal data |

All numbers are rounded to 6 decimals so stored snapshots are byte-stable.

## Windows

Per run: `ALL_TIME`, `LAST_30D`, `LAST_90D`, `LAST_180D`, `LAST_365D` (messages strictly after `as-of − N days`, up to `as-of`) and one `CALENDAR_MONTH` per UTC month with messages (the running month ends at the as-of instant). Messages after the as-of instant are ignored. Each card stores the as-of, window type and bounds, sample size (= evaluable), the metrics and **caveats** (`SMALL_SAMPLE`, `HIGH_UNVERIFIABLE_SHARE`, `PARTIAL_EVALUATION_COVERAGE`, `DEGRADED_DATA`, `PROFIT_FACTOR_UNDEFINED_NO_LOSSES`, `NO_EVALUABLE_OUTCOMES`, and the two not-measured notes). **No market-regime windows exist**; none are invented.

## Trust tiers

Computed from the **all-time** snapshot only (`trust-tier-v1`), deterministically, with every deciding rule stored with its observed value and threshold. Order: UNKNOWN → D → A → B → C, then the conflict downgrade, then guardrails.

| Tier | Default rule |
| --- | --- |
| UNKNOWN (INSUFFICIENT_EVIDENCE) | fewer than `unknownBelow` (**30**) evaluable outcomes |
| D UNTRUSTED | negative net expectancy; or unverifiable share > 60%; or data-quality score < 0.40; or revision-conflict rate ≥ 30% |
| A HIGH_TRUST | ≥ 50 evaluable, net expectancy > 0, win rate (entered) ≥ 45%, unverifiable < 20%, conflict rate ≤ 5% |
| B MODERATE_TRUST | ≥ 30 evaluable, net expectancy ≥ 0, unverifiable < 35% |
| C LOW_TRUST | otherwise (≥ `c.minEvaluable` = 10 and at least `unknownBelow`) |
| downgrade | conflict rate > 15% lowers A→B and B→C |
| **guardrails (not configurable)** | an A always needs ≥ 30 evaluable outcomes, positive net expectancy and ≤ 40% unverifiable |

`costPerTradeR` defaults to **0.05R** per entered trade (a placeholder assumption, configurable). All thresholds live in `TierConfig` (`--tier-config file.json`, partial overrides, validated); the full configuration is stored with each run and tier.

> **Open point (D-063):** the task text says both "fewer than 30 evaluable outcomes must be UNKNOWN" and "UNKNOWN: fewer than 10". Defaults follow the stricter rule (30), which makes the C floor of 10 inactive until `unknownBelow` is lowered by configuration.

## Database

Five append-only, **hash-chained** tables (chains 17–21, migration `0022`): `historical_source_registry`, `historical_scorecard_runs` (source, as-of, algorithm version, configuration + hash, label-set hash, evaluation-run / dataset references, label count, source snapshot), `historical_scorecard_metrics` (one row per window), `historical_trust_tiers` (tier, explanation, full metric snapshot, threshold configuration, evidence references) and `historical_scorecard_events` (RUN_STARTED / RUN_COMPLETED). A run is identified by `sha256(source, as-of, algorithms, configuration, label set, per-signal input, source snapshot)`: rebuilding unchanged input is a no-op; a new as-of, configuration or any new label / import is a **new run**. Nothing is ever edited.

## Service function

`getLatestSourceTrustTier(db, label | { channelLabel })` → `{ tier, label, reason, asOf, scorecardRunId }`. Latest = newest as-of, then newest creation. An alias resolves to its canonical source. Returns `UNKNOWN` (never throws, never guesses) for an unregistered source (`SOURCE_NOT_REGISTERED`), no scorecard (`NO_SCORECARD`) or insufficient evidence. Read-only; nothing imports it yet.

## Commands

```
npm run historical:scorecard -- register   --created-by operator:<name>
npm run historical:scorecard -- link-alias --alias <label> --canonical <label> --reason "<why>" --created-by operator:<name>
npm run historical:scorecard -- rebuild    (--source <label> | --all) --created-by operator:<name> [--as-of <ISO>] [--tier-config cfg.json] [--eval-run <uuid,...>]
npm run historical:scorecard -- list       [--json]
npm run historical:scorecard -- show       --source <label> [--json]
npm run historical:scorecard -- export     --format json|csv [--out file]
```

`--as-of` defaults to now and is part of a run's identity (repeat the same value for a no-op). `export` writes identifiers, tiers and numeric metrics only - **no message content and no authors**; CSV cells starting with `= + - @` are prefixed with `'`. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused. No compose service; nothing runs automatically.

## Limits

Tiers are only as good as the labels: daily-bar data leaves many same-day outcomes `UNVERIFIABLE`. Small samples are UNKNOWN by design. The R model treats expired-after-entry as 0R and ignores position size. Revisions are compared by their parsed numeric levels, not wording. Deletions and lateness are not measured. Real datasets and thresholds must be reviewed by the owner before any tier influences sizing or confidence (a later task).
