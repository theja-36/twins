/**
 * Error contracts, MIRRORED from the backend: `packages/types/src/platform/errors.ts` (platform taxonomy and HTTP map) and `APPROVAL_HTTP` / `approvalError` in `apps/api/src/userApi.ts` (approval actions).
 * Parity: tests/unit/api-contracts/errorsParity.test.ts drives the real routes and compares status, `error`, `state` and `reasons`.
 */
export const PLATFORM_ERROR_CODES = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION", "CONFLICT", "STALE_DATA", "DEPENDENCY_UNAVAILABLE", "RISK_BLOCKED", "EXECUTION_DISABLED", "INTERNAL"] as const;
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];
export const PLATFORM_ERROR_HTTP: Readonly<Record<PlatformErrorCode, number>> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 422, CONFLICT: 409, STALE_DATA: 409, DEPENDENCY_UNAVAILABLE: 503, RISK_BLOCKED: 422, EXECUTION_DISABLED: 403, INTERNAL: 500 };
/** The body of every platform error: fixed messages, no secret, token or private value. */
export interface ErrorBody { error: PlatformErrorCode; message: string; reasons: string[] }

export const APPROVAL_ERROR_CODES = ["NOT_FOUND", "NOT_PENDING", "NOT_QUALIFIED", "EXPIRED", "REVALIDATION_FAILED", "ALREADY_ACTIONED", "NOT_PERMITTED"] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];
export type ApprovalErrorState = "NOT_FOUND" | "NOT_PENDING" | "NOT_QUALIFIED" | "EXPIRED" | "INVALIDATED" | "ALREADY_ACTIONED" | "NOT_PERMITTED";
export const APPROVAL_ERROR_HTTP: Readonly<Record<ApprovalErrorCode, { status: number; state: ApprovalErrorState }>> = {
  NOT_FOUND: { status: 404, state: "NOT_FOUND" },
  NOT_PENDING: { status: 409, state: "NOT_PENDING" },
  NOT_QUALIFIED: { status: 422, state: "NOT_QUALIFIED" },
  EXPIRED: { status: 409, state: "EXPIRED" },
  REVALIDATION_FAILED: { status: 409, state: "INVALIDATED" },
  ALREADY_ACTIONED: { status: 409, state: "ALREADY_ACTIONED" },
  NOT_PERMITTED: { status: 403, state: "NOT_PERMITTED" },
};
/** Approval actions (approve / reject) answer with this body: `reasons` are the NAMES of the failed re-validation checks. */
export interface ApprovalErrorBody { error: ApprovalErrorCode; state: ApprovalErrorState; message: string; reasons: string[] }
export const isApprovalErrorBody = (b: unknown): b is ApprovalErrorBody => typeof b === "object" && b !== null && "state" in b && "error" in b && (APPROVAL_ERROR_CODES as readonly string[]).includes(String((b as { error: unknown }).error));
