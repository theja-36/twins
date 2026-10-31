import { KiteError } from "./errors";

/** The ONLY read endpoints this package may call. Matching is on the path alone (no query, no fragment, no encoding). */
const READ_GET: readonly RegExp[] = [
  /^\/instruments$/,
  /^\/instruments\/(NSE|BSE|NFO|BFO)$/,
  /^\/instruments\/historical\/[0-9]{1,12}\/(minute|3minute|5minute|10minute|15minute|30minute|60minute|day)$/, // path allowed; the historical client is a later task
  /^\/quote$/,
  /^\/quote\/ltp$/,
  /^\/quote\/ohlc$/,
  /^\/user\/profile$/, // used only to ask the server whether the session is valid
];
const AUTH_POST = "/session/token";

export type RequestKind = "read" | "auth";

/**
 * Throws unless (method, path) is a read-only market-data GET or THE authentication exchange (POST /session/token).
 * The authentication exchange is not a precedent: anything else (orders, GTT, portfolio, positions, holdings, margins, mutual funds, logout) is refused.
 */
export function classify(method: string, path: string): RequestKind {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//")) throw new KiteError("NOT_ALLOWED");
  if (method === "GET" && READ_GET.some((r) => r.test(path))) return "read";
  if (method === "POST" && path === AUTH_POST) return "auth";
  throw new KiteError("NOT_ALLOWED");
}

export type RateClass = "quote" | "historical" | "default";
export const rateClassOf = (path: string): RateClass => (path.startsWith("/quote") ? "quote" : path.startsWith("/instruments/historical/") ? "historical" : "default");
