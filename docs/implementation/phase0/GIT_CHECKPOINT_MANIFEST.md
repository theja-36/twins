# Phase 0A - Git checkpoint manifest (2026-10-22)

Nothing has been pushed. There is no git remote. All objects exist only in this repository on this Mac until a private remote is approved.

## Branches and tags (all local)
| Ref | Commit | Meaning |
|---|---|---|
| `main` | `b2ad592` | Untouched. Last commit before this work. Contains NONE of the deployed code. |
| `safety/worktree-20261022` | `228a2dc` | Exact snapshot of the whole working tree (396 files) taken before reorganising. Not a logical commit. Excludes `.vscode/`, `TWINS_Planning_Pack/` and git-ignored `data/options-snapshots/`. |
| `phase0/checkpoint` | `1ccfc35` | Logical history (below). **Its tree is byte-identical to the safety snapshot** (checked with `git diff --stat`, empty). |
| tag `deployed-20261021-baseline` | `dda8596` | Source of the image running on the VPS. |
| tag `candidate-tg-intake-20261022` | `1ccfc35` | Build set of the candidate image `twins-staging:tg-intake-1495a3ba4`. NOT deployed. |

## Which commit is deployed
The running API/worker image is `twins-staging:local` (`sha256:e41f6a716f48...`), labelled `twins.source-manifest-sha256=9e34461fd33e41762f328750d140bbdd79502d6d997f2647798d46b1a80f775a` (194 files, manifest kept at `/opt/twins-staging/source-manifest.sha256`).

**Verified:** regenerating that manifest from the blobs of commit `dda8596` gives the identical hash `9e34461f...`; 194 of 194 files match, and the commit holds no other file in the build set. So **`dda8596` (tag `deployed-20261021-baseline`) is exactly the deployed source.** The six files that differ between the deployed build and the final tree were taken from the VPS source tree, each verified against the deployed manifest before use.
The baseline commit was also built and tested in an isolated worktree with a cloned `node_modules`: typecheck clean, lint 0 errors, 641/641 unit tests.

Deployed compose file (`/opt/twins-staging/infrastructure/staging/docker-compose.staging.yml`, sha256 `707ccd21...`) is the version stored in commit `0729c09`.

## Commits (oldest first). Pending-deployment = after the tag.
| # | Commit | Group | State |
|---|---|---|---|
| 1 | `0600f31` | CI, root configuration, lockfile | deployed baseline |
| 2 | `fb3320c` | database schema, migrations 0004-0006, client | deployed baseline |
| 3 | `6d17f80` | shared/types: crypto, correlation, structured log | deployed baseline |
| 4 | `6be1c64` | ingestion, entities, signals, decision-intelligence (+ tests) | deployed baseline |
| 5 | `38fb77e` | adapters (GDELT, Telegram webhook adapter WITHOUT allowlist) | deployed baseline |
| 6 | `ad2478e` | API, worker, scheduler, viewer, scripts (WITHOUT allowlist) | deployed baseline |
| 7 | `d1330b6` | guarded integration harness, fixtures, support | baseline (tests only) |
| 8 | `0729c09` | staging stack, Dockerfile, backup scripts (deployed compose) | deployed baseline |
| 9 | `dda8596` | docs/reports/evidence through 2026-10-21 | **= deployed tag** |
| 10 | `5cdeb10` | Telegram approved-chat allowlist + options-only (API, worker, compose vars, tests) | **PENDING deployment** |
| 11 | `ba6c5fb` | build-context fix, `TWINS_IMAGE_TAG`, `.DS_Store` ignore, packaging tests | **PENDING deployment** |
| 12 | `1ccfc35` | staging plan, source manifest, roadmap/audit | docs only |
Further Phase 0 documentation will follow as additional docs-only commits.

Caveat on history quality: commits 1-9 were split by file group, not authored incrementally, so an intermediate commit may not build on its own. Only the tips are verified (baseline `dda8596`: typecheck, lint, 641 unit tests; tip `1ccfc35`: tree equals the tested working tree: 685 unit tests, 170 integration tests passed / 5 skipped by design on 2026-10-22).

## Pending-deployment diff (build set, baseline -> candidate)
7 files, +244 / -21: `.dockerignore` (+1), `adapters/telegram/src/botApi.ts` (shared message selector, edit-ness from the selected kind), `adapters/telegram/src/index.ts` (exports), **new** `adapters/telegram/src/intakePolicy.ts` (policy), `apps/api/src/index.ts` (+27 gate in the webhook), `services/worker/src/index.ts` (+56: two gates and a post-check), `scripts/options-demo.ts` (demo approves only its generated chat). Full patch: `INTAKE_GUARDS_BUILD_SET.diff`. Deployment-config diff: compose (+30/-6) and `staging.env.example` (+10).
Candidate manifest `docs/implementation/staging/source-manifest.20261022.sha256` (195 files, hash `1495a3ba42dfb6e83831ca6d1478dcace12f28ebe49b9c7d9b6c867c08737559`) was re-verified against the blobs of `1ccfc35`: no mismatch.

## Left out on purpose
`.vscode/` (editor setting) and `TWINS_Planning_Pack/` (92 KB, unrelated planning material) remain untracked and uncommitted; `data/options-snapshots/` (39 MB, derived from a provider file) stays git-ignored. The known test-only database password in `.github/workflows/ci.yml` and `infrastructure/docker/docker-compose.test.yml` was committed (needed by CI and local tests; the F4 item stays open - it is a test credential for a loopback-only container, not a staging secret). A pattern scan of every committed file found no real secret, key or token; only deliberate test canaries.

## Recovery
`git switch main` restores the original (stale) state; `git switch safety/worktree-20261022` restores the exact pre-reorganisation tree. Neither branch is backed up anywhere else. Create an off-machine copy (private remote or an encrypted `git bundle` on the Mac's backup) as soon as you approve one.
