# Off-host encrypted backup and cross-host restore - Stage 2 / Task 3

> Decision [D-051](DECISION_LOG.md); requirement [XC-03](REQUIREMENTS_TRACEABILITY.md); related: [IMMUTABLE_AUDIT.md](IMMUTABLE_AUDIT.md), [DURABLE_INTAKE_OUTBOX.md](DURABLE_INTAKE_OUTBOX.md), [CI.md](CI.md). Code: `packages/backup`, `scripts/ops/offhost-backup.ts`, `infrastructure/staging/twins-offhost-*.{service,timer}`, `.github/workflows/offhost-drill.yml`.
> **Nothing here is installed on the staging VPS.** Installing the units on the host is a deployment step that is separately approved (this task does not redeploy staging).

## 1. Goal and threat model
Recover TWINS after the complete loss of the VPS or its disk. The pre-existing daily backup (`twins-backup.sh`: AES-256-GCM, verified, 7 kept) stays on the same disk, so it does not survive that loss. This adds an encrypted copy in a bucket the VPS cannot decrypt and a drill that proves the copy restores on a different machine.
Defended: host loss; host compromise **cannot read** past backups (public-key encryption: the VPS holds only the public recipient); storage-provider or bucket exposure reveals only ciphertext; silent corruption (weekly checksum verification); accidental overwrite/deletion (conditional writes, provider lock, separate delete credential).
Not defended: loss of the private recovery key (backups become unrecoverable: see §5); an attacker who controls both the VPS and the delete-capable credential before the provider lock expires; a corrupted but internally consistent database that was backed up faithfully.

## 2. What is in a backup
One encrypted artifact `twins-<env>-<UTC stamp>.tar.age` (a tar encrypted with age) containing:
| File | Why |
|---|---|
| `database.dump` | `pg_dump -Fc` of the whole database, taken at an **exported snapshot** (REPEATABLE READ); this is also where the audit chains, outbox and `drizzle` migration ledger live |
| `audit-anchor.json` | the external audit-chain anchor, read **before** the snapshot so it is never newer than the dump (compared in the drill) |
| `config/*` | templates and unit files from `infrastructure/staging`: `*.example`, compose, `*.service`, `*.timer`, `*.sql`, `*.sh`, Dockerfiles, README, CIDR list. Filtered by file name AND by the repository secret scanner: a file that looks like it holds a secret **fails the backup** (nothing uploaded) |
| `bundle-info.json` | non-sensitive facts at the same snapshot: migration count, exact row counts of the critical tables, `audit_chain_heads` (chain, last index, last hash) |
**Not** backed up: `staging.env`, `bot.env`, any `.env*`, private keys, Telegram session strings (`*.session`), broker credentials, the age private key, Redis (the Task 2 outbox makes PostgreSQL the source of truth for accepted messages; Redis holds only ids and is rebuilt by the reconciler). Operational state needed for recovery = the dump + the anchor + the templates; the secrets are re-provisioned from the owner's secret store (runbook §7).

## 3. Provider and layout
Provider (owner decision, this session): **Cloudflare R2** (S3-compatible), one **private** bucket, no public domain, no public (`r2.dev`) access. Why: an account already exists in the owner's tooling, no egress fees (the weekly verification and monthly drill download the artifacts), S3 API, bucket lock. Region: automatic. The provider adapter is generic S3 (`@aws-sdk/client-s3`): Backblaze B2, AWS S3 or MinIO work with only an endpoint change. A plain directory store exists for tests and is refused unless `TWINS_BACKUP_ALLOW_DIR_STORE=1`; every record names its provider kind, so a directory can never be mistaken for off-host evidence.
Object layout (one prefix per retention class so the provider's lock and lifecycle rules can differ per class):
```
daily/<env>/twins-<env>-20300101T031500Z.tar.age            (+ .manifest.json beside it)
weekly/<env>/…   monthly/<env>/…                              (same artifact bytes, first backup of the ISO week / UTC month)
```

## 4. Encryption
age (X25519 recipients, ChaCha20-Poly1305) via the `age-encryption` library (pinned 0.3.1), **client-side before upload**. The backup host is configured with `TWINS_BACKUP_AGE_RECIPIENT=age1…` (public). The backup refuses to start if a private key appears anywhere in its environment, or if the recipient is not a public key. The private identity is read only by the restore side, from a **file path** (`TWINS_BACKUP_AGE_IDENTITY_FILE`), mode 0400; it is never an environment value, an argument, a log field or beside the backups. Errors are reduced to fixed codes (`decrypt_failed`, `bad_identity`, …): no key bytes, plaintext or provider message is ever logged. Standard tooling decrypts the artifacts, so recovery does not depend on this repository: `age -d -i age-identity.txt -o bundle.tar twins-….tar.age`.
Verification of encryption without exposing content: tests assert the artifact starts with the age header, contains none of a planted plaintext canary, a fake env-file value or a key marker; the post-upload check compares the SHA-256 of the **ciphertext** only.

## 5. Key custody and recovery (owner procedure)
Generate on a trusted machine (not the VPS): `age-keygen -o twins-backup-age-identity.txt` (install: `brew install age` / `apt install age`). The file prints `# public key: age1…`; **only that public key** goes to the VPS config.
Store the private identity in at least two independent places, **never** in this repository, the bucket, a chat, or on the VPS: (1) the owner's password manager (attach the file or the single `AGE-SECRET-KEY-1…` line); (2) an offline copy (encrypted USB or printed, in a physically separate location). Record who holds it. **Test the recovery key every month**: the monthly drill does exactly that. Rotation: generate a new keypair, change the recipient on the VPS, keep the **old** private key until every backup encrypted to it has aged out (backups name their `recipientFingerprint`). Loss of every copy of the private key = loss of every backup: this is the single point of failure, accepted knowingly by choosing client-side encryption.

## 6. Credentials and least privilege
| Credential | Where | Permission |
|---|---|---|
| **backup-write** (R2 API token) | `/etc/twins-backup/offhost.env` on the backup host (systemd `EnvironmentFile`, root:twins-backup 0640), user `twins-backup` | R2 token scoped to **this one bucket**, "Object Read & Write". R2 has no write-only token; the compensation is the bucket lock below plus conditional writes (`If-None-Match: *`: the code never overwrites) and **no delete is ever issued by the backup job** |
| **drill-read** | recovery host `/etc/twins-recovery/drill.env` / GitHub secrets for the manual drill | "Object Read only", this bucket |
| **prune** (can delete) | the owner's workstation only, on demand | "Object Read & Write"; **not** on the VPS |
The credentials are not in `docker-compose.staging.yml`, not in any container environment, not readable by the application user (a test fails if the compose file mentions them). Create tokens in the Cloudflare dashboard (R2 → Manage API tokens), restrict to the bucket, optionally restrict by client IP to the VPS address. Rotate them by creating a new token and replacing the file.
Bucket protections to enable in the R2 dashboard (the code assumes them; they are provider settings, not code): **Bucket Lock** rules by prefix, `daily/` ≥ 8 days, `weekly/` ≥ 29 days, `monthly/` ≥ 190 days (objects cannot be deleted or overwritten before then, even with a valid token); **Lifecycle** rules deleting objects after those ages plus a margin (daily 14 d, weekly 40 d, monthly 200 d) as the server-side backstop; no custom public domain; no CORS.

## 7. Lifecycle (retention)
Default **7 daily, 4 weekly, 6 monthly** (`TWINS_BACKUP_KEEP_DAILY/WEEKLY/MONTHLY`, validated; also `…_FLOOR` = never fewer than 3 per class, `…_PROTECT_HOURS` = never delete anything younger than 48 h). A backup always goes to `daily/`; it is also copied to `weekly/` if it is the first of its ISO week and to `monthly/` if it is the first of its UTC month (decided from the timestamp in the object name, not the provider's clock). `offhost-backup prune` (dry run by default, `--apply` to delete) enforces the counts per class with the delete-capable credential; the bucket lock and lifecycle rules enforce age. The newest backup of a class is never deleted by either.

## 8. Integrity and the manifest
Per object a `*.manifest.json` (and an append-only local `manifest.jsonl`) records: object name and keys, size, **SHA-256 of the encrypted artifact**, SHA-256 of the plaintext tar and of the dump, creation time, retention classes, encryption method, recipient fingerprint, source-host fingerprint, snapshot facts (migrations, row counts, chain heads), tool version, and `uploadVerifiedAt`. Order: encrypt → hash → upload → **download again and re-hash** (a mismatch fails the run and nothing is declared successful) → write manifests. An `audit_events` row `backup.created` (name, sha256, bytes, classes, provider kind; chained and append-only) records each backup in the database itself.

## 9. Schedules and observability (no alert delivery yet)
| Job | Unit | Default | Runs on |
|---|---|---|---|
| backup | `twins-offhost-backup.timer` | daily 03:15 UTC | backup host |
| checksum verification | `twins-offhost-verify.timer` | Sundays 04:00 UTC | backup host (no key needed) |
| restore drill | `twins-offhost-drill.timer` | 2nd of month 05:00 UTC | **recovery host only** (needs the private key) |
Override with `systemctl edit <timer>` (drop-in: `[Timer]` `OnCalendar=` then the new value). Each job writes a structured JSON log (journal) and an atomic status file `offhost-{backup,verify,drill}.json` in `TWINS_BACKUP_STATUS_DIR` (`ok`, step, fixed failure code, name, sha256, classes, provider kind, for the drill `crossHost`). `offhost-backup status <kind>` exits 1 if the last run failed or is older than 26 h / 8 d / 35 d (configurable `TWINS_BACKUP_<KIND>_MAX_AGE_SECONDS`). A failed upload leaves the encrypted artifact in `spool/pending` and the next run uploads it first. Delivering alerts from these files is a later stage.

## 10. Restore drill (what it proves)
`offhost-backup drill` (or the manual workflow) performs, on the host it runs on: pick the newest `daily/` object (or `--key`) → download artifact + manifest → **SHA-256 must equal the manifest** → decrypt with the recovery key → plaintext digest must equal the manifest → unpack with path/link checks → dump digest must equal → start a **disposable PostgreSQL container** (or a scratch database whose name must start `twins_drill_`) → `pg_restore` → compare migration count, **exact row counts** of the critical tables and every `audit_chain_heads` row against the facts taken at the backup snapshot → `verify-migrations.mjs` structure check (skipped with a note if the checkout is at a different migration level) → the audit-chain verifier on the restored copy, with the bundled anchor → remove the container/database and wipe every plaintext file → write the status file. It reports `crossHost: true` only when the source-host fingerprint in the manifest differs from the drill host's. Failure at any step stops the drill, records the step and a fixed code, and still cleans up.
Commands: `npm run offhost -- backup|verify|drill [--key <object key>]|prune [--apply]|status <kind>` (needs Node 22, `npm ci`, and PostgreSQL client tools or Docker as configured).

## 11. Recovery runbook (complete loss of the VPS)
1. Provision a new host; install Docker, Node 22; clone the repository at the tag/commit of the lost deployment; `npm ci`.
2. Fetch the private key from custody (§5) to a file, mode 0400. Create a read-only R2 token.
3. `npm run offhost -- drill` first (proves this key and bucket work); then restore for real: download the object (`aws s3 cp`/dashboard or the code), `age -d -i key -o bundle.tar …`, `tar -xf`, start PostgreSQL 16, `pg_restore --no-owner -d <db> database.dump`, create the `twins_app` role and run `infrastructure/staging/app-role.sql`.
4. Restore the audit anchor to `/var/lib/twins-monitor/audit-anchor.json`; run `npm run audit:verify -- --anchor-file …`.
5. Re-create `staging.env`/`bot.env` and the Telegram session from the owner's secret store (never part of the backup); bring up compose; the worker's reconciler re-enqueues any outbox row that was in flight.
6. Resume intake only after `audit:verify` passes (kill switch stays active until then).

## 12. Evidence - read this before claiming recovery
Evidence is classified; only the last class proves loss-of-host recovery.
| Class | Meaning | Status |
|---|---|---|
| Unit / library | encryption round trip, checksums, manifests, retention, failure handling (checksum mismatch, wrong key, upload failure after a local success, tampering, secret refusal) | 40+ tests, in CI |
| Same-server isolated restore | real `pg_dump`/`pg_restore` into a scratch database on the **same** PostgreSQL server (`tests/integration/backup`), directory store (not off-host) | in CI; **not** loss-of-host evidence |
| Off-host upload | a real encrypted backup stored in the R2 bucket and re-downloaded and re-hashed | see §13 |
| **Cross-host restore** | the same object downloaded on a machine other than the source, decrypted with the recovery key, restored, compared and audit-verified (`crossHost: true`) | see §13 |

## 13. Real-provider evidence
Recorded below when executed against the owner's bucket (object name, size, SHA-256, timestamp, drill result, runner). Until this section is filled, off-host recovery is **not** proven.
