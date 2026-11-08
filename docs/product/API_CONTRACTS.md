# API contracts

## Conventions (Stage 01, ADR-003/ADR-006)
- **Authentication:** every route except `/health` requires a principal. Today: the shared bearer key (the `system` principal used by the frontend proxy). Target: per-user sessions (opaque token, hash stored) for user routes.
- **Authorisation:** routes call `authorize(principal, permission, ownerId)` from `@twins/types`; private resources are scoped with `ownerScope(principal)`. A foreign private resource answers `404`, never `403`.
- **Errors:** the `PlatformError` taxonomy (`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `VALIDATION` 422, `CONFLICT`/`STALE_DATA` 409, `DEPENDENCY_UNAVAILABLE` 503, `RISK_BLOCKED` 422, `EXECUTION_DISABLED` 403, `INTERNAL` 500). Body: `{ error, message, reasons[] }`. No secret or private value appears in a body.
- **States for every read:** a response distinguishes ok, empty, stale, unavailable and unauthorised; a failed read is never presented as empty.
- **Writes** go through the decision/approval/execution gates; no route can place a live order (`checkExecutionGate`).
- **OpenAPI:** `docs/api/openapi.json` is regenerated from `apps/api/src/openapi.ts` whenever routes change.

## Existing routes (preserved)
See `docs/api/openapi.json` (30 documented routes plus the Telegram webhook and the internal capture ingest).

## Planned contract families (added per stage, each with schemas and tests)
Auth and users · user capital and risk policy · broker connections (per user) · channels (read, then managed) · signals and classifications · evidence · research packages · regimes · playbooks and strategy versions · opportunity candidates · confidence and risk assessments · simulations · decisions and approvals · orders, fills, positions · trade monitoring · analytics and learning versions · notifications · admin and audit.
