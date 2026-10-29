import type { MarketRiskConfig } from "./config";
import { localParts, localToInstant, sessionKeyOf } from "./sessions";

/**
 * Contract-expiry rules for options and futures (pure). A contract expires at the CLOSE of its market's session on the expiry date. Equity has no expiry.
 * An expiry that is missing, malformed or not a real calendar date for an option / future is INVALID (never guessed).
 */
export type ExpiryStatus = "NOT_APPLICABLE" | "INVALID" | "EXPIRED" | "TOO_SOON" | "OK";
export interface ExpiryAssessment {
  status: ExpiryStatus;
  expiry: string | null;
  expiryInstant: string | null;
  minutesToExpiry: number | null;
  minimumMinutes: number | null;
  /** The local date of `at` equals the expiry date (stricter liquidity / spread rules apply). */
  expiryDay: boolean;
}

export function assessExpiry(args: { kind: string; expiry: string | null | undefined; at: Date; market: string | null | undefined }, config: Pick<MarketRiskConfig, "sessions" | "minMinutesToExpiry">): ExpiryAssessment {
  const none = { expiry: null, expiryInstant: null, minutesToExpiry: null, minimumMinutes: null, expiryDay: false };
  if (args.kind !== "option" && args.kind !== "future") return { status: "NOT_APPLICABLE", ...none };
  const minimum = config.minMinutesToExpiry[args.kind];
  const e = args.expiry ?? null;
  const m = e ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(e) : null;
  const valid = m ? (() => { const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]); })() : false;
  const key = sessionKeyOf(args.market);
  const def = key ? config.sessions[key] : undefined;
  if (!e || !valid || !def) return { status: "INVALID", ...none, expiry: e, minimumMinutes: minimum };
  const instant = localToInstant(e, def.close, def.timezone);
  const minutes = (instant.getTime() - args.at.getTime()) / 60_000;
  const expiryDay = localParts(args.at, def.timezone).date === e;
  const base = { expiry: e, expiryInstant: instant.toISOString(), minutesToExpiry: Math.round(minutes * 1000) / 1000, minimumMinutes: minimum, expiryDay };
  if (minutes <= 0) return { status: "EXPIRED", ...base };
  if (minutes < minimum) return { status: "TOO_SOON", ...base };
  return { status: "OK", ...base };
}
