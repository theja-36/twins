# Risk decisions - Stage 3 / Task 1

> **Stage 5 / Task 8:** approval eligibility additionally re-checks the latest research assessment of the decision's lineage (`research_assessment_blocked` / `_incomplete` / `_adverse` refuse; `research_assessment_missing` refuses when the agent engine is enabled; with the engine disabled behaviour is unchanged). The refusal is enforced in the application layer and again inside `twins_record_risk_approval` (migration 0027). Risk decisions are not modified: the assessment is read from the append-only agent tables. See [AGENT_ENGINE.md](AGENT_ENGINE.md#approval-eligibility-re-check-stage-5--task-8).

> Decision [D-055](DECISION_LOG.md); requirement [SZ-12](REQUIREMENTS_TRACEABILITY.md) (new) and the foundations of SZ-01…SZ-11, AP-xx, EX-xx. Related: [MANDATORY_STOP_LOSS.md](MANDATORY_STOP_LOSS.md), [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md), [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md). Code: `packages/risk`, migration `0014_risk_decisions_foundation`, `packages/database/src/schema/riskDecisions.ts`.

## 1. What this is - and is not
A **risk decision** is the durable, immutable record that links one parsed **signal or options claim**, its **stop-loss validation evidence**, and every later stage (position sizing, portfolio and loss limits, approval, order intent). **No order can exist without one**: the database refuses an `orders` row unless it references a risk decision that is currently `APPROVED_FOR_REVIEW` and not superseded (§6).
This task builds the foundation only. It does **not** size positions, apply portfolio or loss limits, apply market/liquidity gates, send an approval card, write `decisions`, or create orders. The worker creates one `PENDING` decision per validated signal / recorded options claim and stops there.

## 2. Schema (`risk_decisions`, hash-chained, append-only)
The pre-Stage-3 table of the same name (columns `decision_id`, `approved`, `reasons`, `max_position_size`, `risk_per_trade`, never written by any code; 0 rows on every database) is **evolved in place**, because `orders.risk_decision_id` already references it: those five columns are kept, nullable and **forced to NULL by a check constraint** (deprecated; nothing is dropped, nothing is rewritten). Migration 0014 starts with a guard that **aborts** if the table or `orders` contain any row.
| Column | Notes |
|---|---|
| `id`, `created_at`, `created_by` | `created_by` = `service:<name>` or `operator:<name>` (check constraint) |
| `signal_id` **xor** `options_claim_id` | exactly one subject (check), FK `ON DELETE RESTRICT` |
| `stop_loss_validation_id` | **mandatory**, FK to the append-only evidence table; must belong to the same subject (trigger) |
| `supersedes_id`, `decision_version` | version chain (§4); version 1 has no predecessor |
| `status` | `PENDING`, `APPROVED_FOR_REVIEW`, `REJECTED`, `EXPIRED`, `SUPERSEDED` (check). **No** `EXECUTED`/`FILLED`/live state exists. `SUPERSEDED` is **never stored** (trigger) - see §4 |
| `idempotency_key` | unique; a retried creation returns the same row |
| `instrument_type`, `market`, `symbol`, `expiry`, `strike`, `option_type`, `side` | instrument description (`symbol` = the underlying for options) |
| `entry_price`, `stop_loss`, `stop_loss_basis`, `target_1..3` | positive numbers (check) |
| `planned_quantity`, `planned_notional`, `planned_max_loss_amount`, `planned_max_loss_percent` | **NULL in this task** (no sizing yet); later stages append new versions that fill them |
| `planned_risk_reward_ratio` | `|target_1 − entry| / |entry − stop|`, computed only when all three are known |
| `confidence_score` (0-100), `source_trust_tier` | from the signal validation when it exists, else `UNKNOWN` |
| `decision_reason_code`, `decision_reason` | e.g. `awaiting_risk_gates`, `stop_loss_missing`, `stop_loss_ambiguous` |
| `input_snapshot` | **complete inputs** (signal/claim as parsed, instrument, the stop-loss validation values, the signal validation) - mandatory, non-empty |
| `output_snapshot`, `evidence_references` | stage marker (`sized:false, limitsApplied:false`); ids of the records relied on (stop-loss validation, signal validation, message) - `evidence_references` mandatory |
| `chain_index`, `previous_hash`, `payload_hash`, `event_hash` | the audit chain (§5) |
`superseded_by_id` and `superseded_at` are **derived** columns of the view `risk_decisions_effective` (together with `effective_status`), not stored (§4).

## 3. Lifecycle and rules
`create` → `PENDING` (by the worker) → *(future stages)* append `APPROVED_FOR_REVIEW`, `REJECTED` or `EXPIRED` as a **new version** that supersedes the previous one. Rules enforced **in the service and again by a database trigger** (`risk_decisions_a_integrity_before_insert`, ENABLE ALWAYS, runs before the chain row is assigned):
* The stop-loss validation exists and belongs to the same signal / options claim.
* `APPROVED_FOR_REVIEW` requires `result = 'VALID'` **and** that validation must be the **latest** one of the subject **and** `stop_loss`/`entry_price` must equal the validated values; plus a stop-loss, entry price and basis in the row (check). `INVALID`, `MISSING` and `AMBIGUOUS` evidence can be recorded as `PENDING`/`REJECTED` (with the reason code) but never approved.
* A first version is unique per subject (partial unique indexes); a second decision for the same subject must be a revision.
* A revision cites its predecessor (same subject, `decision_version = predecessor + 1`); a predecessor has at most one successor (unique index), so history is linear.
* Runtime state: every creation/revision first evaluates the `intake` controls (kill switch, intake enabled, state readable). Anything else - including an unreadable state - **refuses before any database access** (`safety_refused`). A database error while reading the evidence is `store_failure`, never a silent success.
Errors carry a fixed code (`invalid_input`, `safety_refused`, `stop_loss_evidence_missing`, `stop_loss_subject_mismatch`, `stop_loss_not_valid`, `decision_exists`, `idempotency_conflict`, `not_found`, `not_latest_version`, `store_failure`), never a driver message.

## 4. Revisions without mutation
Rows are never updated. A revision **inserts a new row** (`supersedes_id` → the old row, version + 1). The view `risk_decisions_effective` joins each row to its successor and reports `superseded_by_id`, `superseded_at` (the successor's `created_at`) and `effective_status = 'SUPERSEDED'`; the old row's stored bytes and hash stay exactly as written (tested). `getLatestRiskDecisionForSignal()` returns the newest un-superseded version.
*Why not store SUPERSEDED / superseded_by_id on the old row?* That would be an UPDATE, which the append-only guard (and the audit chain) forbids by design.

## 5. Immutability and tamper evidence
`risk_decisions` is the seventh audit chain (`audit_chain_heads` row, payload function version 1, same SHA-256 hash definition and domain as 0010/0011). UPDATE, DELETE and TRUNCATE raise SQLSTATE 23001 (`ENABLE ALWAYS`, also under `session_replication_role = replica`); Postgres itself additionally refuses a plain `TRUNCATE` because other tables reference it. The independent TypeScript verifier (`npm run audit:verify`) lists the chain, checks its guard and integrity triggers and the **orders guard**, and detects edits (`payload_modified`), deleted rows (`missing_rows`/`head_mismatch`) like the other chains; the DDL watch covers the new objects. `app-role.sql` needs no change: a table with an `event_hash` column is append-only for the runtime role (SELECT + INSERT, no UPDATE/DELETE/TRUNCATE). The approval bot has **no** grant on it.

## 6. The mandatory link to orders
Trigger `orders_require_risk_decision` (BEFORE INSERT, ENABLE ALWAYS): an `orders` row needs `risk_decision_id`, and `risk_decisions_effective.effective_status` must be `APPROVED_FOR_REVIEW`. A missing id, a missing decision, a `PENDING` one, a superseded one are all refused (tested). No order path exists in the code; this fixes the structure for every later stage. `orders.risk_decision_id` stays nullable at the column level only because dropping that would rewrite the table's contract; the trigger is the rule.

## 7. Integration with the existing flow
`services/worker`: after the signal validation (and on the resume path of a retried job) → `createPendingRiskDecisionForSignal`; after an options claim is recorded → `createPendingRiskDecisionForOptionsClaim`. A subject **without stop-loss evidence gets no decision** (never invented; logged `worker.risk_decision.skipped`); an ambiguous/unsupported options record has no complete claim and gets none. Failures propagate (the intake outbox retries; creation is idempotent per subject); a safety refusal keeps its identity so the intake gate pauses the job instead of consuming an attempt. `packages/risk/src/riskDecisions.ts` is the **only** production file that writes `risk_decisions` (architectural test, `stopLossCoverage.test.ts`, updated from "nobody" to "exactly this file"); nothing writes `decisions`, `orders`, `fills` or `positions`; the worker is the only importer of the module; no approval card or Telegram call can originate here.

## 8. Extension points (not built)
Sizing and exposure fields (`planned_*`) filled by a later version; portfolio/loss limits and circuit breakers as additional evidence references; market/liquidity gates; a reviewer approval of an `APPROVED_FOR_REVIEW` decision; expiry job (`EXPIRED` versions); the order-intent path that cites an approved decision; an `output_snapshot` schema per gate. Each adds a new version row - never an UPDATE.

## 9. Operational notes and limits
* Not deployed to staging by this task. Deploying requires migration 0014 (additive; aborts if legacy rows exist - none do) and the new worker image.
* The pending decision exists for every validated signal, including ones the validation rejected; the reason code says why it cannot be approved. Whether such a signal should instead get an immediate `REJECTED` version is a policy for the later gates.
* `confidence_score` copies the validation's confidence (assumed 0-100 range by the check; the engine's scale is 0-1 today, which also satisfies it).
* Existing historical signals/claims get no decision retroactively (no rewriting); a backfill, if wanted, is a separate reviewed step.
