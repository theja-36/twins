# Immutable audit trail and tamper evidence (Stage 1 / Task 3)

> Implemented 2026-10-29 at base commit `4646ee7` + uncommitted Stage 1 changes. Migration `0010_audit_immutability_hash_chain`. Requirement entries: [XC-12 and XC-10](REQUIREMENTS_TRACEABILITY.md); decision [D-047](DECISION_LOG.md); evidence in [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md). Builds on [RUNTIME_SAFETY_STATE.md](RUNTIME_SAFETY_STATE.md).

## What is protected
| Table | Holds | Notes |
|---|---|---|
| `audit_events` | generic audit trail (market conflicts, entity events, **DDL watch**, chain genesis marker) | |
| `signal_validations` | decision-intelligence verdicts | |
| `telegram_messages` | raw channel messages and edit revisions | |
| `options_claims` | parsed, unverified options claims | |
| `system_control_events` | every change of the runtime safety controls (kill switch, intake, trading) | now also records operator context (below) |
Also guarded: `audit_chain_heads` (written only by the chain trigger), `system_controls` (0009 rules, now ENABLE ALWAYS). Older append-only tables (`telegram_message_events`, `claim_reviews`, `approval_bot_events`) keep their 0007/0008 triggers; they are not hash-chained.

## Append-only (UPDATE, DELETE and TRUNCATE rejected)
Per table: `<t>_no_update_delete` (BEFORE UPDATE OR DELETE, per row) and `<t>_no_truncate` (BEFORE TRUNCATE), both raising SQLSTATE **23001** (`restrict_violation`). They are **ENABLE ALWAYS**, so `session_replication_role = replica` does not switch them off. A `TRUNCATE` of a table that other tables reference is refused by PostgreSQL itself (0A000) before any trigger; `TRUNCATE ... CASCADE` reaches the guard. The guard fires before foreign keys, so deleting a referenced message now fails with 23001 (the `ON DELETE RESTRICT` key stays as the second layer). Privileges add a third layer for the runtime role (below). **No application or test path updated or deleted these tables** (verified before the change); legitimate flows are `INSERT ... [ON CONFLICT DO NOTHING]` only, which the triggers do not affect.
Chain columns cannot be updated because nothing can be updated; they also cannot be supplied or influenced at insert: the BEFORE INSERT trigger overwrites whatever the inserter sent.

## Correction-event policy
No table currently needs an in-place correction, and none is allowed. A correction is always a **new row** that points at the original; a generic void/correction table is deliberately not built until a flow needs one:
- `telegram_messages`: an edit is a new revision row (existing design); a deletion is an event in `telegram_message_events`.
- `signal_validations`: re-validation appends a new row; the latest wins, history is kept.
- `options_claims`: a re-parse under another parser version is a new row.
- `system_control_events`: the next change is the correction.
- `audit_events`: a correcting event of type `audit.correction` with `entity_type='audit_events'`, `entity_id=<original id>` and the reason in `metadata`; the original is never touched.
A future table that needs a void path must add an explicit `*_voids` append-only table (and its own chain), never an UPDATE.

## Hash chain
Each protected row carries `chain_index`, `previous_hash`, `payload_hash`, `event_hash` (plus the existing `created_at`, which is part of the payload). They are assigned by a BEFORE INSERT trigger, so raw SQL is chained too.
```
payload       = to_json(ARRAY[<fixed list of the row's content columns, each rendered as text>])::text   -- a JSON array of strings/null
payload_hash  = sha256(payload)                                                                     (hex)
event_hash    = sha256("TWINS-AUDIT-V1" LF chain LF chain_index LF previous_hash LF payload_hash)   (hex)
previous_hash = event_hash of chain_index - 1;  genesis = 64 zeros;  chain = the table name
```
- **Canonical serialization:** a JSON array of strings/null in a fixed per-table order. `JSON.stringify` and PostgreSQL `to_json(text[])` are byte-identical for such arrays (proved by a pinned test vector and by an integration test with quotes, backslashes, control characters, emoji, U+2028 and jsonb), so the verifier recomputes **independently** in TypeScript (`packages/audit-chain/src/specs.ts`) instead of trusting the database. jsonb columns use PostgreSQL's canonical jsonb text; timestamps are rendered as UTC microsecond ISO strings (independent of session time zone); numerics as stored.
- **Order and concurrency:** a per-chain advisory lock (`pg_advisory_xact_lock(1953720, hashtext(chain))`), held to the end of the inserting transaction, serializes writers; the next index is derived from the table itself, so a rolled-back insert or an `ON CONFLICT DO NOTHING` duplicate leaves **no gap**. Consequence: concurrent writers to one chain queue (low volume by design); a transaction that touches two chains should always touch them in the same order (a deadlock is detected by PostgreSQL and surfaces as an error to retry).
- **Chain heads:** `audit_chain_heads(chain_name, last_index, last_hash)` is updated by an AFTER INSERT trigger (SECURITY DEFINER) and by nothing else (direct writes, deletes and truncates are refused by a guard that requires trigger depth >= 2). It exposes deletion of the **newest** rows, which breaks no link.
- **Pre-existing rows:** migration 0010 chained them in `(created_at, id)` order. Tamper evidence for history older than the migration starts at the migration.
- **Spec versioning:** the domain string `TWINS-AUDIT-V1` and the field lists are version 1. Adding or changing a content column of a chained table changes its payload; it **requires a new payload version** (new domain, new functions, a re-chaining migration), or the verifier will (correctly) report every row as modified. `tests/unit/infrastructure/auditInfra.test.ts` fails if the SQL and TypeScript field lists diverge.

## Verifier
`npm run audit:verify -- [--json] [--chain <name>]... [--anchor-file <path>] [--require-ddl-watch] [--status-file <path>] [--batch-size N]` (`scripts/ops/verify-audit-chain.ts`, library `packages/audit-chain`; compose job `audit-verify`, profile `ops`). Read-only; one connection in a REPEATABLE READ snapshot so a busy system gives no false alarm; keyset batches (default 1000) for large tables; runs the live-trading guard first.
Detects, and reports the **first failure** (chain, chain_index, row id, reason): `missing_rows` (a gap, or newest rows gone per the head), `out_of_order`, `broken_link` (previous_hash), `payload_modified` (content or payload_hash), `invalid_event_hash`, `head_mismatch`, `anchor_mismatch`, `protection_missing` (a guard trigger missing or not ENABLE ALWAYS, or chain columns missing), `ddl_watch_missing` (only with `--require-ddl-watch`).
Exit codes: **0 PASS, 1 FAIL, 2 usage/config, 3 could not run**. Output never contains the connection string or driver messages.
**External anchor:** the chain and head live in the same database, so a user who can disable the guards can delete the newest rows *and* rewrite the head. `--anchor-file` keeps the last verified head of every chain **outside** the database; the next run proves those positions still hold the same hashes and rewrites the file only after a PASS. Run it from the scheduled job and keep the file off the database volume.
**Scheduled/CI use:** `infrastructure/staging/twins-audit-verify.{service,timer}` (hourly, `--require-ddl-watch --anchor-file --status-file`; not installed by this change) and a CI step after the integration suite (`npm run audit:verify`, job fails on FAIL). The status file `{ok, ts, epoch, first_failure, chains}` is for monitoring (a stale or `ok:false` file is an alert; wiring the alert is the P01 alerting item, not done).

## Role separation
| Role | Used by | May | May not |
|---|---|---|---|
| **owner** (`POSTGRES_USER`) | `migrate`, `safety-control`, `audit-verify` (compose profiles `migrate` / `ops`) | schema changes, run migrations, change runtime controls | nothing is technically denied; see "DDL watch" |
| **`twins_app`** (`infrastructure/staging/app-role.sql`) | `api`, `worker`, `scheduler` | SELECT + INSERT on the 4 protected audit tables; SELECT on `system_controls`; SELECT/INSERT/UPDATE on ordinary tables | UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on protected tables; any write to `system_controls`, `system_control_events`, `audit_chain_heads`; **any DELETE or TRUNCATE anywhere**; own/alter/drop tables, disable triggers, create objects; superuser, `session_replication_role` |
| **`twins_bot`** (`approval-bot-role.sql`) | approval bot | unchanged: read parsed claims and 3 control columns, write its own tables | everything else, including the chain columns and all audit tables (integration-tested) |
`app-role.sql` is idempotent and is re-run after every migration; any table with an `event_hash` column or a `*_no_update_delete` trigger is treated as append-only automatically. **Self-checks:** `checkRuntimeRolePrivileges` (`packages/audit-chain/src/privileges.ts`) lists violations; the **API and worker refuse to start (exit 82)** when `APP_ENV` is not `development` and their role could modify a protected table (including a role that is a superuser or owns a protected table). The compose file now gives the runtime services `twins_app` through `TWINS_APP_DB_PASSWORD` (required variable); local development and CI keep the single owner role.
**DDL watch:** an event trigger (`twins_audit_ddl_watch`; creating it needs a superuser, otherwise the migration warns and the verifier reports `ddl watch: absent`) writes an `audit_events` row (statement text, session user, client address, application name) for every `ALTER/DROP TABLE`, `DROP TRIGGER`, `CREATE TRIGGER` and `CREATE/ALTER/DROP FUNCTION` that mentions a protected object. So the owner/admin may manage schema and may even disable a guard, but doing so **is recorded in the immutable trail and makes `audit:verify` fail** until the protection is restored. It does not stop a superuser who drops the event trigger itself (event triggers do not fire for event-trigger commands) or `pg_dump`/restores the database; the external anchor and off-host backups are the defence for that, and role separation of the superuser from operations is deployment work.

## Operator identity (system_control_events)
`changed_by` is still required and still self-declared (no authentication system). New convention, enforced in `changeControl` **and** by a database CHECK:
- mechanism `cli` -> `changed_by = operator:<name>` (the safety-control CLI requires `--changed-by operator:<name>`);
- mechanism `service` -> `changed_by = service:<name>` (automated components, e.g. a future circuit breaker);
- mechanism `migration` (seeds) and `legacy` (rows from before 0010); mechanism `sql` = a change made with raw SQL.
Each event also records `source_process` (e.g. `safety-control`, `raw_sql`), the declared `operator_context` (CLI: OS user, host, pid), and what the **database** observed: `db_session_user`, `db_client_addr`, `db_application_name`. A raw-SQL change cannot pose as a CLI/service change without matching the identity pattern, and its server-observed session is recorded either way.

## Limits (not solved here)
Superuser compromise or restore-from-edited-dump (anchor + off-host backup are the answer; off-host backup is still deferred, D-040); no cross-database signing or trusted timestamps; alert delivery of a failed verification is not wired; the `telegram_message_events`/`claim_reviews`/`approval_bot_events` tables are append-only but not chained; chain writers to one table queue on an advisory lock.

**Stage 3 / Task 1 addition:** `risk_decisions` is the seventh chain (payload version 1; see [RISK_DECISIONS.md](RISK_DECISIONS.md)); the verifier also checks the `orders_require_risk_decision` guard (a non-chain invariant trigger).

**Stage 3 / Task 4 addition:** `loss_events` and `circuit_breaker_events` are the eighth and ninth chains (payload version 1; see [CIRCUIT_BREAKERS.md](CIRCUIT_BREAKERS.md)); `risk_decisions` gains the `risk_decisions_b_breaker_before_insert` guard (verified ENABLE ALWAYS), and `orders_require_risk_decision` now also refuses orders while a breaker is open.

**Stage 3 / Task 5 addition:** `event_blackout_windows` is the tenth chain (payload version 1; see [MARKET_RISK_GATES.md](MARKET_RISK_GATES.md)); `risk_decisions` gains the `risk_decisions_market_review_check` (an approval needs a PASSED market evaluation).

**Stage 3 / Task 6 addition:** `risk_approvals` is the eleventh chain (payload version 1; see [RISK_APPROVAL_WORKFLOW.md](RISK_APPROVAL_WORKFLOW.md)); it is written only by the SECURITY DEFINER function `twins_record_risk_approval`, and `orders_require_risk_decision` now also requires a recorded APPROVE.

**Stage 4 / Task 1 addition:** `historical_source_records` is the twelfth chain (payload version 1; see [HISTORICAL_ARCHIVE_IMPORT.md](HISTORICAL_ARCHIVE_IMPORT.md)); the historical batch, normalized, issue and checkpoint tables are append-only by trigger.
