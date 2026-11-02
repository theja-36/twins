export type KiteErrorCode =
  | "CONFIG"
  | "NOT_ALLOWED" // the request is not on the read-only allowlist (or is not the single authentication exception)
  | "NO_SESSION" // no access token is held
  | "SESSION_INVALID" // the server rejected the token; nothing is sent until a new exchange
  | "AUTH_FAILED" // request_token exchange refused or malformed
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "SERVER_ERROR"
  | "NETWORK"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "INSTRUMENTS_INVALID" // the instruments dump is unusable as a whole
  | "UNSUPPORTED_UNDERLYING"
  | "UNSUPPORTED_CONTRACT"
  | "PLAN_RESTRICTED" // the configured Kite plan does not include this capability (checked locally, before anything is sent)
  | "INVALID_REQUEST"; // a request parameter is outside what this package will send (range, interval, expired contract, ...)

const FIXED: Record<KiteErrorCode, string> = {
  CONFIG: "invalid Kite configuration",
  NOT_ALLOWED: "request refused: not on the read-only allowlist",
  NO_SESSION: "no Kite session: complete the browser login and exchange the request_token",
  SESSION_INVALID: "the Kite session was rejected by the server: log in again",
  AUTH_FAILED: "Kite token exchange failed",
  RATE_LIMITED: "Kite rate limit",
  BAD_REQUEST: "Kite rejected the request",
  SERVER_ERROR: "Kite server error",
  NETWORK: "network error calling Kite",
  TIMEOUT: "Kite request timed out",
  MALFORMED_RESPONSE: "malformed Kite response",
  RESPONSE_TOO_LARGE: "Kite response too large",
  INSTRUMENTS_INVALID: "instruments dump is invalid",
  UNSUPPORTED_UNDERLYING: "underlying is outside the supported scope (NIFTY, BANKNIFTY, SENSEX)",
  UNSUPPORTED_CONTRACT: "contract is not listed in the instruments catalog",
  PLAN_RESTRICTED: "the configured Kite plan does not include this capability",
  INVALID_REQUEST: "request parameters refused before sending",
};

/** The message is a fixed string per code. Server text is kept (redacted, bounded) in `serverMessage` only; it is never interpolated into `message`. */
export class KiteError extends Error {
  constructor(readonly code: KiteErrorCode, readonly detail: { status?: number; errorType?: string; serverMessage?: string; retryAfterMs?: number } = {}) {
    super(FIXED[code]);
    this.name = "KiteError";
  }
  get status(): number | undefined { return this.detail.status; }
}
