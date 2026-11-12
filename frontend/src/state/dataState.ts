/**
 * The eight data states every region resolves to (docs/frontend/architecture.md §6), derived in ONE place so screens never invent their own.
 * Backend semantics (verified): a private route called without permission, or on someone else's resource, answers 404 (never 403), and an ADMIN gets 404 on every private route.
 */
import type { DataState } from "@twins/api-contracts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly reasons: string[] = []) { super(message); this.name = "ApiError"; }
}
export interface RegionInput {
  loading: boolean; error: unknown; hasData: boolean; empty: boolean;
  /** The server marked the data stale (e.g. analytics freshness STALE), or a refetch failed while cached data is shown. */
  stale?: boolean;
  /** Some sections loaded and others did not. */
  partial?: boolean;
  /** The backend capability does not exist or is disabled. */
  unavailable?: boolean;
  /** For a route that is private: 404 means "not available to you" rather than "missing". */
  privateRoute?: boolean;
}
export function deriveState(i: RegionInput): DataState {
  if (i.unavailable) return "UNAVAILABLE";
  if (i.error) {
    const e = i.error as Partial<ApiError>;
    if (e.status === 401 || e.status === 403) return "DENIED";
    if (e.status === 404 && i.privateRoute) return "DENIED";
    if (e.status === 503 || e.code === "DEPENDENCY_UNAVAILABLE" || e.code === "EXECUTION_DISABLED") return i.hasData ? "STALE" : "UNAVAILABLE";
    return i.hasData ? "STALE" : "ERROR";
  }
  if (i.loading && !i.hasData) return "LOADING";
  if (i.partial) return "PARTIAL";
  if (i.stale) return "STALE";
  if (!i.hasData || i.empty) return "EMPTY";
  return "READY";
}
