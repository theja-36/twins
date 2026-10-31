import { KiteError } from "./errors";

/** The ONLY read endpoints this package may call. Matching is on the path alone (no query, no fragment, no encoding). */
const READ_GET: readonly RegExp[] = [
  /^\/instruments$/,
  /^\/instruments\/(NSE|BSE|NFO|BFO)$/,
  /^\/instruments\/historical\/[0-9]{1,12}\/(minute|3minute|5minute|10minute|15minute|30minute|60minute|day)$/, // path allowed; the historical client is a later task
  /^\/quote$/,
  /^\/quote\/ltp$/,
  /^\/quote\/ohlc$/,
];
/** Account READS (GET only). Included deliberately and read-only: nothing here places, modifies or cancels anything; every write verb on these paths is refused. */
const ACCOUNT_GET: readonly RegExp[] = [
  /^\/user\/profile$/, // also how the server is asked whether a session is valid
  /^\/user\/margins$/,
  /^\/user\/margins\/(equity|commodity)$/,
  /^\/portfolio\/holdings$/,
  /^\/portfolio\/positions$/,
  /^\/orders$/, // the order BOOK (read)
  /^\/orders\/[0-9]{1,20}$/, // history of one order (read)
  /^\/orders\/[0-9]{1,20}\/trades$/,
  /^\/trades$/,
  /^\/gtt\/triggers$/, // the GTT list (read)
  /^\/gtt\/triggers\/[0-9]{1,12}$/,
];
const AUTH_POST = "/session/token";

/** read = market data (needs a plan that includes it); account = account reads (every plan); auth = the single token exchange. */
export type RequestKind = "read" | "account" | "auth";

/**
 * Throws unless (method, path) is a read-only market-data GET or THE authentication exchange (POST /session/token).
 * The authentication exchange is not a precedent. Account paths (profile, margins, holdings, positions, orders, trades, GTT) are allowed for GET ONLY; placing, modifying or
 * cancelling an order or a GTT, converting a position, authorising holdings, mutual funds and logout are refused for every method.
 */
export function classify(method: string, path: string): RequestKind {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//")) throw new KiteError("NOT_ALLOWED");
  if (method === "GET" && READ_GET.some((r) => r.test(path))) return "read";
  if (method === "GET" && ACCOUNT_GET.some((r) => r.test(path))) return "account";
  if (method === "POST" && path === AUTH_POST) return "auth";
  throw new KiteError("NOT_ALLOWED");
}

export type RateClass = "quote" | "historical" | "default";
export const rateClassOf = (path: string): RateClass => (path.startsWith("/quote") ? "quote" : path.startsWith("/instruments/historical/") ? "historical" : "default");
