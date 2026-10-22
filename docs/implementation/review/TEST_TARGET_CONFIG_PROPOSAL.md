# Proposal: explicit test-target configuration (no fallback to an incompatible database)

Status: PROPOSAL only. No code changed; `twins_dev` is not touched, migrated, deleted or retired; `twins_ci` is not repurposed (it stays the CI-style test target).

## Problem (observed)
- **21 test files mention `twins_dev`; 20 of them hardcode** `process.env.DATABASE_URL ?? "postgresql://twins:...@localhost:15432/twins_dev"` (19 integration files, `harness.ts`, plus the negative checks in `ciGuard.test.ts`), so running `npm run test:integration` without exporting a URL silently targets `twins_dev`. `twins_dev` is **not migrated to 0004**, so that default run fails with missing-column errors (27 observed earlier), and a developer could also point tests at a database that holds development data.
- `vitest.config.ts` (unit) sets a dummy `twins_dev` URL; harmless (unit tests never connect) but it normalises the name.
- Nothing checks that the target is at the schema version the code expects before the tests run.
- Existing guards (`envGuard`, `ciGuard`) are opt-in (`TWINS_REHEARSAL`/`TWINS_CI`) and unchanged by this proposal.

## Proposed design (small, test-only; development and test stay separate)
1. **`tests/support/testTarget.ts` (new):** `testDatabaseUrl()` returns `TWINS_TEST_DATABASE_URL`, else `DATABASE_URL`, and **throws with an actionable message if neither is set** (no default). It also requires: loopback host; database name matching `^(twins_ci|twins_test|twins_rehearsal_[a-z0-9_]+)$`; and explicitly refuses `twins_dev` and any name not on the allowlist. `testRedisUrl()` likewise requires an explicit loopback URL.
2. **`tests/support/migrationGuard.ts` as vitest `globalSetup`** (in `vitest.integration.config.ts` only): once per run, opens a read-only connection, compares `drizzle.__drizzle_migrations` row count with `packages/database/drizzle/meta/_journal.json`, and fails fast with: "test database is at migration N of M - apply with `DATABASE_URL=<target> npm run db:migrate -w @twins/database`". This turns the 27 confusing column errors into one clear message.
3. **Mechanical replacement** of the 20 inline fallbacks by `testDatabaseUrl()`; `harness.ts` and the guards import the same helper.
4. **Development database:** remains `twins_dev` for manual development (documented in the README/`.env.example`: `DATABASE_URL` for `npm run dev`, never for tests). Whether `twins_dev` is later migrated (remediating its 12 + 1 synthetic duplicates), recreated or retired is a separate owner decision and is NOT assumed by this change.
5. **CI:** unchanged (`twins_ci` is on the allowlist; `TWINS_CI` guard still applies). Rehearsal databases (`twins_rehearsal_*`) are allowed, as the F2 rehearsal needs.

## Why this and not the alternatives
- Pointing the defaults at `twins_ci` would repurpose the CI target as a default and still hide mistakes; a required explicit value plus an allowlist fails loudly.
- A single central helper replaces 20 copies of the same literal, so the next rename is a one-line change.

## Tests and risks
Unit tests for the helper (missing env -> throws; `twins_dev` -> throws; non-loopback -> throws; `twins_ci` and `twins_rehearsal_x` -> ok) and a test that the migration guard reports a behind-by-one database (using a fake count). Risk: anyone relying on the old implicit default must now export a URL (documented, one clear error). Needs approval before implementation; touches about 21 test files only (no product code, no database).
