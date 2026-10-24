# 08 Security and operations audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Secrets and least privilege
| Item | Finding | Evidence / label |
|---|---|---|
| Secret files | staging.env and bot.env are host-local files outside the repository with restricted permissions (exact owner/mode not recorded here); example files carry no values; `.gitignore` excludes bot.env | OBSERVED 2026-10-24 (dated, historical) |
| Bot DB role | no `raw_text`/`raw_payload`, no claim writes, append-only logs | rolePrivileges.test.ts PASS |
| Compose hardening | cap_drop ALL, no-new-privileges, read-only root, pinned base digests | docker-compose.staging.yml |
| API auth | single static bearer for private routes; no rotation or per-client identity | apps/api/src/index.ts (historical audit, not re-tested) |
| Audit trail | `audit_events` has few writers; approvals are logged in the bot's own append-only tables | schema/audit.ts; migration 0008 |
| Host SSH | root login and password auth were enabled on 2026-10-22; **not re-inspected** | UNVERIFIED |
| Ollama exposure (2026-10-22) | bound to all interfaces; **not re-inspected** | UNVERIFIED |

## Queues and recovery
BullMQ 3 attempts with backoff, deterministic job ids, bounded enqueue, crash-recovery and concurrency integration tests. No dead-letter policy/alert (XC-02). In-flight durability depends on Redis (TG-12).

## Backups and restore
Daily encrypted PostgreSQL backup with automated verification; restore proof done; the backup status record observed on 2026-10-24 (dated, historical) indicated no off-host copy was configured; no failure alert; no off-host key escrow (XC-03, F-008).

## Observability
Structured JSON logs with correlation ids and redaction tests. `scripts/ops/capture-watch.sh` is a bounded on-demand watcher (no persistent watcher observed). Worker has no health check. No TWINS-wide alerting (XC-04).

## CI and supply chain
CI covers typecheck/lint/unit/build/migrations/integration; no dependency audit or secret scan; hosted run not observed; Dependabot configured (XC-08).

## Latency/freshness
Per-call timeouts exist; no end-to-end latency budget; executable freshness undefined (XC-06).

## External terms and regulatory register (PROPOSED WORK - NOT a compliance statement)
**Roles.** The product owner is recorded ONLY as the *coordination* role (keeps the register, supplies facts, relays questions); that role carries no legal expertise and is not a qualified review. Qualified reviewers are **UNASSIGNED** wherever one is needed; none is named, contacted or paid. All six rows stay **UNVERIFIED** until their required evidence and review are actually supplied. An unresolved permission, licensing or compliance question blocks the affected activation, use, export or sharing (D-043). No services are purchased, no advisers contacted and no content disclosed.

| Item | Question | Coordination owner | Qualified reviewer | Status | Evidence / decision needed | Blocked while unresolved |
|---|---|---|---|---|---|---|
| Telegram | Channel-owner/admin permission, ToS for user-API capture, member privacy and retention | product owner (coordination only) | UNASSIGNED (needed) | UNVERIFIED | permission record and terms review; Q-003 and Q-017 (both deferred) | full-history backfill beyond the previously authorized pilot; archive import; coverage claims beyond verified captured material; closing this row. Existing runtime permission is neither renewed, expanded nor revoked here. |
| Yahoo endpoint | Terms for the unofficial chart endpoint beyond development | product owner (coordination only) | UNASSIGNED (needed) | UNVERIFIED | terms review and a keep-or-replace decision (D-004) | any use beyond development that the terms would not permit |
| Data vendor | Licensing/redistribution/storage rights for historical and live data | product owner (coordination only) | UNASSIGNED (needed) | UNVERIFIED | licence terms and entitlement evidence (D-004) | vendor go-live; storing, exporting or sharing vendor data; P04 vendor decisions |
| Broker API | Terms, order-type support, rate limits, static-IP/registration | product owner (coordination only) | UNASSIGNED (needed) | UNVERIFIED | broker terms and capability evidence (Q-010) | P12 (any broker integration) |
| Exchange / SEBI | Rules for automated order placement and for any recommendation-like output | product owner (coordination) + qualified reviewer | UNASSIGNED (required) | UNVERIFIED | a written qualified review conclusion (D-013) | P12; automated order placement; recommendation-like output to third parties |
| Personal data | Storage of message senders/members, retention policy | product owner (coordination only) | UNASSIGNED (needed) | UNVERIFIED | retention policy and privacy stance (Q-017, deferred) | production retention/pruning jobs; exports/sharing that need the privacy decision |

The "Blocked" column is derived from decisions D-013, D-038, D-041 and D-043; the owner may correct it.
