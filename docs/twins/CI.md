# Hosted CI (GitHub Actions) - Stage 2 / Task 1

> Workflow: `.github/workflows/ci.yml` (+ `scripts/ci/secret-scan.mjs`, `.nvmrc`). Decision [D-049](DECISION_LOG.md); requirement [XC-08](REQUIREMENTS_TRACEABILITY.md); evidence in [phases/01-operations-foundation/TEST_EVIDENCE.md](phases/01-operations-foundation/TEST_EVIDENCE.md). CI verifies only: it deploys nothing, needs no repository secret and reaches no external service or market data.

## History (verified from the repository's Actions record, 2026-10-29)
The previous single-job workflow (`verify`) **has run on GitHub**: 30 recent runs, green on `main` for the baseline docs commit and for the merge of PR #13 (the S1 lockfile security patch); most failures are Dependabot upgrade PRs (e.g. vitest 5, redis 8, node 26). Earlier statements in these documents that "no hosted CI run was observed" came from an audit without GitHub access and are superseded. What had **not** been run on hosted CI before this task is the Stage 1 safety core.

## Triggers
`push` to every branch except `dependabot/**` (those get their `pull_request` run instead), every `pull_request`, and manual `workflow_dispatch`. A newer run on the same ref cancels the older one. Permissions are `contents: read`; no `pull_request_target`, no write permission, no repository secret. The checkout does not persist credentials.

## Jobs (all must pass: the single required check is **`ci-gate`**)
| Job | Runs | Purpose |
|---|---|---|
| `static` | Node 22 (`.nvmrc`) | `npm ci`; **secret scan** (`npm run scan:secrets`); `npm run lint` (0 errors required; warnings are not gated); `npm run typecheck` (`tsc -b`); workspace builds |
| `unit` | Node 20 and 22 | `npm test` (vitest; includes the Python capture and T1 suites it launches). JUnit report |
| `integration` | Node 20 and 22; **Postgres 16 and Redis 7 service containers** with health checks; test files run one at a time (`fileParallelism: false`, because every runtime harness runs the real outbox reconciler over the shared database) | CI target guard -> `npm run db:migrate` (fresh chain, 12 migrations) -> `scripts/ci/verify-migrations.mjs` -> `npm run test:integration` -> **`npm run audit:verify -- --require-ddl-watch`** (the integration run appended real rows to every audit chain; the verifier must pass) |
| `crash-recovery` | Node 22; Postgres 16, Redis 7 mapped to host port **16379** | the opt-in `TWINS_CRASH_TEST=1` test: a real worker process is SIGKILLed after it claimed the outbox row and committed the message; the outbox lease expires (4 s in the test), the reconciler returns the row to FAILED and a replacement worker completes it without duplicates. Its child worker accepts only the dedicated test Redis on 16379, hence the port mapping. The same job also runs `researchCrashRecovery.test.ts` (research SIGKILL before and after the package commit) and `executionCrashRecovery.test.ts` (paper execution: SIGKILL between a committed fill and the position update, then a restarted worker repairs the position exactly once; one case restarts two workers at once). `tests/integration/trading/stage07Concurrency.test.ts` runs in the ordinary integration job (8 concurrent workers repairing one fill: one event per change) |
| `ci-gate` | always | fails if any job above failed, was cancelled or skipped. **This is the check to require in branch protection** |
Node versions: `engines` says `>=20`; 22 is what the deployed image runs (`infrastructure/staging/Dockerfile`), 20 is the oldest supported. npm dependencies are cached by `actions/setup-node` (keyed by the lockfile, no secrets). Test reports and logs are uploaded as artifacts **only when a job fails** (14 days).

## Credentials in the workflow
The only credential-shaped value is `ci_only_not_a_secret`, the password of a throwaway Postgres container that exists for the duration of the job and is reachable only from the runner. `tests/unit/ci/workflow.test.ts` fails if any other `POSTGRES_PASSWORD` or any `secrets.*` reference appears. Enable GitHub secret scanning and push protection in the repository settings when the plan allows (they need a public repository or GitHub Advanced Security); until then `scripts/ci/secret-scan.mjs` is the safety net: it scans every tracked file for token and private-key shapes (everywhere) and for passwords in URLs / quoted key assignments (runtime code, scripts, infrastructure, workflows; not tests, docs or `*.example` templates), refuses tracked secret material by path (`.env*` except templates, `*.pem`, `*.key`, `*.session`, `staging.env`, `bot.env`, dumps), allows only three exactly-named synthetic values with a stated reason, and never prints a matched value. A `.gitignore` section covers the same file types.

## How to interpret a failure
| Failing step | Meaning | First thing to check |
|---|---|---|
| `static` > secret scan | a credential-shaped string or secret file is tracked | the file:line in the log (the value is not printed); remove it and rotate it if it was real |
| `static` > lint / typecheck / build | code quality or a type error | run the same npm script locally |
| `unit` | a unit or architectural test failed; the **architectural tests** (`tests/unit/safety/*Coverage*`, `stopLossCoverage`, `auditInfra`) fail when a new path bypasses a safety rule or when SQL and TypeScript specs diverge: read the message, do not just update the allow-list | `reports/unit-junit.xml` artifact |
| `integration` > ciGuard | the CI target is wrong (database name/user, `LIVE_TRADING`) | environment block of the job |
| `integration` > migrate / verify-migrations | the migration chain or a required trigger/constraint is missing or not `ENABLE ALWAYS` | `reports/migrate.txt` |
| `integration` > tests | a behaviour regression against real Postgres/Redis | JUnit artifact; the audit-chain and stop-loss tests name the exact SQLSTATE expected |
| `integration` > audit verification | **an audit chain is broken or a guard trigger is missing**: treat as a real integrity problem until proven a test artifact; the first failure (chain, index, code) is in `reports/audit-verify.txt` | never "fix" by regenerating hashes |
| `crash-recovery` | recovery after a hard kill failed (duplicate or lost job). It is timing-sensitive by nature: re-run once; a repeat failure is real | `reports/crash-junit.xml` |
| `ci-gate` | one of the above failed | the red job |
Reproduce locally exactly as CI does: Node 22, disposable `postgres:16-alpine` and `redis:7-alpine`, `TWINS_CI=1 LIVE_TRADING=false TRADING_MODE=paper DATABASE_URL=postgresql://twins_ci:...@127.0.0.1:<port>/twins_ci`, then the commands in the table.

## Branch protection policy (intent)
GitHub reports "Upgrade to GitHub Pro or make this repository public to enable this feature" for branch protection on this private repository, so **it cannot be enforced technically today**. Until it can, the team policy is:
1. `main` receives changes only through pull requests from feature branches (this repository's established practice: PR #13), never by direct push.
2. **`ci-gate` must be green** (all jobs) before merging; a Dependabot PR is no exception.
3. The branch must be **up to date with `main`** (merge or rebase `main` in and re-run CI) before merging.
4. **No force pushes** to `main` or to any branch another person may have based work on; **no deletion** of `main`.
5. Review before merge when more than one person works in the repository (single-owner today: record the self-review in the PR description).
When the plan allows, configure: require status check `ci-gate`, require branches to be up to date, require a pull request, restrict force pushes and deletions, and (for teams) require one approving review and dismiss stale approvals.

## Not covered
No Docker image build/scan, no dependency audit gate (`npm audit` has open findings tracked as Dependabot PRs), no deployment, no coverage threshold, no scheduled run of the audit verifier against staging (the systemd timer is packaged, not installed), no alert on CI failure beyond GitHub's own notification.
