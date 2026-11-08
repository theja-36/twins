import { createHash, randomBytes } from "node:crypto";
/** Session tokens are opaque 256-bit random values with a recognisable prefix (so they are never confused with the shared service API key). Only a SHA-256 of the token is stored. */
export const SESSION_TOKEN_PREFIX = "tws_";
export const newSessionToken = (): string => SESSION_TOKEN_PREFIX + randomBytes(32).toString("base64url");
export const hashSessionToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const looksLikeSessionToken = (t: string): boolean => /^tws_[A-Za-z0-9_-]{43}$/.test(t);
/** A non-reversible key for per-email rate limiting, so the failures table never holds an address. */
export const failureKey = (email: string): string => createHash("sha256").update("login-failure:" + email.trim().toLowerCase()).digest("hex");
