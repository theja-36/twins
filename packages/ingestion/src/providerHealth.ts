import { schema } from "@twins/database";
import type { Db } from "./db";
import type { ProviderDomain } from "@twins/types";

/**
 * Provider health is operational information only, never a trading-
 * confidence signal (spec section 44). Each check is appended as its own
 * row so the table is a time series a future observability phase can
 * query (last success, last failure, latency trend) rather than a single
 * mutable "current status" cell.
 */
export async function recordProviderSuccess(
  db: Db,
  params: { providerName: string; providerType: ProviderDomain; latencyMs?: number },
): Promise<void> {
  const now = new Date();
  await db.insert(schema.providerHealth).values({
    providerName: params.providerName,
    providerType: params.providerType,
    status: "healthy",
    latencyMs: params.latencyMs?.toString(),
    lastSuccessAt: now,
    checkedAt: now,
  });
}

export async function recordProviderFailure(
  db: Db,
  params: {
    providerName: string;
    providerType: ProviderDomain;
    errorMessage: string;
    status?: "degraded" | "down";
  },
): Promise<void> {
  const now = new Date();
  await db.insert(schema.providerHealth).values({
    providerName: params.providerName,
    providerType: params.providerType,
    status: params.status ?? "down",
    lastErrorAt: now,
    lastErrorMessage: params.errorMessage,
    checkedAt: now,
  });
}
