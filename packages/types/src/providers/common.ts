/**
 * Shared vocabulary for every provider contract (spec section 43-45).
 * Kept dependency-free (no import from @twins/database) so this package
 * stays the lowest layer: adapters and core packages both depend on it,
 * it depends on nothing internal.
 */

export type ProviderDomain =
  | "market"
  | "news"
  | "macro"
  | "telegram"
  | "broker"
  | "ai";

export type ProviderHealthStatus = "healthy" | "degraded" | "down";

/**
 * Operational status only - never a trading-confidence signal (spec
 * section 44). Shaped to map directly onto the `provider_health` table
 * once ingestion (Phase 4+) starts persisting these.
 */
export interface ProviderHealthSnapshot {
  providerName: string;
  providerType: ProviderDomain;
  status: ProviderHealthStatus;
  latencyMs?: number;
  errorRate?: number;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
  checkedAt: Date;
}

/** Minimal instrument identity - enough to resolve against `instruments` (Phase 2). */
export interface InstrumentRef {
  symbol: string;
  exchange: string;
}

/** Base class for every provider-adapter failure so callers can branch without knowing the vendor. */
export class ProviderError extends Error {
  constructor(
    public readonly providerName: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${providerName}] ${message}`);
    this.name = "ProviderError";
  }
}

/** Provider is unreachable/erroring - callers must treat this as missing data, not zero/default data (spec section 2/45). */
export class ProviderUnavailableError extends ProviderError {
  constructor(providerName: string, message = "provider unavailable", cause?: unknown) {
    super(providerName, message, cause);
    this.name = "ProviderUnavailableError";
  }
}

/** Provider responded but rejected the request due to rate limiting. */
export class ProviderRateLimitError extends ProviderError {
  constructor(providerName: string, public readonly retryAfterMs?: number) {
    super(providerName, "rate limited");
    this.name = "ProviderRateLimitError";
  }
}

/** Provider returned data that failed structural validation - never silently coerced (spec section 21/45). */
export class ProviderDataError extends ProviderError {
  constructor(providerName: string, message: string, cause?: unknown) {
    super(providerName, message, cause);
    this.name = "ProviderDataError";
  }
}
