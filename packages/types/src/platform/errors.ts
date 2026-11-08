/** One error taxonomy for every service and route. Messages are fixed text: no secret, token or private value is ever placed in an error. */
export const PLATFORM_ERROR_CODES = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION", "CONFLICT", "STALE_DATA", "DEPENDENCY_UNAVAILABLE", "RISK_BLOCKED", "EXECUTION_DISABLED", "INTERNAL"] as const;
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];
const HTTP: Record<PlatformErrorCode, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 422, CONFLICT: 409, STALE_DATA: 409, DEPENDENCY_UNAVAILABLE: 503, RISK_BLOCKED: 422, EXECUTION_DISABLED: 403, INTERNAL: 500 };

export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode, message: string, readonly reasons: readonly string[] = []) { super(message); this.name = "PlatformError"; }
  get httpStatus(): number { return HTTP[this.code]; }
}
export interface ErrorBody { error: PlatformErrorCode; message: string; reasons: string[] }
/** Safe response body. A foreign resource is reported as NOT_FOUND, never FORBIDDEN, so existence is not leaked across users. */
export function toErrorBody(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof PlatformError) return { status: e.httpStatus, body: { error: e.code, message: e.message, reasons: [...e.reasons] } };
  return { status: 500, body: { error: "INTERNAL", message: "internal error", reasons: [] } };
}
