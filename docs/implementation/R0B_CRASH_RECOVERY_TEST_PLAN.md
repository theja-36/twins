# R0B - real worker-process crash/recovery test: PLAN (EXECUTED ONCE on 2026-10-19 after approval; passed; see evidence/r0b-crash-recovery-2026-10-19/INDEX.md)

## What it proves / does not prove
Proves (if it passes): a dedicated worker PROCESS killed abruptly (SIGKILL) after committed partial progress is recovered by a replacement worker through BullMQ stalled-job recovery, with no duplicate business records and a correlation context joinable across both processes. Does NOT prove: exactly-once delivery, Redis outage, PostgreSQL outage, VPS/host loss, multi-worker contention, or production lock settings. "Stalled" is a BullMQ recovery event/mechanism (lock expiry + stalled check), not a separate job state.
Not a crash test: a thrown exception, `worker.close()`, or `kill -TERM` (those are used only in teardown).

## Files (all new, uncommitted; gated; no production code or guard changed)
- `tests/integration/runtime/crash/workerChild.ts` - the child process running the REAL `processTelegramQueueJob`.
- `tests/integration/runtime/crashRecovery.test.ts` - the test; `describe.skipIf(!(TWINS_CRASH_TEST=1 && TWINS_CI=1))`, so normal `npm run test:integration` and CI never spawn or kill anything (verified: skipped by default).

## Transaction boundaries inspected first
There are no explicit transactions anywhere in the pipeline (`grep .transaction(` finds none); every statement autocommits. `runIngestionJob` inserts its `jobs` row, `ingestTelegramMessages` resolves the source and inserts the message row, then updates `jobs`/`provider_health` - all committed before `processTelegramJob` continues. The checkpoint is the first awaited `INSERT INTO signals` (inside `createSignalFromTelegramMessage`, after `resolveInstrument`), i.e. message persistence completed and committed; signal/validation not started. The parent re-reads the row from a SEPARATE connection at the checkpoint to prove it is committed.

## Process model
- Parent: the vitest process (real API `buildApp` + producer queue + `QueueEvents`, capture logger).
- Child 1: `node --import tsx tests/integration/runtime/crash/workerChild.ts --queue=<q> --mode=crash` started with `child_process.fork` (IPC channel, stdout piped). Child 2 (replacement): same with `--mode=recover`.
- Exact child command (via fork): `node --import tsx tests/integration/runtime/crash/workerChild.ts --queue=r0b_test_crash_<32 hex uuid> --mode=<crash|recover>`; env: the guarded test env + `NODE_ENV=test LIVE_TRADING=false TWINS_CI=1`.
- The child itself refuses to run unless: `TWINS_CI=1`, `LIVE_TRADING=false`, `DATABASE_URL` is loopback `/twins_ci` as user `twins_ci`, `REDIS_URL` is loopback port 16379, and the queue name starts with `r0b_test_` (verified: refused for twins_dev, wrong Redis port, `LIVE_TRADING=true`, `TWINS_CI` unset). Synthetic market provider is registered, so no external market call can occur.
- Ownership/PID tracking: the `ChildProcess` handle from `fork` (`proc.pid`), the pid reported over IPC by the child, and a read-only `ps -o command= -p <pid>` check that the command line contains `workerChild.ts` AND the unique queue name. Only `crashing.proc.kill("SIGKILL")` is used for the crash; nothing is ever killed by name or pattern.
- Checkpoint confirmation: child sends IPC `{type:"checkpoint", name:"message_committed_before_signal_insert", pid}` and then blocks forever; parent additionally checks the DB (1 committed message, 0 signals) and that the BullMQ job is `active`.

## Crash and recovery sequence
1. Spawn child 1 (crash mode); wait for IPC `ready`.
2. POST a real webhook (header `x-correlation-id: crash-test-corr-0001`, test secret) through `buildApp` -> unique test-owned queue; job id `tg-tg_chat_<id>-<message_id>`.
3. Wait for the checkpoint; assert committed message, 0 signals, job `active`.
4. Ownership proof; `SIGKILL` that pid; assert the child's exit event reports `signal=SIGKILL`, `code=null`, `kill(pid,0)` throws; assert it logged no completed/failed event; assert DB still has 0 signals.
5. Spawn child 2 (recover mode); wait for `ready`; wait up to the recovery deadline for the job to reach `completed`.
6. Assertions (below). 7. Teardown.

## BullMQ test-only settings (child worker; production values untouched; installed BullMQ 6.3.11)
`lockDuration: 3000`, `stalledInterval: 1000`, `maxStalledCount: 1` (the BullMQ default; one stalled recovery is allowed), `lockRenewTime` default (= lockDuration/2). Defaults are 30000/30000/1. Recovery needs the dead worker's lock to expire (<= 3 s) and a stalled check by the replacement (every 1 s). Job options remain the API's: `attempts: 3`, exponential backoff. Recovery deadline: 45 s measured from the kill (test timeout 120 s); a stalled recovery does not consume `attempts`.

## Expected persisted records
| Moment | message | signals | validations | ingestion `jobs` rows | BullMQ job |
|---|---|---|---|---|---|
| checkpoint (before kill) | 1 (id M, committed) | 0 | 0 | 1 (succeeded) | active, attemptsStarted 1 |
| after SIGKILL | 1 (M) | 0 | 0 | 1 | active until lock expiry |
| after recovery | 1 (same id M) | 1 (telegramMessageId = M) | 1 (`telegram-ingest:<signalId>`) | 2 (second one reports duplicates=1; bookkeeping, not business records) | completed, attemptsStarted 2, stalledCounter 1 |
Also: one `stalled` QueueEvents event for the job id (evidence of the mechanism). Log joins: API `webhook.intake.accepted` correlationId = child 1 `worker.job.started` (attempt 1, `childPid` = crashed pid) = child 2 `worker.job.started` (attempt 2, `childPid` = replacement pid) = child 2 `worker.job.completed` (signalId/validationId match the DB); child 2 `worker.message.ingested` shows `inserted:0, duplicates:1` (canonical message reused).

## Database writes and Redis scope
Writes only to `twins_ci` (the approved, guarded test database): one source, one message, ingestion `jobs`/`provider_health` rows (x2 for jobs), one signal, one validation, signal evidence, a synthetic market observation, possibly an instrument row. These test rows REMAIN (as with every other test run on `twins_ci`); nothing is deleted or reset. Redis: only the unique queue `r0b_test_crash_<uuid>` (keys `bull:<queue>:*`). No other database (`twins_dev`, rehearsal, restore, ci clean copy) is touched.

## Teardown (in the test's `afterAll`)
Child 2: IPC `shutdown` (graceful close) with a 10 s wait, falling back to SIGKILL of that same handle. Parent: close app, QueueEvents, `queue.obliterate({force:true})` on the unique queue only, quit connections, close DB pool. Afterwards SCAN `bull:r0b_test_crash_*` must show 0 keys, and no `workerChild` node process may remain. A failed run still tries the same teardown and reports problems; the crashed child is already dead.

## Exact run command (after approval)
```bash
cd /Users/sara/twins
export TWINS_CI=1 TWINS_CRASH_TEST=1 NODE_ENV=test APP_ENV=development TRADING_MODE=paper LIVE_TRADING=false \
  DATABASE_URL='postgresql://twins_ci:ci_only_not_a_secret@127.0.0.1:15432/twins_ci' REDIS_URL='redis://127.0.0.1:16379'
npx vitest run --config vitest.integration.config.ts tests/integration/runtime/ciGuard.test.ts          # guard first
npx vitest run --config vitest.integration.config.ts tests/integration/runtime/crashRecovery.test.ts   # the crash test
node docs/implementation/rehearsal/redis_scan_test_keys.mjs                                              # SCAN only (bull:r0b_test_*)
ps -eo comm,command | awk '$1 ~ /node/ && /workerChild/'                                                  # expect no output
```
No new containers, roles or databases are needed. Everything uses the existing `twins_ci` database/role, the existing test Redis and the existing test container.

## Success criteria
Child exits from SIGKILL; job completes within the deadline; 1 message (same id), 1 signal, 1 validation, correct references; logs joinable by job id and correlation id; `attemptsStarted` 2 and `stalledCounter` 1; stalled event observed; no remaining test-owned child process or `bull:r0b_test_crash_*` keys after teardown.

## Known caveats
`attempt` in logs counts BullMQ `attemptsStarted`, so the recovery run is attempt 2 although `attemptsMade` stays 0 until the job finishes. If the stalled check were slower than the deadline the test fails (it does not relax assertions). The crash timing is deterministic (held at the checkpoint); it does not cover crashes at other instants. One accidental artifact of preparation: key `bull:r0b_test_refusal_check:meta` (see report).

## Execution addendum
Executed once as approved. Added before running: a diagnostics capture (job state/counters, failed reason, stalled events, API and child logs, IPC) written BEFORE queue cleanup on success or failure (`TWINS_CRASH_EVIDENCE_FILE`). Result: passed; see the evidence index. Not proven: outage recovery, exactly-once delivery.
