# 09 Tests and evidence

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

Results below were produced earlier in the same working session at HEAD `702d4a8` (a verification run on 2026-10-24 after the e2ePipeline fix) and are **recorded, not re-run, for this documentation task** (no code changed since).

## Executed results (historical for this audit)
| Suite | Result | Notes |
|---|---|---|
| Typecheck (`tsc -b`) | PASS | exit 0 |
| Lint (`eslint .`) | PASS | 0 errors, 115 warnings |
| Unit (vitest, 72 files) | PASS | 938 / 938 |
| Integration, rehearsal DB `twins_rehearsal_f2_fresh` | PASS | 191 passed, 5 skipped, 0 failed |
| Integration, empty throwaway DB (CI-style context) | PASS | 192 passed, 4 skipped, 0 failed |
| Approval-bot role privileges (real PostgreSQL, rolled back) | PASS | 8 tests |
| Approval-bot gate mutation checks | PASS | 4 weakened gates each caused test failures |
| Staging handshake (TEST card) | PASS | runtime events observed 2026-10-24 |
| Migration verification (`scripts/ci/verify-migrations.mjs`) | PASS | on rehearsal DB with 9 migrations |

## NOT_RUN in this task (and why)
| Item | Reason |
|---|---|
| Any test re-execution | documentation-only task; tests were verified green on the same tree earlier |
| Hosted CI | not observed; no access evidence |
| Node 20 / 22 matrix | CI-only |
| `npm audit` | requires network; not part of local flow |
| Python capture unit tests as a standalone run | covered via the vitest runner in the unit run above; not independently re-run here |
| Any test touching Telegram, brokers, vendors or the staging stack | would have side effects; excluded by scope |

## Known test caveats
- Several integration tests share a database and historically depended on ambient data; the e2ePipeline dependency on aged Yahoo rows was fixed in `702d4a8` (docs/implementation/R0B_CLOSURE_REVIEW.md section P).
- The approval bot's claim-card SQL path (`decide()` for a real claim) has unit coverage through an in-memory stand-in and real-PostgreSQL coverage for privileges and the TEST card only.
- No performance, load or soak tests exist.

## Test inventory by area (counts of test files)
tests/unit: 72 files (adapters, api, approvalBot, config, database, dataquality, decision-intelligence, entities, infrastructure, ingestion, observability, rehearsal, scripts, shared, signals, telegram, tools, web, worker). tests/integration: 37 files (including runtime, signals, entities, decision-intelligence, dataquality, approvalBot). Python: services/telegram-capture/tests (test_core, test_history, test_service plus fakes; scripted fake transport + loopback server).
