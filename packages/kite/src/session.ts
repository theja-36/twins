import { createHash } from "node:crypto";

export const LOGIN_BASE = "https://kite.zerodha.com/connect/login";

/** The official browser login URL. A human completes it (password + TOTP); this package never sees or automates those. */
export const loginUrl = (apiKey: string): string => `${LOGIN_BASE}?v=3&api_key=${encodeURIComponent(apiKey)}`;

/** Documented checksum: SHA-256 of api_key + request_token + api_secret (hex). */
export const computeChecksum = (apiKey: string, requestToken: string, apiSecret: string): string =>
  createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");

export type SessionState =
  | { status: "none" }
  | { status: "unverified"; since: string } // a token is held; NO server has confirmed it yet
  | { status: "verified"; at: string } // the server accepted it at `at`; any later rejection flips this to invalid
  | { status: "invalid"; at: string; reason: "server_rejected" | "replaced" };

/**
 * Holds the access token in memory. State changes only on server evidence: a token's format or its estimated expiry never makes it "verified".
 * Once the server rejects a token it is dropped, and nothing is sent until a new exchange (or setToken) provides another.
 */
export class Session {
  private token: string | undefined;
  private current: SessionState = { status: "none" };
  constructor(private readonly now: () => Date = () => new Date()) {}

  state(): SessionState { return this.current; }
  /** Only a held, not-rejected token is returned. */
  usableToken(): string | undefined { return this.current.status === "unverified" || this.current.status === "verified" ? this.token : undefined; }
  secrets(): string[] { return this.token ? [this.token] : []; }

  setToken(token: string): void {
    this.token = token;
    this.current = { status: "unverified", since: this.now().toISOString() };
  }
  markVerified(): void { if (this.token && this.current.status !== "invalid") this.current = { status: "verified", at: this.now().toISOString() }; }
  markInvalid(): void {
    this.token = undefined;
    this.current = { status: "invalid", at: this.now().toISOString(), reason: "server_rejected" };
  }
}

/** ADVISORY ONLY: Kite tokens lapse around 06:00 IST the next day. Use for operator hints; never to decide that a token works (or does not). */
export function advisoryExpiry(issuedAt: Date): Date {
  const ist = new Date(issuedAt.getTime() + 5.5 * 3600_000);
  const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0));
  if (next.getTime() <= ist.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return new Date(next.getTime() - 5.5 * 3600_000);
}
