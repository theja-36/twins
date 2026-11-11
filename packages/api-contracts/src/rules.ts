/**
 * Request rules, MIRRORED from apps/api/src/userApi.ts (`key`, `reason`, `limit`, `uuid`, `query`, `body`, `SPOOF`). They exist so the interface can validate BEFORE sending; the backend still validates everything.
 * Parity: tests/unit/api-contracts/requestRules.test.ts drives the real routes with valid and invalid input.
 */
/** `idempotencyKey` is a REQUEST-BODY field (not a header): 8-128 characters of letters, digits and _ . : - */
export const IDEMPOTENCY_KEY = { field: "idempotencyKey", pattern: /^[A-Za-z0-9_.:-]{8,128}$/, min: 8, max: 128 } as const;
/** `reason`: trimmed, at most 300 characters. Optional on approve, reject, watch and unwatch (when present: at least 1). REQUIRED on cancel with at least 5. */
export const REASON = { field: "reason", max: 300, minWhenPresent: 1, cancelMin: 5 } as const;
export const LIST_LIMIT = { min: 1, max: 200, default: 50 } as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identity comes from the session: a request carrying any of these keys (query or body) is REFUSED with 422, never ignored. */
export const REFUSED_IDENTITY_FIELDS = ["userId", "user_id", "ownerId", "owner_id", "owner", "accountOwner", "approverUserId", "approver_user_id", "actorId", "actor_id"] as const;
export const EMAIL_MAX = 254;
