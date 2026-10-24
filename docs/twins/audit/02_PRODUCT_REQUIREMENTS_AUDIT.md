# 02 Product requirements audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

Status summary (127 requirements): VERIFIED_IMPLEMENTED 10, PARTIAL 43, MISSING 70, UNVERIFIED 3, BLOCKED 1, NOT_APPLICABLE 0.

Reading guide: `VERIFIED_IMPLEMENTED` means code **and** tests/runtime evidence exist for the stated requirement as written. `PARTIAL` means a meaningful part exists. The full evidence for each row is in [../REQUIREMENTS_TRACEABILITY.md](../REQUIREMENTS_TRACEABILITY.md).

## Where the product is strong (verified)
- Raw capture with provenance, revisions, deletions-as-events, idempotent persistence (TG-03, TG-04, TG-07).
- Read-only Telegram access with an exact reviewed request allowlist and fail-closed egress (TG-01).
- Human approval mechanics for claim review: authorized approver only, single-use, expiring, HMAC-bound callbacks (AP-01; AP-03 partial).
- `LIVE_TRADING` guards in config, worker and scheduler (EX-01 partial).

## Where the product is weakest
- Everything after intake that creates ground truth or decisions with money consequences is absent: outcomes (CR), strategies (SV), sizing/risk (SZ), proposals/pre-flight (AP-04..06), execution (EX), learning (OL).
- Market data is a single unofficial daily source; instrument identity lacks option attributes (MD).
- Intake durability is not structural (TG-12).

## Counts by area
Derived in the matrix and not repeated here (single source of truth): ../REQUIREMENTS_TRACEABILITY.md.

## Product-flow notes
1. **Intake**: works end to end for live capture and a bounded history window; the linkage fields (replies, follow-ups) that determine whether a signal was later amended or cancelled are not captured (TG-06, TG-08).
2. **Parsing**: 44 of 45 staged messages produce options claims; none is verifiable (`INSUFFICIENT_EVIDENCE`) because no live contract/premium source exists; accuracy has never been measured (TG-10).
3. **Decision stack**: implemented for equity-style `signals`, but staging has 0 signals and 0 validations because the options intake path does not create them (F-014).
4. **Approval**: operational for the claim-review loop with a passed handshake; it cannot yet approve an executable proposal.
